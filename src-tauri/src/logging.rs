use std::{env, path::Path};

use thiserror::Error;
use tracing::level_filters::LevelFilter;
use tracing_appender::{
    non_blocking::{ErrorCounter, NonBlockingBuilder, WorkerGuard},
    rolling::{InitError, RollingFileAppender, Rotation},
};
use tracing_subscriber::{
    EnvFilter, Layer,
    filter::{FilterExt, filter_fn},
    layer::SubscriberExt,
    registry::Registry,
    util::SubscriberInitExt,
};

const LOG_FILTER_ENV: &str = "CODEZ_LOG";
const DEFAULT_LOG_FILTER: &str = "info";
const LOG_FILE_PREFIX: &str = "codez";
const LOG_FILE_SUFFIX: &str = "jsonl";
const MAX_LOG_FILES: usize = 8;
const BUFFERED_LOG_LINES: usize = 8_192;

/// Keeps the asynchronous file writer alive until desktop state is dropped.
#[derive(Debug)]
pub(crate) struct LoggingGuard {
    _worker: WorkerGuard,
    dropped_lines: ErrorCounter,
}

impl Drop for LoggingGuard {
    fn drop(&mut self) {
        let dropped_lines = self.dropped_lines.dropped_lines();
        if dropped_lines > 0 {
            tracing::warn!(
                dropped_lines,
                "structured log events were dropped after the queue reached capacity"
            );
        }
    }
}

#[derive(Debug, Error)]
pub(crate) enum LoggingError {
    #[error("failed to initialize the rolling log appender: {0}")]
    Appender(#[from] InitError),
    #[error("the global tracing subscriber was already initialized")]
    SubscriberAlreadyInitialized,
}

struct FilterConfig {
    filter: EnvFilter,
    used_fallback: bool,
}

pub(crate) fn initialize(log_directory: &Path) -> Result<LoggingGuard, LoggingError> {
    let appender = rolling_appender(log_directory)?;
    let (writer, worker) = NonBlockingBuilder::default()
        .buffered_lines_limit(BUFFERED_LOG_LINES)
        .thread_name("codez-log-writer")
        .finish(appender);
    let dropped_lines = writer.error_counter();
    let filter = configured_filter();
    subscriber(writer, filter.filter)
        .try_init()
        .map_err(|_| LoggingError::SubscriberAlreadyInitialized)?;

    if filter.used_fallback {
        tracing::warn!(
            configuration = LOG_FILTER_ENV,
            fallback = DEFAULT_LOG_FILTER,
            "invalid log filter; using the default"
        );
    }
    tracing::info!(
        rotation = "daily-utc",
        max_log_files = MAX_LOG_FILES,
        "structured file logging initialized"
    );

    Ok(LoggingGuard {
        _worker: worker,
        dropped_lines,
    })
}

fn rolling_appender(log_directory: &Path) -> Result<RollingFileAppender, InitError> {
    RollingFileAppender::builder()
        .rotation(Rotation::DAILY)
        .filename_prefix(LOG_FILE_PREFIX)
        .filename_suffix(LOG_FILE_SUFFIX)
        .max_log_files(MAX_LOG_FILES)
        .build(log_directory)
}

fn configured_filter() -> FilterConfig {
    match env::var(LOG_FILTER_ENV) {
        Ok(value) => filter_from(Some(&value)),
        Err(env::VarError::NotPresent) => filter_from(None),
        Err(env::VarError::NotUnicode(_)) => FilterConfig {
            filter: EnvFilter::new(DEFAULT_LOG_FILTER),
            used_fallback: true,
        },
    }
}

fn filter_from(value: Option<&str>) -> FilterConfig {
    match value.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => match EnvFilter::builder().with_regex(false).parse(value) {
            Ok(filter) => FilterConfig {
                filter,
                used_fallback: false,
            },
            Err(_) => FilterConfig {
                filter: EnvFilter::new(DEFAULT_LOG_FILTER),
                used_fallback: true,
            },
        },
        None => FilterConfig {
            filter: EnvFilter::new(DEFAULT_LOG_FILTER),
            used_fallback: false,
        },
    }
}

fn subscriber<W>(writer: W, filter: EnvFilter) -> impl tracing::Subscriber + Send + Sync + 'static
where
    W: for<'writer> tracing_subscriber::fmt::MakeWriter<'writer> + Send + Sync + 'static,
{
    let codez_target = || filter_fn(|metadata| metadata.target().starts_with("codez_"));
    let file_layer = tracing_subscriber::fmt::layer()
        .json()
        .flatten_event(true)
        .with_current_span(true)
        .with_span_list(true)
        .with_ansi(false)
        .with_target(true)
        .with_writer(writer)
        .with_filter(codez_target().and(filter));
    let console_layer = tracing_subscriber::fmt::layer()
        .compact()
        .with_ansi(false)
        .with_target(false)
        .with_writer(std::io::stderr)
        .with_filter(codez_target().and(LevelFilter::WARN));

    Registry::default().with(file_layer).with(console_layer)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        io::{self, Write},
        sync::{Arc, Mutex},
    };

    use codez_core::{SessionId, StreamId, ToolCallId};
    use codez_runtime::{session_span, stream_span, tool_span};
    use serde_json::Value;
    use tempfile::tempdir;

    use super::{MAX_LOG_FILES, filter_from, rolling_appender, subscriber};

    #[derive(Clone, Default)]
    struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

    impl CaptureWriter {
        fn output(&self) -> String {
            let captured = self
                .0
                .lock()
                .expect("capture writer lock must be available");
            String::from_utf8(captured.clone()).expect("JSON logs must be UTF-8")
        }
    }

    impl Write for CaptureWriter {
        fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| io::Error::other("capture writer lock poisoned"))?
                .extend_from_slice(buffer);
            Ok(buffer.len())
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    #[test]
    fn log_filter_controls_emitted_levels_and_invalid_values_fall_back() {
        let capture = CaptureWriter::default();
        let writer = capture.clone();
        let config = filter_from(Some("info"));
        tracing::subscriber::with_default(
            subscriber(move || writer.clone(), config.filter),
            || {
                tracing::debug!("filtered debug fixture");
                tracing::info!("retained info fixture");
                tracing::info!(
                    target: "external_dependency",
                    authorization = "Bearer third-party-fixture",
                    "filtered external fixture"
                );
            },
        );
        let output = capture.output();

        assert!(!output.contains("filtered debug fixture"));
        assert!(output.contains("retained info fixture"));
        assert!(!output.contains("third-party-fixture"));
        assert!(filter_from(Some("[invalid")).used_fallback);
    }

    #[test]
    fn operation_spans_write_all_correlation_fields_to_structured_logs() {
        let capture = CaptureWriter::default();
        let writer = capture.clone();
        let session_id = SessionId::parse("session-fixture").expect("valid session fixture");
        let stream_id = StreamId::parse("stream-fixture").expect("valid stream fixture");
        let tool_call_id = ToolCallId::parse("tool-call-fixture").expect("valid tool call fixture");
        let filter = filter_from(Some("info")).filter;

        tracing::subscriber::with_default(subscriber(move || writer.clone(), filter), || {
            let session = session_span(&session_id);
            let _session_guard = session.enter();
            let stream = stream_span(&session_id, &stream_id);
            let _stream_guard = stream.enter();
            let tool = tool_span(&session_id, &stream_id, &tool_call_id, "Read");
            let _tool_guard = tool.enter();
            tracing::info!(outcome = "completed", "tool fixture completed");
        });

        let event: Value = serde_json::from_str(
            capture
                .output()
                .lines()
                .next()
                .expect("one structured event must be emitted"),
        )
        .expect("structured event must be valid JSON");
        let span = &event["span"];

        assert_eq!(span["name"], "runtime.tool");
        assert_eq!(span["session_id"], "session-fixture");
        assert_eq!(span["stream_id"], "stream-fixture");
        assert_eq!(span["tool_call_id"], "tool-call-fixture");
        assert_eq!(span["tool_name"], "Read");
        let span_names = event["spans"]
            .as_array()
            .expect("the structured event must contain its span ancestry")
            .iter()
            .map(|span| span["name"].as_str().unwrap_or_default())
            .collect::<Vec<_>>();
        assert_eq!(
            span_names,
            ["runtime.session", "runtime.stream", "runtime.tool"]
        );
    }

    #[test]
    fn rolling_appender_prunes_only_matching_log_files() {
        let directory = tempdir().expect("temporary log directory must be created");
        for day in 1..=MAX_LOG_FILES + 3 {
            fs::write(
                directory
                    .path()
                    .join(format!("codez.2026-06-{day:02}.jsonl")),
                b"fixture\n",
            )
            .expect("old log fixture must be written");
        }
        let unrelated = directory.path().join("user-notes.txt");
        fs::write(&unrelated, b"keep me").expect("unrelated fixture must be written");

        let _appender = rolling_appender(directory.path()).expect("appender must initialize");
        let retained = fs::read_dir(directory.path())
            .expect("log directory must remain readable")
            .filter_map(Result::ok)
            .filter(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| name.starts_with("codez.") && name.ends_with(".jsonl"))
            })
            .count();

        assert_eq!(retained, MAX_LOG_FILES);
        assert!(unrelated.exists());
    }
}
