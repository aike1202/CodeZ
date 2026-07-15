use codez_core::{SessionId, StreamId, ToolCallId};
use tracing::{Span, info_span};

/// Creates the root span for work owned by one chat session.
#[must_use]
pub fn session_span(session_id: &SessionId) -> Span {
    info_span!(
        target: "codez_runtime::operation",
        "runtime.session",
        session_id = session_id.as_str()
    )
}

/// Creates a stream span with its session ancestry recorded explicitly.
#[must_use]
pub fn stream_span(session_id: &SessionId, stream_id: &StreamId) -> Span {
    info_span!(
        target: "codez_runtime::operation",
        "runtime.stream",
        session_id = session_id.as_str(),
        stream_id = stream_id.as_str()
    )
}

/// Creates a tool span with all correlation identifiers needed after task hops.
#[must_use]
pub fn tool_span(
    session_id: &SessionId,
    stream_id: &StreamId,
    tool_call_id: &ToolCallId,
    tool_name: &'static str,
) -> Span {
    info_span!(
        target: "codez_runtime::operation",
        "runtime.tool",
        session_id = session_id.as_str(),
        stream_id = stream_id.as_str(),
        tool_call_id = tool_call_id.as_str(),
        tool_name
    )
}
