use thiserror::Error;

use crate::redaction::RedactedText;

/// Stable error categories shared by application services and desktop adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppErrorKind {
    Validation,
    Unsupported,
    PermissionDenied,
    NotFound,
    Conflict,
    RunActive,
    External,
    ProcessFailed,
    Cancelled,
    Timeout,
    Storage,
    Internal,
}

impl AppErrorKind {
    /// Returns the stable wire/log spelling for this category.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Validation => "VALIDATION",
            Self::Unsupported => "UNSUPPORTED",
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::RunActive => "RUN_ACTIVE",
            Self::External => "EXTERNAL",
            Self::ProcessFailed => "PROCESS_FAILED",
            Self::Cancelled => "CANCELLED",
            Self::Timeout => "TIMEOUT",
            Self::Storage => "STORAGE",
            Self::Internal => "INTERNAL",
        }
    }
}

/// Application error whose public and diagnostic text is redacted at construction.
#[derive(Debug, Error)]
#[error("{message}")]
pub struct AppError {
    kind: AppErrorKind,
    message: RedactedText,
    retryable: bool,
    diagnostic: Option<RedactedText>,
}

impl AppError {
    /// Creates a non-retryable input validation error.
    #[must_use]
    pub fn validation(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::Validation, message, false)
    }

    /// Creates a non-retryable error for a capability that is not implemented by this host.
    #[must_use]
    pub fn unsupported(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::Unsupported, message, false)
    }

    /// Creates a non-retryable authorization failure.
    #[must_use]
    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::PermissionDenied, message, false)
    }

    /// Creates a non-retryable missing-resource error.
    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::NotFound, message, false)
    }

    /// Creates a non-retryable state or version conflict.
    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::Conflict, message, false)
    }

    /// Creates a retryable conflict caused by active work owning the session.
    #[must_use]
    pub fn run_active(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::RunActive, message, true)
    }

    /// Creates an external dependency error with private diagnostic context.
    #[must_use]
    pub fn external(
        message: impl Into<String>,
        diagnostic: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::with_diagnostic(AppErrorKind::External, message, diagnostic, retryable)
    }

    /// Creates a non-retryable child process with a non-successful exit status.
    #[must_use]
    pub fn process_failed(message: impl Into<String>, diagnostic: impl Into<String>) -> Self {
        Self::with_diagnostic(AppErrorKind::ProcessFailed, message, diagnostic, false)
    }

    /// Creates a user-requested cancellation error.
    #[must_use]
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::Cancelled, message, false)
    }

    /// Creates a retryable timeout error.
    #[must_use]
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::without_diagnostic(AppErrorKind::Timeout, message, true)
    }

    /// Creates a storage error with private diagnostic context.
    #[must_use]
    pub fn storage(
        message: impl Into<String>,
        diagnostic: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::with_diagnostic(AppErrorKind::Storage, message, diagnostic, retryable)
    }

    /// Creates an internal error whose diagnostic is never a public message.
    #[must_use]
    pub fn internal(diagnostic: impl Into<String>) -> Self {
        Self::with_diagnostic(
            AppErrorKind::Internal,
            "An internal error occurred",
            diagnostic,
            false,
        )
    }

    fn without_diagnostic(kind: AppErrorKind, message: impl Into<String>, retryable: bool) -> Self {
        Self {
            kind,
            message: RedactedText::new(message),
            retryable,
            diagnostic: None,
        }
    }

    fn with_diagnostic(
        kind: AppErrorKind,
        message: impl Into<String>,
        diagnostic: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self {
            kind,
            message: RedactedText::new(message),
            retryable,
            diagnostic: Some(RedactedText::new(diagnostic)),
        }
    }

    /// Returns the stable category used for adapter mapping.
    #[must_use]
    pub const fn kind(&self) -> AppErrorKind {
        self.kind
    }

    /// Returns the message that may cross a user-facing boundary after redaction.
    #[must_use]
    pub fn public_message(&self) -> &str {
        self.message.as_str()
    }

    /// Reports whether the caller may safely retry the same operation.
    #[must_use]
    pub const fn retryable(&self) -> bool {
        self.retryable
    }

    /// Returns private diagnostic context for redacted logging only.
    #[must_use]
    pub fn diagnostic(&self) -> Option<&str> {
        self.diagnostic.as_ref().map(RedactedText::as_str)
    }
}

#[cfg(test)]
mod tests {
    use super::{AppError, AppErrorKind};

    #[test]
    fn internal_errors_do_not_expose_diagnostic_context() {
        let error = AppError::internal("apiKey=secret-value");

        assert_eq!(error.public_message(), "An internal error occurred");
    }

    #[test]
    fn app_error_debug_and_display_are_redacted_at_construction() {
        let error = AppError::external(
            "Request failed: https://example.test?token=public-secret",
            r#"provider response {"refresh_token":"private secret value"}"#,
            false,
        );

        let rendered = format!(
            "{error} {error:?} {}",
            error.diagnostic().unwrap_or_default()
        );

        assert!(!rendered.contains("public-secret") && !rendered.contains("private secret value"));
    }

    #[test]
    fn timeout_errors_are_retryable() {
        let error = AppError::timeout("The operation timed out");

        assert!(error.retryable());
    }

    #[test]
    fn error_kinds_keep_stable_wire_spelling() {
        assert_eq!(AppErrorKind::PermissionDenied.as_str(), "PERMISSION_DENIED");
    }

    #[test]
    fn operation_failures_keep_distinct_categories() {
        let failures = [
            AppError::cancelled("cancelled"),
            AppError::timeout("timed out"),
            AppError::process_failed("process failed", "exit code 1"),
            AppError::validation("invalid input"),
            AppError::unsupported("unsupported operation"),
            AppError::permission_denied("permission denied"),
            AppError::internal("internal failure"),
        ];

        assert_eq!(
            failures.map(|error| error.kind()),
            [
                AppErrorKind::Cancelled,
                AppErrorKind::Timeout,
                AppErrorKind::ProcessFailed,
                AppErrorKind::Validation,
                AppErrorKind::Unsupported,
                AppErrorKind::PermissionDenied,
                AppErrorKind::Internal,
            ]
        );
    }
}
