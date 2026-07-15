use thiserror::Error;

/// Stable error categories shared by application services and desktop adapters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppErrorKind {
    Validation,
    PermissionDenied,
    NotFound,
    Conflict,
    External,
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
            Self::PermissionDenied => "PERMISSION_DENIED",
            Self::NotFound => "NOT_FOUND",
            Self::Conflict => "CONFLICT",
            Self::External => "EXTERNAL",
            Self::Cancelled => "CANCELLED",
            Self::Timeout => "TIMEOUT",
            Self::Storage => "STORAGE",
            Self::Internal => "INTERNAL",
        }
    }
}

/// Application error with a user-safe message and optional diagnostic context.
#[derive(Debug, Error)]
pub enum AppError {
    #[error("{message}")]
    Validation { message: String },
    #[error("{message}")]
    PermissionDenied { message: String },
    #[error("{message}")]
    NotFound { message: String },
    #[error("{message}")]
    Conflict { message: String },
    #[error("{message}")]
    External {
        message: String,
        retryable: bool,
        diagnostic: String,
    },
    #[error("{message}")]
    Cancelled { message: String },
    #[error("{message}")]
    Timeout { message: String },
    #[error("{message}")]
    Storage {
        message: String,
        retryable: bool,
        diagnostic: String,
    },
    #[error("An internal error occurred")]
    Internal { diagnostic: String },
}

impl AppError {
    /// Creates a non-retryable input validation error.
    #[must_use]
    pub fn validation(message: impl Into<String>) -> Self {
        Self::Validation {
            message: message.into(),
        }
    }

    /// Creates a non-retryable authorization failure.
    #[must_use]
    pub fn permission_denied(message: impl Into<String>) -> Self {
        Self::PermissionDenied {
            message: message.into(),
        }
    }

    /// Creates a non-retryable missing-resource error.
    #[must_use]
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::NotFound {
            message: message.into(),
        }
    }

    /// Creates a non-retryable state or version conflict.
    #[must_use]
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::Conflict {
            message: message.into(),
        }
    }

    /// Creates an external dependency error with private diagnostic context.
    #[must_use]
    pub fn external(
        message: impl Into<String>,
        diagnostic: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::External {
            message: message.into(),
            retryable,
            diagnostic: diagnostic.into(),
        }
    }

    /// Creates a user-requested cancellation error.
    #[must_use]
    pub fn cancelled(message: impl Into<String>) -> Self {
        Self::Cancelled {
            message: message.into(),
        }
    }

    /// Creates a retryable timeout error.
    #[must_use]
    pub fn timeout(message: impl Into<String>) -> Self {
        Self::Timeout {
            message: message.into(),
        }
    }

    /// Creates a storage error with private diagnostic context.
    #[must_use]
    pub fn storage(
        message: impl Into<String>,
        diagnostic: impl Into<String>,
        retryable: bool,
    ) -> Self {
        Self::Storage {
            message: message.into(),
            retryable,
            diagnostic: diagnostic.into(),
        }
    }

    /// Creates an internal error whose diagnostic is never a public message.
    #[must_use]
    pub fn internal(diagnostic: impl Into<String>) -> Self {
        Self::Internal {
            diagnostic: diagnostic.into(),
        }
    }

    /// Returns the stable category used for adapter mapping.
    #[must_use]
    pub const fn kind(&self) -> AppErrorKind {
        match self {
            Self::Validation { .. } => AppErrorKind::Validation,
            Self::PermissionDenied { .. } => AppErrorKind::PermissionDenied,
            Self::NotFound { .. } => AppErrorKind::NotFound,
            Self::Conflict { .. } => AppErrorKind::Conflict,
            Self::External { .. } => AppErrorKind::External,
            Self::Cancelled { .. } => AppErrorKind::Cancelled,
            Self::Timeout { .. } => AppErrorKind::Timeout,
            Self::Storage { .. } => AppErrorKind::Storage,
            Self::Internal { .. } => AppErrorKind::Internal,
        }
    }

    /// Returns the message that may cross a user-facing boundary after redaction.
    #[must_use]
    pub fn public_message(&self) -> &str {
        match self {
            Self::Validation { message }
            | Self::PermissionDenied { message }
            | Self::NotFound { message }
            | Self::Conflict { message }
            | Self::External { message, .. }
            | Self::Cancelled { message }
            | Self::Timeout { message }
            | Self::Storage { message, .. } => message,
            Self::Internal { .. } => "An internal error occurred",
        }
    }

    /// Reports whether the caller may safely retry the same operation.
    #[must_use]
    pub const fn retryable(&self) -> bool {
        match self {
            Self::External { retryable, .. } | Self::Storage { retryable, .. } => *retryable,
            Self::Timeout { .. } => true,
            Self::Validation { .. }
            | Self::PermissionDenied { .. }
            | Self::NotFound { .. }
            | Self::Conflict { .. }
            | Self::Cancelled { .. }
            | Self::Internal { .. } => false,
        }
    }

    /// Returns private diagnostic context for redacted logging only.
    #[must_use]
    pub fn diagnostic(&self) -> Option<&str> {
        match self {
            Self::External { diagnostic, .. }
            | Self::Storage { diagnostic, .. }
            | Self::Internal { diagnostic } => Some(diagnostic),
            Self::Validation { .. }
            | Self::PermissionDenied { .. }
            | Self::NotFound { .. }
            | Self::Conflict { .. }
            | Self::Cancelled { .. }
            | Self::Timeout { .. } => None,
        }
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
    fn timeout_errors_are_retryable() {
        let error = AppError::timeout("The operation timed out");

        assert!(error.retryable());
    }

    #[test]
    fn error_kinds_keep_stable_wire_spelling() {
        assert_eq!(AppErrorKind::PermissionDenied.as_str(), "PERMISSION_DENIED");
    }
}
