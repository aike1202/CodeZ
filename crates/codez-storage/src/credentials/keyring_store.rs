use std::sync::Mutex;

use keyring::{Entry, Error as KeyringError};

use super::{CredentialError, CredentialId, CredentialStore, SecretValue};

/// Stable service name used for all CodeZ operating-system credentials.
pub const CODEZ_CREDENTIAL_SERVICE: &str = "com.codez.desktop";

/// Serialized adapter for the platform credential manager selected at build time.
#[derive(Debug)]
pub struct OsCredentialStore {
    service_name: String,
    operation_lock: Mutex<()>,
}

impl Default for OsCredentialStore {
    fn default() -> Self {
        Self {
            service_name: CODEZ_CREDENTIAL_SERVICE.to_string(),
            operation_lock: Mutex::new(()),
        }
    }
}

impl OsCredentialStore {
    /// Creates an adapter with an explicit service namespace.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialError::InvalidIdentifier`] when `service_name` is
    /// empty, longer than 128 bytes, or contains unsafe characters.
    pub fn new(service_name: impl Into<String>) -> Result<Self, CredentialError> {
        let service_name = service_name.into();
        if !valid_service_name(&service_name) {
            return Err(CredentialError::InvalidIdentifier);
        }
        Ok(Self {
            service_name,
            operation_lock: Mutex::new(()),
        })
    }

    /// Returns the non-secret service namespace used for platform entries.
    #[must_use]
    pub fn service_name(&self) -> &str {
        &self.service_name
    }

    fn entry(&self, id: &CredentialId, operation: &'static str) -> Result<Entry, CredentialError> {
        Entry::new(&self.service_name, &id.account_name())
            .map_err(|error| map_keyring_error(operation, id, error))
    }

    fn lock_operation(
        &self,
        operation: &'static str,
    ) -> Result<std::sync::MutexGuard<'_, ()>, CredentialError> {
        self.operation_lock
            .lock()
            .map_err(|_| CredentialError::Unavailable { operation })
    }
}

impl CredentialStore for OsCredentialStore {
    fn get(&self, id: &CredentialId) -> Result<SecretValue, CredentialError> {
        const OPERATION: &str = "read a credential";
        let _guard = self.lock_operation(OPERATION)?;
        let value = self
            .entry(id, OPERATION)?
            .get_password()
            .map_err(|error| map_keyring_error(OPERATION, id, error))?;
        SecretValue::from_stored(value, id)
    }

    fn set(&self, id: &CredentialId, value: &SecretValue) -> Result<(), CredentialError> {
        const OPERATION: &str = "write a credential";
        let _guard = self.lock_operation(OPERATION)?;
        self.entry(id, OPERATION)?
            .set_password(value.expose_secret())
            .map_err(|error| map_keyring_error(OPERATION, id, error))
    }

    fn delete(&self, id: &CredentialId) -> Result<(), CredentialError> {
        const OPERATION: &str = "delete a credential";
        let _guard = self.lock_operation(OPERATION)?;
        self.entry(id, OPERATION)?
            .delete_credential()
            .map_err(|error| map_keyring_error(OPERATION, id, error))
    }
}

fn valid_service_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn map_keyring_error(
    operation: &'static str,
    id: &CredentialId,
    error: KeyringError,
) -> CredentialError {
    match error {
        KeyringError::NoEntry => CredentialError::NotFound { id: id.clone() },
        KeyringError::NoStorageAccess(source) => map_no_storage_access(operation, source.as_ref()),
        KeyringError::BadEncoding(_) | KeyringError::Ambiguous(_) => {
            CredentialError::Corrupt { id: id.clone() }
        }
        KeyringError::TooLong(attribute, platform_limit)
            if attribute.eq_ignore_ascii_case("password")
                || attribute.eq_ignore_ascii_case("secret") =>
        {
            CredentialError::SecretTooLarge { platform_limit }
        }
        KeyringError::TooLong(_, _) | KeyringError::Invalid(_, _) => {
            CredentialError::InvalidIdentifier
        }
        KeyringError::PlatformFailure(source) => map_platform_failure(operation, source.as_ref()),
        _ => CredentialError::Unavailable { operation },
    }
}

#[cfg(windows)]
fn map_no_storage_access(
    operation: &'static str,
    _source: &(dyn std::error::Error + Send + Sync + 'static),
) -> CredentialError {
    CredentialError::Unavailable { operation }
}

#[cfg(not(windows))]
fn map_no_storage_access(
    operation: &'static str,
    source: &(dyn std::error::Error + Send + Sync + 'static),
) -> CredentialError {
    let diagnostic = source.to_string().to_ascii_lowercase();
    if diagnostic.contains("not available")
        || diagnostic.contains("no such keychain")
        || diagnostic.contains("invalid keychain")
    {
        CredentialError::Unavailable { operation }
    } else {
        CredentialError::AccessDenied { operation }
    }
}

#[cfg(windows)]
fn map_platform_failure(
    operation: &'static str,
    source: &(dyn std::error::Error + Send + Sync + 'static),
) -> CredentialError {
    let permission_denied = source
        .downcast_ref::<keyring::windows::Error>()
        .is_some_and(|error| {
            std::io::Error::from_raw_os_error(error.0 as i32).kind()
                == std::io::ErrorKind::PermissionDenied
        });
    if permission_denied {
        CredentialError::AccessDenied { operation }
    } else {
        CredentialError::Unavailable { operation }
    }
}

#[cfg(not(windows))]
fn map_platform_failure(
    operation: &'static str,
    _source: &(dyn std::error::Error + Send + Sync + 'static),
) -> CredentialError {
    CredentialError::Unavailable { operation }
}

#[cfg(test)]
mod tests {
    use std::io;

    use keyring::Error as KeyringError;

    use super::{CredentialError, map_keyring_error};
    use crate::{CredentialId, CredentialKind};

    fn fixture_id() -> CredentialId {
        CredentialId::new(CredentialKind::McpSecret, "fixture")
            .expect("fixture credential id must be valid")
    }

    #[cfg(windows)]
    fn permission_denied_error() -> KeyringError {
        KeyringError::PlatformFailure(Box::new(keyring::windows::Error(5)))
    }

    #[cfg(not(windows))]
    fn permission_denied_error() -> KeyringError {
        KeyringError::NoStorageAccess(Box::new(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "fixture denial",
        )))
    }

    #[test]
    fn keyring_errors_map_to_stable_credential_categories_without_source_payloads() {
        let id = fixture_id();
        let not_found = map_keyring_error("read", &id, KeyringError::NoEntry);
        let denied = map_keyring_error("read", &id, permission_denied_error());
        let corrupt = map_keyring_error("read", &id, KeyringError::BadEncoding(vec![0xff]));
        let unavailable = map_keyring_error(
            "read",
            &id,
            KeyringError::PlatformFailure(Box::new(io::Error::new(
                io::ErrorKind::NotConnected,
                "fixture unavailable",
            ))),
        );

        assert!(
            matches!(not_found, CredentialError::NotFound { .. })
                && matches!(denied, CredentialError::AccessDenied { .. })
                && matches!(corrupt, CredentialError::Corrupt { .. })
                && matches!(unavailable, CredentialError::Unavailable { .. })
        );
    }

    #[test]
    fn os_credential_store_rejects_an_unsafe_service_namespace() {
        let result = super::OsCredentialStore::new("../unsafe");

        assert!(matches!(result, Err(CredentialError::InvalidIdentifier)));
    }
}
