use std::{collections::HashMap, sync::Arc, time::Duration};

use futures_util::StreamExt;
use http::{HeaderName, HeaderValue, header::ACCEPT};
use reqwest_013::{Client, redirect};
use rmcp::{
    RoleClient,
    model::{ClientJsonRpcMessage, ServerJsonRpcMessage},
    transport::Transport,
};
use sse_stream::SseStream;
use thiserror::Error;
use tokio::{sync::Mutex, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;
use url::Url;

use crate::{McpError, McpOperation};

const MAX_LEGACY_SSE_ENDPOINT_BYTES: usize = 8 * 1024;
const MAX_LEGACY_SSE_EVENT_BYTES: usize = 1024 * 1024;
const EVENT_STREAM_MIME_TYPE: &str = "text/event-stream";
const JSON_MIME_TYPE: &str = "application/json";

/// Non-secret HTTP material shared by the legacy SSE reader and POST writer.
pub(crate) struct LegacySseTransportConfig {
    pub(super) endpoint: String,
    pub(super) headers: HashMap<HeaderName, HeaderValue>,
    pub(super) bearer_token: Option<String>,
    pub(super) redaction_values: Vec<String>,
}

impl LegacySseTransportConfig {
    pub(crate) fn redaction_values(&self) -> &[String] {
        &self.redaction_values
    }
}

/// Owns the background reader for one legacy SSE connection.
pub(crate) struct LegacySseResources {
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

impl LegacySseResources {
    pub(crate) async fn cleanup(&self, close_timeout: Duration) -> Result<(), McpError> {
        let tasks = std::mem::take(&mut *self.tasks.lock().await);
        for mut task in tasks {
            match timeout(close_timeout, &mut task).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return Err(McpError::BackgroundTask),
                Err(_) => {
                    task.abort();
                    let _result = task.await;
                    return Err(McpError::Timeout {
                        operation: McpOperation::Close,
                        timeout: close_timeout,
                    });
                }
            }
        }
        Ok(())
    }
}

#[derive(Debug, Error)]
pub(crate) enum LegacySseTransportError {
    #[error("legacy SSE MCP transport request failed")]
    Request,
}

struct PostState {
    client: Client,
    endpoint: Url,
    headers: Arc<HashMap<HeaderName, HeaderValue>>,
    bearer_token: Option<Arc<str>>,
    lifetime: CancellationToken,
}

pub(crate) struct LegacySseTransport {
    outgoing: tokio::sync::mpsc::Sender<ClientJsonRpcMessage>,
    incoming: tokio::sync::mpsc::Receiver<ServerJsonRpcMessage>,
    lifetime: CancellationToken,
}

impl Transport<RoleClient> for LegacySseTransport {
    type Error = LegacySseTransportError;

    fn send(
        &mut self,
        message: ClientJsonRpcMessage,
    ) -> impl std::future::Future<Output = Result<(), Self::Error>> + Send + 'static {
        let outgoing = self.outgoing.clone();
        async move {
            outgoing
                .send(message)
                .await
                .map_err(|_| LegacySseTransportError::Request)
        }
    }

    async fn receive(&mut self) -> Option<ServerJsonRpcMessage> {
        self.incoming.recv().await
    }

    async fn close(&mut self) -> Result<(), Self::Error> {
        self.lifetime.cancel();
        Ok(())
    }
}

/// Establishes the legacy MCP two-endpoint transport using rmcp's generic
/// sink/stream adapter. The initial SSE `endpoint` event is mandatory and its
/// advertised POST URL is constrained to the configured origin before any
/// JSON-RPC request is sent.
pub(crate) async fn connect(
    config: LegacySseTransportConfig,
    lifetime: CancellationToken,
    cancellation: &CancellationToken,
    connect_timeout: Duration,
    channel_capacity: usize,
) -> Result<(LegacySseResources, LegacySseTransport), McpError> {
    let endpoint = Url::parse(&config.endpoint).map_err(|_| protocol_connect_error())?;
    let client = Client::builder()
        .redirect(redirect::Policy::none())
        .build()
        .map_err(|_| protocol_connect_error())?;
    let mut stream = open_sse_stream(&client, &endpoint, &config)
        .await
        .map_err(|_| protocol_connect_error())?;
    let messages_endpoint = await_messages_endpoint(
        &mut stream,
        &endpoint,
        cancellation,
        &lifetime,
        connect_timeout,
    )
    .await?;

    let (incoming_sender, incoming) = tokio::sync::mpsc::channel(channel_capacity);
    let receive_lifetime = lifetime.clone();
    let receive_task = tokio::spawn(async move {
        receive_messages(&mut stream, incoming_sender, receive_lifetime).await;
    });
    let post_state = PostState {
        client,
        endpoint: messages_endpoint,
        headers: Arc::new(config.headers),
        bearer_token: config.bearer_token.map(Arc::<str>::from),
        lifetime: lifetime.clone(),
    };
    let (outgoing, post_receiver) = tokio::sync::mpsc::channel(channel_capacity);
    let post_task = tokio::spawn(async move {
        post_messages(post_receiver, post_state).await;
    });

    Ok((
        LegacySseResources {
            tasks: Mutex::new(vec![receive_task, post_task]),
        },
        LegacySseTransport {
            outgoing,
            incoming,
            lifetime,
        },
    ))
}

async fn open_sse_stream(
    client: &Client,
    endpoint: &Url,
    config: &LegacySseTransportConfig,
) -> Result<
    impl futures_util::Stream<Item = Result<sse_stream::Sse, sse_stream::Error>> + use<>,
    LegacySseTransportError,
> {
    let mut request = client
        .get(endpoint.clone())
        .header(ACCEPT, EVENT_STREAM_MIME_TYPE);
    for (name, value) in &config.headers {
        request = request.header(name, value);
    }
    if let Some(token) = &config.bearer_token {
        request = request.bearer_auth(token);
    }
    let response = request
        .send()
        .await
        .map_err(|_| LegacySseTransportError::Request)?;
    if !response.status().is_success()
        || !response
            .headers()
            .get(reqwest_013::header::CONTENT_TYPE)
            .is_some_and(|value| {
                value
                    .as_bytes()
                    .starts_with(EVENT_STREAM_MIME_TYPE.as_bytes())
            })
    {
        return Err(LegacySseTransportError::Request);
    }
    Ok(SseStream::from_bytes_stream(response.bytes_stream()))
}

async fn await_messages_endpoint<S>(
    stream: &mut S,
    configured_endpoint: &Url,
    cancellation: &CancellationToken,
    lifetime: &CancellationToken,
    connect_timeout: Duration,
) -> Result<Url, McpError>
where
    S: futures_util::Stream<Item = Result<sse_stream::Sse, sse_stream::Error>> + Unpin,
{
    let wait_for_endpoint = async {
        while let Some(event) = stream.next().await {
            let event = event.map_err(|_| protocol_connect_error())?;
            if event.event.as_deref() != Some("endpoint") {
                continue;
            }
            let Some(advertised) = event.data else {
                return Err(protocol_connect_error());
            };
            return messages_endpoint(configured_endpoint, &advertised);
        }
        Err(protocol_connect_error())
    };
    tokio::select! {
        _ = cancellation.cancelled() => Err(McpError::Cancelled { operation: McpOperation::Connect }),
        _ = lifetime.cancelled() => Err(McpError::Cancelled { operation: McpOperation::Connect }),
        result = timeout(connect_timeout, wait_for_endpoint) => result.unwrap_or(Err(McpError::Timeout {
            operation: McpOperation::Connect,
            timeout: connect_timeout,
        })),
    }
}

fn messages_endpoint(configured_endpoint: &Url, advertised: &str) -> Result<Url, McpError> {
    if advertised.is_empty() || advertised.len() > MAX_LEGACY_SSE_ENDPOINT_BYTES {
        return Err(protocol_connect_error());
    }
    let endpoint = configured_endpoint
        .join(advertised)
        .map_err(|_| protocol_connect_error())?;
    if !matches!(endpoint.scheme(), "http" | "https")
        || endpoint.origin() != configured_endpoint.origin()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err(protocol_connect_error());
    }
    Ok(endpoint)
}

async fn receive_messages<S>(
    stream: &mut S,
    sender: tokio::sync::mpsc::Sender<ServerJsonRpcMessage>,
    lifetime: CancellationToken,
) where
    S: futures_util::Stream<Item = Result<sse_stream::Sse, sse_stream::Error>> + Unpin,
{
    while let Some(event) = tokio::select! {
        _ = lifetime.cancelled() => None,
        event = stream.next() => event,
    } {
        let Ok(event) = event else {
            return;
        };
        if !matches!(event.event.as_deref(), None | Some("") | Some("message")) {
            continue;
        }
        let Some(data) = event.data else {
            continue;
        };
        if data.len() > MAX_LEGACY_SSE_EVENT_BYTES {
            return;
        }
        let Ok(message) = serde_json::from_str::<ServerJsonRpcMessage>(&data) else {
            continue;
        };
        if tokio::select! {
            _ = lifetime.cancelled() => Ok(()),
            result = sender.send(message) => result.map_err(|_| ()),
        }
        .is_err()
        {
            return;
        }
    }
}

async fn post_message(
    state: &PostState,
    message: ClientJsonRpcMessage,
) -> Result<(), LegacySseTransportError> {
    let mut request = state
        .client
        .post(state.endpoint.clone())
        .header(ACCEPT, JSON_MIME_TYPE)
        .json(&message);
    for (name, value) in state.headers.iter() {
        request = request.header(name, value);
    }
    if let Some(token) = &state.bearer_token {
        request = request.bearer_auth(token.as_ref());
    }
    let send = request.send();
    tokio::select! {
        _ = state.lifetime.cancelled() => Err(LegacySseTransportError::Request),
        response = send => {
            let response = response.map_err(|_| LegacySseTransportError::Request)?;
            if response.status().is_success() {
                Ok(())
            } else {
                Err(LegacySseTransportError::Request)
            }
        }
    }
}

async fn post_messages(
    mut receiver: tokio::sync::mpsc::Receiver<ClientJsonRpcMessage>,
    state: PostState,
) {
    while let Some(message) = tokio::select! {
        _ = state.lifetime.cancelled() => None,
        message = receiver.recv() => message,
    } {
        if post_message(&state, message).await.is_err() {
            return;
        }
    }
}

fn protocol_connect_error() -> McpError {
    McpError::Protocol {
        operation: McpOperation::Connect,
        transport: crate::McpTransportKind::LegacySse,
    }
}
