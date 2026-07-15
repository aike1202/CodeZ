mod keyring_store;

use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use thiserror::Error;
use zeroize::Zeroize;

pub use keyring_store::{CODEZ_CREDENTIAL_SERVICE, OsCredentialStore};

const MAX_CREDENTIAL_KEY_BYTES: usize = 192;

/// Stable namespace for one category of operating-system credential.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum CredentialKind {
    /// API key owned by a configured model provider.
    ProviderApiKey,
    /// Named secret referenced from MCP configuration.
    McpSecret,
    /// OAuth client, token, and discovery state for one MCP server.
    McpOAuth,
}

impl CredentialKind {
    const fn prefix(self) -> &'static str {
        match self {
            Self::ProviderApiKey => "provider-api-key",
            Self::McpSecret => "mcp-secret",
            Self::McpOAuth => "mcp-oauth",
        }
    }

    fn from_prefix(value: &str) -> Option<Self> {
        match value {
            "provider-api-key" => Some(Self::ProviderApiKey),
            "mcp-secret" => Some(Self::McpSecret),
            "mcp-oauth" => Some(Self::McpOAuth),
            _ => None,
        }
    }
}

/// Validated, non-secret account identity persisted by configuration models.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct CredentialId {
    kind: CredentialKind,
    key: String,
}

impl CredentialId {
    /// Creates a credential identity from a stable namespace and domain key.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialError::InvalidIdentifier`] when `key` is empty,
    /// exceeds 192 bytes, or contains characters outside ASCII letters,
    /// digits, dot, underscore, and hyphen.
    pub fn new(kind: CredentialKind, key: impl Into<String>) -> Result<Self, CredentialError> {
        let key = key.into();
        if !valid_key(&key) {
            return Err(CredentialError::InvalidIdentifier);
        }
        Ok(Self { kind, key })
    }

    /// Parses the stable `<kind>:<key>` representation.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialError::InvalidIdentifier`] for unknown namespaces
    /// or invalid domain keys.
    pub fn parse(value: &str) -> Result<Self, CredentialError> {
        let (prefix, key) = value
            .split_once(':')
            .ok_or(CredentialError::InvalidIdentifier)?;
        let kind = CredentialKind::from_prefix(prefix).ok_or(CredentialError::InvalidIdentifier)?;
        Self::new(kind, key)
    }

    /// Returns the credential namespace.
    #[must_use]
    pub const fn kind(&self) -> CredentialKind {
        self.kind
    }

    /// Returns the domain identifier without its namespace.
    #[must_use]
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Returns the stable account name used by the operating-system store.
    #[must_use]
    pub fn account_name(&self) -> String {
        format!("{}:{}", self.kind.prefix(), self.key)
    }
}

impl Serialize for CredentialId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.account_name())
    }
}

impl<'de> Deserialize<'de> for CredentialId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(&value).map_err(D::Error::custom)
    }
}

/// Owned secret text that is never serializable or printable and clears on drop.
///
/// Secret persistence is only available through [`CredentialStore`]; JSON,
/// Base64, and plaintext file fallbacks are intentionally not representable.
///
/// ```compile_fail
/// use codez_storage::SecretValue;
///
/// let secret = SecretValue::new("fixture-secret").expect("fixture is non-empty");
/// let _serialized = serde_json::to_string(&secret);
/// ```
pub struct SecretValue(String);

impl SecretValue {
    /// Wraps non-empty secret text for transfer to a credential adapter.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialError::EmptySecret`] when no secret was supplied.
    pub fn new(value: impl Into<String>) -> Result<Self, CredentialError> {
        let value = value.into();
        if value.is_empty() {
            return Err(CredentialError::EmptySecret);
        }
        Ok(Self(value))
    }

    /// Exposes the secret to the narrow adapter call that needs plaintext.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        &self.0
    }

    fn from_stored(value: String, id: &CredentialId) -> Result<Self, CredentialError> {
        if value.is_empty() {
            Err(CredentialError::Corrupt { id: id.clone() })
        } else {
            Ok(Self(value))
        }
    }
}

impl Drop for SecretValue {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

/// Stable failures returned by secure credential stores.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum CredentialError {
    /// A credential namespace, service, or domain key is unsafe or unsupported.
    #[error("credential identifier is invalid")]
    InvalidIdentifier,
    /// Empty values are not persisted as configured credentials.
    #[error("credential secret must not be empty")]
    EmptySecret,
    /// No credential exists for this identity.
    #[error("credential was not found: {id:?}")]
    NotFound { id: CredentialId },
    /// The keychain is locked, read-only, or denied access by the operating system.
    #[error("credential store denied access while attempting to {operation}")]
    AccessDenied { operation: &'static str },
    /// The operating-system credential service is unavailable.
    #[error("credential store is unavailable while attempting to {operation}")]
    Unavailable { operation: &'static str },
    /// Stored bytes cannot be decoded unambiguously as the requested credential.
    #[error("stored credential is corrupt: {id:?}")]
    Corrupt { id: CredentialId },
    /// The secret exceeds the selected platform's secure-storage limit.
    #[error("credential secret exceeds the platform length limit of {platform_limit}")]
    SecretTooLarge { platform_limit: u32 },
}

/// Blocking port for an operating-system credential store.
///
/// Implementations serialize access when required by the platform. Async callers
/// must invoke these methods from a bounded blocking worker.
pub trait CredentialStore: Send + Sync {
    /// Reads one secret without exposing it through serialization or debug output.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialError`] for missing, inaccessible, unavailable, or
    /// corrupt credentials.
    fn get(&self, id: &CredentialId) -> Result<SecretValue, CredentialError>;

    /// Stores or replaces one non-empty secret.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialError`] when secure storage is unavailable, denied,
    /// or rejects the identifier or value.
    fn set(&self, id: &CredentialId, value: &SecretValue) -> Result<(), CredentialError>;

    /// Deletes one credential.
    ///
    /// # Errors
    ///
    /// Returns [`CredentialError::NotFound`] when the entry does not exist and
    /// another [`CredentialError`] when secure storage cannot be accessed.
    fn delete(&self, id: &CredentialId) -> Result<(), CredentialError>;
}

fn valid_key(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_CREDENTIAL_KEY_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::{CredentialError, CredentialId, CredentialKind, SecretValue};

    #[test]
    fn credential_id_serialization_round_trips_the_stable_account_name() {
        let id = CredentialId::new(CredentialKind::ProviderApiKey, "provider-1")
            .expect("fixture credential id must be valid");
        let encoded = serde_json::to_string(&id).expect("credential id must serialize");

        assert_eq!(
            serde_json::from_str::<CredentialId>(&encoded).expect("credential id must deserialize"),
            id
        );
    }

    #[test]
    fn credential_id_deserialization_rejects_path_and_namespace_injection() {
        let result = serde_json::from_str::<CredentialId>(r#""unknown:../provider""#);

        assert!(result.is_err());
    }

    #[test]
    fn secret_value_rejects_an_empty_configured_credential() {
        let result = SecretValue::new(String::new());

        assert!(matches!(result, Err(CredentialError::EmptySecret)));
    }
}
