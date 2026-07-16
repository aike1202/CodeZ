use std::{collections::BTreeSet, future::Future, path::PathBuf, pin::Pin, sync::Arc};

use codez_core::{AppError, AtomicPersistence};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};
use thiserror::Error;
use tokio::sync::Mutex;
use zeroize::Zeroizing;

const SECRET_INDEX_SCHEMA_VERSION: u16 = 1;
const MAX_SECRET_INDEX_BYTES: usize = 1024 * 1024;
const MAX_SECRET_KEYS: usize = 4096;
const MAX_SECRET_KEY_BYTES: usize = 128;

/// Validated non-secret name of one MCP operating-system credential.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct McpSecretKey(String);

impl McpSecretKey {
    /// Parses an MCP secret key accepted by `${secret:...}` expressions.
    ///
    /// # Errors
    ///
    /// Returns [`McpSecretError::InvalidKey`] for empty, oversized, or unsafe keys.
    pub fn parse(value: impl Into<String>) -> Result<Self, McpSecretError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_SECRET_KEY_BYTES
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(McpSecretError::InvalidKey);
        }
        Ok(Self(value))
    }

    /// Returns the non-secret domain key.
    #[must_use]
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl Serialize for McpSecretKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for McpSecretKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = String::deserialize(deserializer)?;
        Self::parse(value).map_err(D::Error::custom)
    }
}

/// Owned secret text that cannot be serialized, cloned, or printed.
pub struct McpSecretValue(Zeroizing<String>);

impl McpSecretValue {
    /// Wraps one non-empty plaintext value for narrow transfer to a keychain adapter.
    ///
    /// # Errors
    ///
    /// Returns [`McpSecretError::EmptyValue`] when `value` is empty.
    pub fn new(value: impl Into<String>) -> Result<Self, McpSecretError> {
        let value = value.into();
        if value.is_empty() {
            return Err(McpSecretError::EmptyValue);
        }
        Ok(Self(Zeroizing::new(value)))
    }

    /// Exposes plaintext only to the credential adapter performing the OS write.
    #[must_use]
    pub fn expose_secret(&self) -> &str {
        self.0.as_str()
    }
}

/// Stable failures returned by an injected MCP credential backend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum McpSecretStoreError {
    #[error("MCP secret was not found")]
    NotFound,
    #[error("MCP credential store denied access")]
    AccessDenied,
    #[error("MCP credential store is unavailable")]
    Unavailable,
    #[error("stored MCP credential is corrupt")]
    Corrupt,
    #[error("MCP credential is too large for the operating-system store")]
    SecretTooLarge,
    #[error("MCP credential identifier is invalid")]
    InvalidIdentifier,
    #[error("MCP credential value is empty")]
    EmptySecret,
}

/// Boxed asynchronous result used by the MCP secret-store boundary.
pub type SecretFuture<'a, T> =
    Pin<Box<dyn Future<Output = Result<T, McpSecretStoreError>> + Send + 'a>>;

/// Asynchronous adapter boundary for operating-system MCP credentials.
pub trait McpSecretStore: Send + Sync {
    /// Reads a secret, returning `None` when the keychain entry does not exist.
    fn get(&self, key: McpSecretKey) -> SecretFuture<'_, Option<McpSecretValue>>;

    /// Stores or replaces a secret value.
    fn set(&self, key: McpSecretKey, value: McpSecretValue) -> SecretFuture<'_, ()>;

    /// Removes a secret. Implementations treat an absent entry as success.
    fn delete(&self, key: McpSecretKey) -> SecretFuture<'_, ()>;
}

/// Typed failures from MCP secret indexing and compensated keychain mutations.
#[derive(Debug, Error)]
pub enum McpSecretError {
    #[error("MCP secret key is invalid")]
    InvalidKey,
    #[error("MCP secret values cannot be empty")]
    EmptyValue,
    #[error("MCP secret-key index exceeds the 1 MiB limit")]
    IndexTooLarge,
    #[error("MCP secret-key index is not valid JSON")]
    InvalidIndex {
        #[source]
        source: serde_json::Error,
    },
    #[error("MCP secret-key index schema version {version} is unsupported")]
    UnsupportedIndexVersion { version: u16 },
    #[error("MCP secret-key index could not be encoded")]
    SerializeIndex {
        #[source]
        source: serde_json::Error,
    },
    #[error("MCP secret-key index persistence failed")]
    Persistence {
        #[source]
        source: AppError,
    },
    #[error(transparent)]
    Store(#[from] McpSecretStoreError),
    #[error("MCP credential compensation failed after {operation}")]
    CompensationFailed { operation: &'static str },
}

impl From<McpSecretError> for AppError {
    fn from(error: McpSecretError) -> Self {
        match error {
            McpSecretError::InvalidKey | McpSecretError::EmptyValue => {
                AppError::validation(error.to_string())
            }
            McpSecretError::Persistence { source } => source,
            McpSecretError::Store(McpSecretStoreError::AccessDenied) => {
                AppError::permission_denied("The operating-system credential store denied access")
            }
            McpSecretError::Store(McpSecretStoreError::NotFound) => {
                AppError::not_found("The MCP secret is not configured")
            }
            McpSecretError::Store(McpSecretStoreError::Unavailable) => AppError::external(
                "The operating-system credential store is unavailable",
                "MCP keychain adapter unavailable",
                true,
            ),
            McpSecretError::Store(
                McpSecretStoreError::InvalidIdentifier | McpSecretStoreError::EmptySecret,
            ) => AppError::validation("The MCP secret is invalid"),
            McpSecretError::Store(McpSecretStoreError::SecretTooLarge) => {
                AppError::validation("The MCP secret is too large for secure storage")
            }
            McpSecretError::Store(McpSecretStoreError::Corrupt) => AppError::storage(
                "The stored MCP credential is corrupt",
                "MCP keychain entry could not be decoded",
                false,
            ),
            McpSecretError::IndexTooLarge
            | McpSecretError::InvalidIndex { .. }
            | McpSecretError::UnsupportedIndexVersion { .. }
            | McpSecretError::SerializeIndex { .. } => AppError::storage(
                "The MCP secret-key index could not be loaded or saved",
                error.to_string(),
                false,
            ),
            McpSecretError::CompensationFailed { operation } => AppError::internal(format!(
                "MCP credential compensation failed after {operation}"
            )),
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SecretIndexDocument {
    #[serde(default)]
    schema_version: u16,
    #[serde(default)]
    keys: BTreeSet<McpSecretKey>,
}

/// Serializes MCP credential mutations and keeps only non-secret key metadata on disk.
pub struct McpSecretService {
    persistence: Arc<dyn AtomicPersistence>,
    index_path: PathBuf,
    store: Arc<dyn McpSecretStore>,
    mutation_lock: Mutex<()>,
}

impl std::fmt::Debug for McpSecretService {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpSecretService")
            .field("index_path", &self.index_path)
            .finish_non_exhaustive()
    }
}

impl McpSecretService {
    /// Creates a secret service over an OS credential adapter and atomic metadata store.
    #[must_use]
    pub fn new(
        persistence: Arc<dyn AtomicPersistence>,
        index_path: PathBuf,
        store: Arc<dyn McpSecretStore>,
    ) -> Self {
        Self {
            persistence,
            index_path,
            store,
            mutation_lock: Mutex::new(()),
        }
    }

    /// Lists keys that currently resolve in secure storage.
    ///
    /// Referenced keys are probed even when a legacy migration predates the
    /// non-secret index. Missing/stale index entries are removed atomically.
    ///
    /// # Errors
    ///
    /// Returns [`McpSecretError`] when the index or credential store cannot be
    /// read consistently.
    pub async fn list_keys(
        &self,
        referenced_keys: &BTreeSet<McpSecretKey>,
    ) -> Result<Vec<McpSecretKey>, McpSecretError> {
        let _guard = self.mutation_lock.lock().await;
        let document = self.load_index().await?;
        let indexed_keys = document.keys;
        let mut candidates = indexed_keys.clone();
        candidates.extend(referenced_keys.iter().cloned());
        if candidates.len() > MAX_SECRET_KEYS {
            return Err(McpSecretError::IndexTooLarge);
        }

        let mut configured = BTreeSet::new();
        for key in candidates {
            if self.store.get(key.clone()).await?.is_some() {
                configured.insert(key);
            }
        }
        if document.schema_version != SECRET_INDEX_SCHEMA_VERSION || configured != indexed_keys {
            self.persist_index(&configured).await?;
        }
        Ok(configured.into_iter().collect())
    }

    /// Stores one secret and adds its key to the non-secret index atomically.
    ///
    /// If index persistence fails, the previous keychain value is restored. A
    /// failed rollback is surfaced as [`McpSecretError::CompensationFailed`].
    ///
    /// # Errors
    ///
    /// Returns validation, keychain, index, or compensation failures.
    pub async fn set(
        &self,
        key: McpSecretKey,
        value: McpSecretValue,
    ) -> Result<(), McpSecretError> {
        let _guard = self.mutation_lock.lock().await;
        let mut document = self.load_index().await?;
        let previous = self.store.get(key.clone()).await?;
        self.store.set(key.clone(), value).await?;
        document.keys.insert(key.clone());
        if let Err(source) = self.persist_index(&document.keys).await {
            if self.restore_after_failed_set(key, previous).await.is_err() {
                return Err(McpSecretError::CompensationFailed {
                    operation: "secret index write",
                });
            }
            return Err(source);
        }
        Ok(())
    }

    /// Deletes one secret and removes its non-secret index entry atomically.
    ///
    /// If index persistence fails after keychain deletion, the previous secret
    /// is restored before returning the index error.
    ///
    /// # Errors
    ///
    /// Returns keychain, index, or compensation failures.
    pub async fn delete(&self, key: McpSecretKey) -> Result<(), McpSecretError> {
        let _guard = self.mutation_lock.lock().await;
        let mut document = self.load_index().await?;
        let previous = self.store.get(key.clone()).await?;
        if previous.is_some() {
            self.store.delete(key.clone()).await?;
        }
        document.keys.remove(&key);
        if let Err(source) = self.persist_index(&document.keys).await {
            if let Some(previous) = previous
                && self.store.set(key, previous).await.is_err()
            {
                return Err(McpSecretError::CompensationFailed {
                    operation: "secret index delete",
                });
            }
            return Err(source);
        }
        Ok(())
    }

    async fn restore_after_failed_set(
        &self,
        key: McpSecretKey,
        previous: Option<McpSecretValue>,
    ) -> Result<(), McpSecretStoreError> {
        match previous {
            Some(previous) => self.store.set(key, previous).await,
            None => self.store.delete(key).await,
        }
    }

    async fn load_index(&self) -> Result<SecretIndexDocument, McpSecretError> {
        let Some(bytes) = self
            .persistence
            .read(&self.index_path)
            .await
            .map_err(|source| McpSecretError::Persistence { source })?
        else {
            return Ok(SecretIndexDocument::default());
        };
        if bytes.len() > MAX_SECRET_INDEX_BYTES {
            return Err(McpSecretError::IndexTooLarge);
        }
        let document = serde_json::from_slice::<SecretIndexDocument>(&bytes)
            .map_err(|source| McpSecretError::InvalidIndex { source })?;
        if document.schema_version > SECRET_INDEX_SCHEMA_VERSION {
            return Err(McpSecretError::UnsupportedIndexVersion {
                version: document.schema_version,
            });
        }
        if document.keys.len() > MAX_SECRET_KEYS {
            return Err(McpSecretError::IndexTooLarge);
        }
        Ok(document)
    }

    async fn persist_index(&self, keys: &BTreeSet<McpSecretKey>) -> Result<(), McpSecretError> {
        if keys.len() > MAX_SECRET_KEYS {
            return Err(McpSecretError::IndexTooLarge);
        }
        let document = SecretIndexDocument {
            schema_version: SECRET_INDEX_SCHEMA_VERSION,
            keys: keys.clone(),
        };
        let bytes = serde_json::to_vec_pretty(&document)
            .map_err(|source| McpSecretError::SerializeIndex { source })?;
        if bytes.len() > MAX_SECRET_INDEX_BYTES {
            return Err(McpSecretError::IndexTooLarge);
        }
        self.persistence
            .replace(&self.index_path, &bytes)
            .await
            .map_err(|source| McpSecretError::Persistence { source })
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        path::{Path, PathBuf},
        sync::{
            Arc,
            atomic::{AtomicBool, Ordering},
        },
    };

    use codez_core::{AppError, AtomicCreateOutcome, AtomicPersistence, PortFuture};
    use tokio::sync::Mutex;

    use super::{
        MAX_SECRET_INDEX_BYTES, McpSecretError, McpSecretKey, McpSecretService, McpSecretStore,
        McpSecretStoreError, McpSecretValue, SECRET_INDEX_SCHEMA_VERSION, SecretFuture,
    };

    #[derive(Default)]
    struct MemoryPersistence {
        entries: Mutex<BTreeMap<PathBuf, Vec<u8>>>,
        fail_next_replace: AtomicBool,
    }

    impl MemoryPersistence {
        async fn insert(&self, path: PathBuf, bytes: Vec<u8>) {
            self.entries.lock().await.insert(path, bytes);
        }

        async fn bytes(&self, path: &Path) -> Option<Vec<u8>> {
            self.entries.lock().await.get(path).cloned()
        }

        fn fail_next_replace(&self) {
            self.fail_next_replace.store(true, Ordering::Release);
        }
    }

    impl AtomicPersistence for MemoryPersistence {
        fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
            Box::pin(async move { Ok(self.entries.lock().await.get(path).cloned()) })
        }

        fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                if self.fail_next_replace.swap(false, Ordering::AcqRel) {
                    return Err(AppError::storage(
                        "The in-memory persistence write failed",
                        "fault injection",
                        false,
                    ));
                }
                self.entries
                    .lock()
                    .await
                    .insert(path.to_path_buf(), bytes.to_vec());
                Ok(())
            })
        }

        fn create_no_clobber<'a>(
            &'a self,
            path: &'a Path,
            bytes: &'a [u8],
        ) -> PortFuture<'a, AtomicCreateOutcome> {
            Box::pin(async move {
                let mut entries = self.entries.lock().await;
                match entries.get(path) {
                    Some(existing) if existing == bytes => Ok(AtomicCreateOutcome::Reused),
                    Some(_) => Err(AppError::conflict(
                        "The in-memory persistence entry already exists with different bytes",
                    )),
                    None => {
                        entries.insert(path.to_path_buf(), bytes.to_vec());
                        Ok(AtomicCreateOutcome::Created)
                    }
                }
            })
        }

        fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
            Box::pin(async move {
                self.entries
                    .lock()
                    .await
                    .entry(path.to_path_buf())
                    .or_default()
                    .extend_from_slice(bytes);
                Ok(())
            })
        }

        fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
            Box::pin(async move { Ok(self.entries.lock().await.remove(path).is_some()) })
        }
    }

    #[derive(Default)]
    struct MemorySecretStore {
        values: Mutex<BTreeMap<McpSecretKey, String>>,
    }

    impl MemorySecretStore {
        async fn seed(&self, key: McpSecretKey, value: &str) {
            self.values.lock().await.insert(key, value.to_string());
        }

        async fn value(&self, key: &McpSecretKey) -> Option<String> {
            self.values.lock().await.get(key).cloned()
        }
    }

    impl McpSecretStore for MemorySecretStore {
        fn get(&self, key: McpSecretKey) -> SecretFuture<'_, Option<McpSecretValue>> {
            Box::pin(async move {
                self.values
                    .lock()
                    .await
                    .get(&key)
                    .cloned()
                    .map(McpSecretValue::new)
                    .transpose()
                    .map_err(|_| McpSecretStoreError::Corrupt)
            })
        }

        fn set(&self, key: McpSecretKey, value: McpSecretValue) -> SecretFuture<'_, ()> {
            Box::pin(async move {
                self.values
                    .lock()
                    .await
                    .insert(key, value.expose_secret().to_string());
                Ok(())
            })
        }

        fn delete(&self, key: McpSecretKey) -> SecretFuture<'_, ()> {
            Box::pin(async move {
                self.values.lock().await.remove(&key);
                Ok(())
            })
        }
    }

    fn key(value: &str) -> McpSecretKey {
        McpSecretKey::parse(value).expect("test secret key should be valid")
    }

    fn value(secret: &str) -> McpSecretValue {
        McpSecretValue::new(secret).expect("test secret value should be valid")
    }

    fn service(
        persistence: Arc<MemoryPersistence>,
        index_path: PathBuf,
        store: Arc<MemorySecretStore>,
    ) -> McpSecretService {
        McpSecretService::new(persistence, index_path, store)
    }

    #[tokio::test]
    async fn set_and_delete_keep_only_key_metadata_in_the_secret_index() {
        let persistence = Arc::new(MemoryPersistence::default());
        let store = Arc::new(MemorySecretStore::default());
        let index_path = PathBuf::from("mcp-secret-index.json");
        let service = service(
            Arc::clone(&persistence),
            index_path.clone(),
            Arc::clone(&store),
        );
        let secret_key = key("github.token");

        service
            .set(secret_key.clone(), value("credential-value"))
            .await
            .expect("secret write should update the key index");
        let listed = service
            .list_keys(&Default::default())
            .await
            .expect("stored key should resolve");
        let index = String::from_utf8(
            persistence
                .bytes(&index_path)
                .await
                .expect("secret index should exist"),
        )
        .expect("secret index is UTF-8 JSON");

        assert_eq!(listed, vec![secret_key.clone()]);
        assert!(!index.contains("credential-value"));
        service
            .delete(secret_key.clone())
            .await
            .expect("secret deletion should update the key index");
        let listed_after_delete = service
            .list_keys(&Default::default())
            .await
            .expect("empty key index should remain readable");

        assert_eq!(store.value(&secret_key).await, None);
        assert!(listed_after_delete.is_empty());
    }

    #[tokio::test]
    async fn failed_index_write_after_set_restores_the_previous_keychain_value() {
        let persistence = Arc::new(MemoryPersistence::default());
        let store = Arc::new(MemorySecretStore::default());
        let service = service(
            Arc::clone(&persistence),
            PathBuf::from("mcp-secret-index.json"),
            Arc::clone(&store),
        );
        let secret_key = key("github.token");
        store.seed(secret_key.clone(), "previous-value").await;
        persistence.fail_next_replace();

        let result = service
            .set(secret_key.clone(), value("replacement-value"))
            .await;

        assert!(matches!(result, Err(McpSecretError::Persistence { .. })));
        assert_eq!(
            store.value(&secret_key).await,
            Some("previous-value".to_string())
        );
    }

    #[tokio::test]
    async fn failed_index_write_after_delete_restores_the_previous_keychain_value() {
        let persistence = Arc::new(MemoryPersistence::default());
        let store = Arc::new(MemorySecretStore::default());
        let service = service(
            Arc::clone(&persistence),
            PathBuf::from("mcp-secret-index.json"),
            Arc::clone(&store),
        );
        let secret_key = key("github.token");
        service
            .set(secret_key.clone(), value("previous-value"))
            .await
            .expect("initial secret write should succeed");
        persistence.fail_next_replace();

        let result = service.delete(secret_key.clone()).await;

        assert!(matches!(result, Err(McpSecretError::Persistence { .. })));
        assert_eq!(
            store.value(&secret_key).await,
            Some("previous-value".to_string())
        );
    }

    #[tokio::test]
    async fn list_keys_discovers_migrated_referenced_credentials_and_repairs_the_index() {
        let persistence = Arc::new(MemoryPersistence::default());
        let store = Arc::new(MemorySecretStore::default());
        let index_path = PathBuf::from("mcp-secret-index.json");
        let service = service(
            Arc::clone(&persistence),
            index_path.clone(),
            Arc::clone(&store),
        );
        let migrated_key = key("migrated.token");
        store
            .seed(migrated_key.clone(), "legacy-keychain-value")
            .await;

        let listed = service
            .list_keys(&std::collections::BTreeSet::from([migrated_key.clone()]))
            .await
            .expect("migrated referenced credentials should be discoverable");
        let index = String::from_utf8(
            persistence
                .bytes(&index_path)
                .await
                .expect("index should be written after migration discovery"),
        )
        .expect("secret index is UTF-8 JSON");

        assert_eq!(listed, vec![migrated_key]);
        assert!(index.contains("migrated.token"));
    }

    #[tokio::test]
    async fn list_keys_rejects_an_index_larger_than_one_mebibyte() {
        let persistence = Arc::new(MemoryPersistence::default());
        let index_path = PathBuf::from("mcp-secret-index.json");
        persistence
            .insert(index_path.clone(), vec![b'x'; MAX_SECRET_INDEX_BYTES + 1])
            .await;
        let service = service(
            persistence,
            index_path,
            Arc::new(MemorySecretStore::default()),
        );

        let result = service.list_keys(&Default::default()).await;

        assert!(matches!(result, Err(McpSecretError::IndexTooLarge)));
    }

    #[tokio::test]
    async fn list_keys_rejects_a_newer_secret_index_schema() {
        let persistence = Arc::new(MemoryPersistence::default());
        let index_path = PathBuf::from("mcp-secret-index.json");
        let document = format!(
            r#"{{"schemaVersion":{},"keys":[]}}"#,
            SECRET_INDEX_SCHEMA_VERSION + 1
        );
        persistence
            .insert(index_path.clone(), document.into_bytes())
            .await;
        let service = service(
            persistence,
            index_path,
            Arc::new(MemorySecretStore::default()),
        );

        let result = service.list_keys(&Default::default()).await;

        assert!(matches!(
            result,
            Err(McpSecretError::UnsupportedIndexVersion { .. })
        ));
    }
}
