use codez_contracts::CommandError;
use codez_core::{AppError, RedactedText};
use serde::Deserialize;
use tauri::State;

use crate::{error::command_result, state::AppState};

const MAX_RENDERER_LOG_MESSAGE_BYTES: usize = 4 * 1024;

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RendererLogLevel {
    Debug,
    Info,
    Warn,
    Error,
}

impl RendererLogLevel {
    const fn as_str(self) -> &'static str {
        match self {
            Self::Debug => "debug",
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}

/// Writes a bounded, redacted renderer message through the desktop tracing subscriber.
#[tauri::command]
#[tracing::instrument(
    name = "desktop.command",
    skip(state, message),
    fields(command = "renderer_log", level = level.as_str(), message_bytes = message.len())
)]
pub fn renderer_log(
    state: State<'_, AppState>,
    level: RendererLogLevel,
    message: String,
) -> Result<(), CommandError> {
    command_result(&state.errors, emit_renderer_log(level, &message))
}

fn emit_renderer_log(level: RendererLogLevel, message: &str) -> Result<(), AppError> {
    let message = prepared_renderer_message(message)?;
    match level {
        RendererLogLevel::Debug => {
            tracing::debug!(
                target: "codez_desktop::renderer",
                renderer = true,
                renderer_message = %message,
                "renderer log"
            );
        }
        RendererLogLevel::Info => {
            tracing::info!(
                target: "codez_desktop::renderer",
                renderer = true,
                renderer_message = %message,
                "renderer log"
            );
        }
        RendererLogLevel::Warn => {
            tracing::warn!(
                target: "codez_desktop::renderer",
                renderer = true,
                renderer_message = %message,
                "renderer log"
            );
        }
        RendererLogLevel::Error => {
            tracing::error!(
                target: "codez_desktop::renderer",
                renderer = true,
                renderer_message = %message,
                "renderer log"
            );
        }
    }
    Ok(())
}

fn prepared_renderer_message(message: &str) -> Result<RedactedText, AppError> {
    if message.len() > MAX_RENDERER_LOG_MESSAGE_BYTES {
        return Err(AppError::validation(
            "Renderer log messages must not exceed 4 KiB.",
        ));
    }
    Ok(RedactedText::new(message))
}

#[cfg(test)]
mod tests {
    use codez_core::AppErrorKind;

    use super::{MAX_RENDERER_LOG_MESSAGE_BYTES, prepared_renderer_message};

    #[test]
    fn prepared_renderer_message_rejects_messages_larger_than_the_byte_limit() {
        let oversized = "a".repeat(MAX_RENDERER_LOG_MESSAGE_BYTES + 1);
        let error = prepared_renderer_message(&oversized)
            .expect_err("oversized renderer logs must not cross the command boundary");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn prepared_renderer_message_redacts_credentials_before_tracing() {
        let message = prepared_renderer_message("Authorization: Bearer renderer-secret")
            .expect("bounded renderer log messages must be accepted");

        assert!(!message.as_str().contains("renderer-secret"));
    }
}
