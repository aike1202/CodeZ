use std::{
    collections::VecDeque,
    error::Error,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, SyncSender, TryRecvError},
    },
    thread::{self, JoinHandle},
    time::Duration,
};

use serde::{Deserialize, Serialize};
use tauri::ipc::{Channel, InvokeResponseBody};

type TestResult<T = ()> = Result<T, Box<dyn Error + Send + Sync>>;

const CHUNK_BYTES: usize = 128;
const CHUNK_COUNT: usize = 20_000;
const UPSTREAM_CAPACITY: usize = 16;
const FRAME_PAYLOAD_BYTES: usize = 4 * 1024;
const MAX_IN_FLIGHT: usize = 4;
const MAX_DIRECT_JSON_BYTES: usize = 8 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum FrameKind {
    Delta,
    Completed,
    Interrupted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProbeFrame {
    stream_id: String,
    sequence: u64,
    kind: FrameKind,
    payload: String,
}

#[derive(Debug)]
struct FrontendOutcome {
    received_chunks: usize,
    received_frames: usize,
    terminal_frames: usize,
}

#[derive(Debug)]
struct StreamOutcome {
    producer_chunks: usize,
    frontend: FrontendOutcome,
    backend_terminal: FrameKind,
    max_in_flight: usize,
    oversized_frame: bool,
}

struct AckWindow {
    pending: VecDeque<u64>,
    max_observed: usize,
}

impl AckWindow {
    fn new() -> Self {
        Self {
            pending: VecDeque::with_capacity(MAX_IN_FLIGHT),
            max_observed: 0,
        }
    }

    fn record(&mut self, sequence: u64) {
        self.pending.push_back(sequence);
        self.max_observed = self.max_observed.max(self.pending.len());
    }

    fn acknowledge(&mut self, sequence: u64) {
        while self
            .pending
            .front()
            .is_some_and(|pending| *pending <= sequence)
        {
            self.pending.pop_front();
        }
    }

    fn wait_for_capacity(
        &mut self,
        acknowledgements: &Receiver<u64>,
        cancellation: &Receiver<()>,
    ) -> TestResult<bool> {
        while self.pending.len() >= MAX_IN_FLIGHT {
            if cancellation.try_recv().is_ok() {
                return Ok(false);
            }
            match acknowledgements.recv_timeout(Duration::from_millis(10)) {
                Ok(sequence) => self.acknowledge(sequence),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    if cancellation.try_recv().is_ok() {
                        return Ok(false);
                    }
                    return Err("frontend acknowledgement channel closed".into());
                }
            }
        }
        Ok(!matches!(cancellation.try_recv(), Ok(())))
    }

    fn wait_until_empty(
        &mut self,
        acknowledgements: &Receiver<u64>,
        cancellation: &Receiver<()>,
    ) -> TestResult<bool> {
        while !self.pending.is_empty() {
            if cancellation.try_recv().is_ok() {
                return Ok(false);
            }
            match acknowledgements.recv_timeout(Duration::from_millis(10)) {
                Ok(sequence) => self.acknowledge(sequence),
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => {
                    if cancellation.try_recv().is_ok() {
                        return Ok(false);
                    }
                    return Err("frontend acknowledgement channel closed".into());
                }
            }
        }
        Ok(true)
    }
}

fn chunk(index: usize) -> String {
    let prefix = format!("{index:08}:");
    let mut value = String::with_capacity(CHUNK_BYTES);
    value.push_str(&prefix);
    value.extend(std::iter::repeat_n('x', CHUNK_BYTES - prefix.len()));
    value
}

fn spawn_producer(sender: SyncSender<String>) -> JoinHandle<usize> {
    thread::spawn(move || {
        for index in 0..CHUNK_COUNT {
            if sender.send(chunk(index)).is_err() {
                return index;
            }
        }
        CHUNK_COUNT
    })
}

fn consume_payload(payload: &str, expected_chunk: &mut usize) -> TestResult {
    if payload.len() % CHUNK_BYTES != 0 {
        return Err("delta payload split a fixed-size chunk".into());
    }
    for record in payload.as_bytes().chunks_exact(CHUNK_BYTES) {
        let index = std::str::from_utf8(&record[..8])?.parse::<usize>()?;
        if index != *expected_chunk {
            return Err(format!(
                "out-of-order chunk: expected {}, received {index}",
                *expected_chunk
            )
            .into());
        }
        *expected_chunk += 1;
    }
    Ok(())
}

fn spawn_frontend(
    receiver: Receiver<ProbeFrame>,
    acknowledgements: mpsc::Sender<u64>,
    cancellation: mpsc::Sender<()>,
    unmount_after_frames: Option<usize>,
) -> JoinHandle<TestResult<FrontendOutcome>> {
    thread::spawn(move || {
        let mut expected_sequence = 0_u64;
        let mut received_chunks = 0;
        let mut received_frames = 0;
        let mut terminal_frames = 0;

        while let Ok(frame) = receiver.recv() {
            if frame.stream_id != "stream-probe" || frame.sequence != expected_sequence {
                return Err(format!(
                    "unexpected stream/sequence: {} at {} (expected {expected_sequence})",
                    frame.stream_id, frame.sequence
                )
                .into());
            }
            expected_sequence += 1;
            received_frames += 1;

            match frame.kind {
                FrameKind::Delta => {
                    consume_payload(&frame.payload, &mut received_chunks)?;
                    thread::sleep(Duration::from_millis(1));
                }
                FrameKind::Completed | FrameKind::Interrupted => {
                    terminal_frames += 1;
                }
            }

            if unmount_after_frames.is_some_and(|limit| received_frames >= limit) {
                let _ = cancellation.send(());
                return Ok(FrontendOutcome {
                    received_chunks,
                    received_frames,
                    terminal_frames,
                });
            }

            acknowledgements
                .send(frame.sequence)
                .map_err(|_| "backend acknowledgement receiver closed")?;
            if frame.kind != FrameKind::Delta {
                return Ok(FrontendOutcome {
                    received_chunks,
                    received_frames,
                    terminal_frames,
                });
            }
        }

        Ok(FrontendOutcome {
            received_chunks,
            received_frames,
            terminal_frames,
        })
    })
}

fn probe_channel(sender: SyncSender<ProbeFrame>) -> (Channel<ProbeFrame>, Arc<AtomicBool>) {
    let oversized_frame = Arc::new(AtomicBool::new(false));
    let oversized_sink = Arc::clone(&oversized_frame);
    let channel = Channel::new(move |body| {
        let InvokeResponseBody::Json(json) = body else {
            return Ok(());
        };
        if json.len() >= MAX_DIRECT_JSON_BYTES {
            oversized_sink.store(true, Ordering::Relaxed);
        }
        if let Ok(frame) = serde_json::from_str(&json) {
            let _ = sender.send(frame);
        }
        Ok(())
    });
    (channel, oversized_frame)
}

fn send_frame(
    channel: &Channel<ProbeFrame>,
    window: &mut AckWindow,
    sequence: &mut u64,
    kind: FrameKind,
    payload: String,
) -> TestResult {
    channel.send(ProbeFrame {
        stream_id: "stream-probe".to_owned(),
        sequence: *sequence,
        kind,
        payload,
    })?;
    window.record(*sequence);
    *sequence = sequence.checked_add(1).ok_or("stream sequence overflow")?;
    Ok(())
}

fn flush_delta(
    channel: &Channel<ProbeFrame>,
    window: &mut AckWindow,
    acknowledgements: &Receiver<u64>,
    cancellation: &Receiver<()>,
    sequence: &mut u64,
    batch: &mut String,
) -> TestResult<bool> {
    if batch.is_empty() {
        return Ok(true);
    }
    if !window.wait_for_capacity(acknowledgements, cancellation)? {
        return Ok(false);
    }
    send_frame(
        channel,
        window,
        sequence,
        FrameKind::Delta,
        std::mem::take(batch),
    )?;
    Ok(true)
}

fn run_stream(unmount_after_frames: Option<usize>) -> TestResult<StreamOutcome> {
    let (upstream_tx, upstream_rx) = mpsc::sync_channel(UPSTREAM_CAPACITY);
    let producer = spawn_producer(upstream_tx);
    let (frontend_tx, frontend_rx) = mpsc::sync_channel(MAX_IN_FLIGHT);
    let (channel, oversized_frame) = probe_channel(frontend_tx);
    let (ack_tx, ack_rx) = mpsc::channel();
    let (cancel_tx, cancel_rx) = mpsc::channel();
    let frontend = spawn_frontend(frontend_rx, ack_tx, cancel_tx, unmount_after_frames);

    let mut window = AckWindow::new();
    let mut sequence = 0_u64;
    let mut batch = String::with_capacity(FRAME_PAYLOAD_BYTES);
    let mut cancelled = false;

    loop {
        match cancel_rx.try_recv() {
            Ok(()) => {
                cancelled = true;
                break;
            }
            Err(TryRecvError::Empty | TryRecvError::Disconnected) => {}
        }
        match upstream_rx.recv_timeout(Duration::from_millis(10)) {
            Ok(value) => {
                if batch.len() + value.len() > FRAME_PAYLOAD_BYTES
                    && !flush_delta(
                        &channel,
                        &mut window,
                        &ack_rx,
                        &cancel_rx,
                        &mut sequence,
                        &mut batch,
                    )?
                {
                    cancelled = true;
                    break;
                }
                batch.push_str(&value);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }

    if !cancelled
        && !flush_delta(
            &channel,
            &mut window,
            &ack_rx,
            &cancel_rx,
            &mut sequence,
            &mut batch,
        )?
    {
        cancelled = true;
    }
    if !cancelled && window.wait_for_capacity(&ack_rx, &cancel_rx)? {
        send_frame(
            &channel,
            &mut window,
            &mut sequence,
            FrameKind::Completed,
            String::new(),
        )?;
        if !window.wait_until_empty(&ack_rx, &cancel_rx)? {
            cancelled = true;
        }
    }

    drop(upstream_rx);
    drop(channel);
    let producer_chunks = producer.join().map_err(|_| "producer thread panicked")?;
    let frontend = frontend.join().map_err(|_| "frontend thread panicked")??;

    Ok(StreamOutcome {
        producer_chunks,
        frontend,
        backend_terminal: if cancelled {
            FrameKind::Interrupted
        } else {
            FrameKind::Completed
        },
        max_in_flight: window.max_observed,
        oversized_frame: oversized_frame.load(Ordering::Relaxed),
    })
}

#[test]
fn bounded_ack_stream_should_preserve_order_under_slow_consumption() -> TestResult {
    let outcome = run_stream(None)?;
    let memory_upper_bound = UPSTREAM_CAPACITY * CHUNK_BYTES
        + FRAME_PAYLOAD_BYTES
        + MAX_IN_FLIGHT * MAX_DIRECT_JSON_BYTES;

    assert_eq!(
        (
            outcome.producer_chunks,
            outcome.frontend.received_chunks,
            outcome.frontend.terminal_frames,
            outcome.backend_terminal,
            outcome.max_in_flight <= MAX_IN_FLIGHT,
            outcome.oversized_frame,
            memory_upper_bound < 64 * 1024,
        ),
        (
            CHUNK_COUNT,
            CHUNK_COUNT,
            1,
            FrameKind::Completed,
            true,
            false,
            true,
        )
    );
    Ok(())
}

#[test]
fn unmounted_frontend_should_cancel_and_release_the_blocked_producer() -> TestResult {
    let outcome = run_stream(Some(3))?;

    assert!(
        outcome.producer_chunks < CHUNK_COUNT
            && outcome.frontend.received_frames == 3
            && outcome.frontend.terminal_frames == 0
            && outcome.backend_terminal == FrameKind::Interrupted
            && outcome.max_in_flight <= MAX_IN_FLIGHT,
        "unmount did not bound and interrupt the stream: {outcome:?}"
    );
    Ok(())
}
