use std::sync::atomic::{AtomicU64, Ordering};

use codez_contracts::{CommandError, ErrorCode};
use codez_core::{AppError, AppErrorKind};

#[derive(Debug, Default)]
pub(crate) struct ErrorReporter {
    next_correlation_id: AtomicU64,
}

impl ErrorReporter {
    #[must_use]
    pub(crate) fn report(&self, error: AppError) -> CommandError {
        let correlation_id = self.record(&error);
        CommandError {
            code: contract_code(error.kind()),
            message: error.public_message().to_string(),
            retryable: error.retryable(),
            correlation_id: Some(correlation_id),
        }
    }

    pub(crate) fn log(&self, error: &AppError) {
        self.record(error);
    }

    fn record(&self, error: &AppError) -> String {
        let sequence = self.next_correlation_id.fetch_add(1, Ordering::Relaxed) + 1;
        let correlation_id = format!("cmd-{sequence:016x}");
        let diagnostic = diagnostic_for_log(error);
        match error.kind() {
            AppErrorKind::External | AppErrorKind::Storage | AppErrorKind::Internal => {
                tracing::error!(
                    correlation_id,
                    error_code = error.kind().as_str(),
                    diagnostic,
                    "desktop operation failed"
                );
            }
            AppErrorKind::Validation
            | AppErrorKind::PermissionDenied
            | AppErrorKind::NotFound
            | AppErrorKind::Conflict
            | AppErrorKind::Cancelled
            | AppErrorKind::Timeout => {
                tracing::warn!(
                    correlation_id,
                    error_code = error.kind().as_str(),
                    diagnostic,
                    "desktop operation rejected"
                );
            }
        }
        correlation_id
    }
}

pub(crate) fn command_result<T>(
    reporter: &ErrorReporter,
    result: Result<T, AppError>,
) -> Result<T, CommandError> {
    result.map_err(|error| reporter.report(error))
}

fn diagnostic_for_log(error: &AppError) -> &str {
    error.diagnostic().unwrap_or_else(|| error.public_message())
}

const fn contract_code(kind: AppErrorKind) -> ErrorCode {
    match kind {
        AppErrorKind::Validation => ErrorCode::Validation,
        AppErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        AppErrorKind::NotFound => ErrorCode::NotFound,
        AppErrorKind::Conflict => ErrorCode::Conflict,
        AppErrorKind::External => ErrorCode::External,
        AppErrorKind::Cancelled => ErrorCode::Cancelled,
        AppErrorKind::Timeout => ErrorCode::Timeout,
        AppErrorKind::Storage => ErrorCode::Storage,
        AppErrorKind::Internal => ErrorCode::Internal,
    }
}

#[cfg(test)]
mod tests {
    use std::{
        io::{self, Write},
        sync::{Arc, Mutex},
    };

    use codez_contracts::ErrorCode;
    use codez_core::AppError;

    use codez_core::AppErrorKind;

    use super::{ErrorReporter, contract_code, diagnostic_for_log};

    #[derive(Clone)]
    struct CaptureWriter(Arc<Mutex<Vec<u8>>>);

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
    fn reporter_hides_internal_diagnostics_from_command_errors() {
        let reporter = ErrorReporter::default();
        let command_error = reporter.report(AppError::internal("apiKey=secret-value"));

        assert_eq!(
            (command_error.code, command_error.message.as_str()),
            (ErrorCode::Internal, "An internal error occurred")
        );
    }

    #[test]
    fn reporter_assigns_a_correlation_id() {
        let reporter = ErrorReporter::default();
        let command_error = reporter.report(AppError::validation("Invalid input"));

        assert_eq!(
            command_error.correlation_id.as_deref(),
            Some("cmd-0000000000000001")
        );
    }

    #[test]
    fn diagnostic_logging_redacts_credentials() {
        let error = AppError::internal("Authorization: Bearer secret-token");
        let diagnostic = diagnostic_for_log(&error);

        assert!(!diagnostic.contains("secret-token"));
    }

    #[test]
    fn structured_tracing_output_never_receives_raw_error_credentials() {
        let bytes = Arc::new(Mutex::new(Vec::new()));
        let capture = CaptureWriter(Arc::clone(&bytes));
        let subscriber = tracing_subscriber::fmt()
            .without_time()
            .with_ansi(false)
            .with_target(false)
            .with_writer(move || capture.clone())
            .finish();
        let reporter = ErrorReporter::default();
        tracing::subscriber::with_default(subscriber, || {
            reporter.log(&AppError::external(
                "Provider request failed",
                r#"Authorization: Bearer bearer-fixture {"refresh_token":"refresh fixture value"}"#,
                false,
            ));
        });
        let captured = bytes
            .lock()
            .expect("capture writer lock must remain available")
            .clone();
        let output = String::from_utf8(captured).expect("tracing output must be UTF-8");

        assert!(!output.contains("bearer-fixture") && !output.contains("refresh fixture value"));
    }

    #[test]
    fn every_application_error_kind_has_the_stable_contract_code() {
        let cases = [
            (AppErrorKind::Validation, ErrorCode::Validation),
            (AppErrorKind::PermissionDenied, ErrorCode::PermissionDenied),
            (AppErrorKind::NotFound, ErrorCode::NotFound),
            (AppErrorKind::Conflict, ErrorCode::Conflict),
            (AppErrorKind::External, ErrorCode::External),
            (AppErrorKind::Cancelled, ErrorCode::Cancelled),
            (AppErrorKind::Timeout, ErrorCode::Timeout),
            (AppErrorKind::Storage, ErrorCode::Storage),
            (AppErrorKind::Internal, ErrorCode::Internal),
        ];

        assert!(
            cases
                .into_iter()
                .all(|(kind, expected)| contract_code(kind) == expected)
        );
    }
}
