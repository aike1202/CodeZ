use std::{sync::Arc, time::Duration};

use async_trait::async_trait;
use oauth2::TokenResponse;
use reqwest_013::{Client, redirect::Policy};
use rmcp::transport::auth::{
    AuthError, AuthorizationCallback, AuthorizationManager, CredentialStore, OAuthClientConfig,
    StoredCredentials,
};
use thiserror::Error;
use url::Url;

use crate::{McpOAuthConfig, McpSecretKey, McpSecretStore, McpSecretStoreError, McpSecretValue};

const OAUTH_SECRET_KEY_PREFIX: &str = "mcp.oauth.";
const SHA256_FINGERPRINT_BYTES: usize = 64;
const MAX_STORED_CREDENTIAL_BYTES: usize = 256 * 1024;
const OAUTH_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

/// Errors from CodeZ's OAuth persistence and protocol boundary.
#[derive(Debug, Clone, Copy, Error, PartialEq, Eq)]
pub enum McpOAuthError {
    #[error("the MCP OAuth credential identity is invalid")]
    InvalidCredentialIdentity,
    #[error("the stored MCP OAuth credential is invalid")]
    InvalidStoredCredential,
    #[error("the stored MCP OAuth credential exceeds the allowed size")]
    StoredCredentialTooLarge,
    #[error("MCP OAuth authorization is required")]
    AuthorizationRequired,
    #[error("the MCP OAuth endpoint is invalid")]
    InvalidEndpoint,
    #[error("the MCP OAuth callback URL is invalid")]
    InvalidCallbackUrl,
    #[error("the MCP OAuth authorization URL is invalid")]
    InvalidAuthorizationUrl,
    #[error("the MCP OAuth protocol operation failed")]
    Protocol,
    #[error("MCP OAuth token revocation failed")]
    Revocation,
    #[error("the operating-system credential store could not serve MCP OAuth")]
    CredentialStore,
}

/// Credential adapter that stores the complete rmcp OAuth record only in the
/// operating-system credential store. OAuth entries intentionally bypass the
/// MCP secret index so token metadata cannot leak into application JSON.
#[derive(Clone)]
pub struct McpOAuthCredentialStore {
    key: McpSecretKey,
    secrets: Arc<dyn McpSecretStore>,
}

impl std::fmt::Debug for McpOAuthCredentialStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpOAuthCredentialStore")
            .field("key", &self.key)
            .finish_non_exhaustive()
    }
}

impl McpOAuthCredentialStore {
    /// Creates a credential adapter scoped to one canonical MCP configuration fingerprint.
    ///
    /// # Errors
    ///
    /// Returns [`McpOAuthError::InvalidCredentialIdentity`] unless `fingerprint`
    /// is a SHA-256 configuration fingerprint.
    pub fn new(fingerprint: &str, secrets: Arc<dyn McpSecretStore>) -> Result<Self, McpOAuthError> {
        if fingerprint.len() != SHA256_FINGERPRINT_BYTES
            || !fingerprint.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(McpOAuthError::InvalidCredentialIdentity);
        }
        let key = McpSecretKey::parse(format!("{OAUTH_SECRET_KEY_PREFIX}{fingerprint}"))
            .map_err(|_| McpOAuthError::InvalidCredentialIdentity)?;
        Ok(Self { key, secrets })
    }

    /// Returns the non-secret credential identity used by the OS keychain.
    #[must_use]
    pub fn key(&self) -> &McpSecretKey {
        &self.key
    }

    async fn load_stored(&self) -> Result<Option<StoredCredentials>, McpOAuthError> {
        let Some(value) = self
            .secrets
            .get(self.key.clone())
            .await
            .map_err(map_credential_store_error)?
        else {
            return Ok(None);
        };
        let encoded = value.expose_secret();
        if encoded.len() > MAX_STORED_CREDENTIAL_BYTES {
            return Err(McpOAuthError::StoredCredentialTooLarge);
        }
        serde_json::from_str(encoded)
            .map(Some)
            .map_err(|_| McpOAuthError::InvalidStoredCredential)
    }

    async fn save_stored(&self, credentials: StoredCredentials) -> Result<(), McpOAuthError> {
        let encoded = serde_json::to_string(&credentials).map_err(|_| McpOAuthError::Protocol)?;
        if encoded.len() > MAX_STORED_CREDENTIAL_BYTES {
            return Err(McpOAuthError::StoredCredentialTooLarge);
        }
        let value = McpSecretValue::new(encoded).map_err(|_| McpOAuthError::Protocol)?;
        self.secrets
            .set(self.key.clone(), value)
            .await
            .map_err(map_credential_store_error)
    }

    async fn clear_stored(&self) -> Result<(), McpOAuthError> {
        self.secrets
            .delete(self.key.clone())
            .await
            .map_err(map_credential_store_error)
    }
}

#[async_trait]
impl CredentialStore for McpOAuthCredentialStore {
    async fn load(&self) -> Result<Option<StoredCredentials>, AuthError> {
        self.load_stored().await.map_err(auth_store_error)
    }

    async fn save(&self, credentials: StoredCredentials) -> Result<(), AuthError> {
        self.save_stored(credentials)
            .await
            .map_err(auth_store_error)
    }

    async fn clear(&self) -> Result<(), AuthError> {
        self.clear_stored().await.map_err(auth_store_error)
    }
}

/// OAuth client bound to a single MCP server configuration fingerprint.
#[derive(Clone, Debug)]
pub struct McpOAuthClient {
    endpoint: Url,
    config: McpOAuthConfig,
    credentials: McpOAuthCredentialStore,
}

impl McpOAuthClient {
    /// Creates a client for a configured remote MCP OAuth flow.
    ///
    /// # Errors
    ///
    /// Returns [`McpOAuthError::InvalidEndpoint`] when the resource URL is not
    /// HTTPS or a loopback HTTP endpoint without embedded credentials.
    pub fn new(
        endpoint: &str,
        fingerprint: &str,
        config: McpOAuthConfig,
        secrets: Arc<dyn McpSecretStore>,
    ) -> Result<Self, McpOAuthError> {
        let endpoint = Url::parse(endpoint).map_err(|_| McpOAuthError::InvalidEndpoint)?;
        validate_remote_url(&endpoint).map_err(|_| McpOAuthError::InvalidEndpoint)?;
        let credentials = McpOAuthCredentialStore::new(fingerprint, secrets)?;
        Ok(Self {
            endpoint,
            config,
            credentials,
        })
    }

    /// Starts PKCE authorization and returns the discovered URL and callback state.
    ///
    /// The caller owns browser launch and callback listening. The returned state
    /// validates the callback's CSRF token and optional RFC 9207 issuer before
    /// persisting any tokens.
    pub async fn start_authorization(
        &self,
        callback_url: &str,
        client_name: &str,
    ) -> Result<McpOAuthAuthorization, McpOAuthError> {
        let callback = Url::parse(callback_url).map_err(|_| McpOAuthError::InvalidCallbackUrl)?;
        validate_callback_url(&callback)?;

        let mut manager = self.new_manager().await?;
        let metadata = manager.discover_metadata().await.map_err(protocol_error)?;
        manager.set_metadata(metadata);

        let configured_scopes = self.configured_scopes();
        let selected_scopes = manager.select_scopes(None, &configured_scopes);
        let scope_refs = selected_scopes
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>();

        if let Some(client_id) = self.config.client_id.as_deref() {
            let config = OAuthClientConfig::new(client_id, callback.as_str());
            manager.configure_client(config).map_err(protocol_error)?;
        } else {
            let config = manager
                .register_client(client_name, callback.as_str(), &scope_refs)
                .await
                .map_err(protocol_error)?;
            manager.configure_client(config).map_err(protocol_error)?;
        }

        let authorization_url = manager
            .get_authorization_url(&scope_refs)
            .await
            .map_err(protocol_error)?;
        let authorization_url =
            Url::parse(&authorization_url).map_err(|_| McpOAuthError::InvalidAuthorizationUrl)?;
        validate_remote_url(&authorization_url)
            .map_err(|_| McpOAuthError::InvalidAuthorizationUrl)?;

        Ok(McpOAuthAuthorization {
            manager,
            authorization_url,
        })
    }

    /// Loads a token and performs rmcp's proactive refresh when required.
    pub async fn access_token(&self) -> Result<String, McpOAuthError> {
        if self.credentials.load_stored().await?.is_none() {
            return Err(McpOAuthError::AuthorizationRequired);
        }
        let mut manager = self.new_manager().await?;
        if !manager
            .initialize_from_store()
            .await
            .map_err(protocol_error)?
        {
            return Err(McpOAuthError::AuthorizationRequired);
        }
        manager.get_access_token().await.map_err(auth_error)
    }

    /// Refreshes the stored token explicitly.
    pub async fn refresh(&self) -> Result<(), McpOAuthError> {
        if self.credentials.load_stored().await?.is_none() {
            return Err(McpOAuthError::AuthorizationRequired);
        }
        let mut manager = self.new_manager().await?;
        if !manager
            .initialize_from_store()
            .await
            .map_err(protocol_error)?
        {
            return Err(McpOAuthError::AuthorizationRequired);
        }
        manager
            .refresh_token()
            .await
            .map(|_| ())
            .map_err(auth_error)
    }

    /// Revokes refresh and access tokens when metadata advertises a revocation endpoint,
    /// then clears the OS credential entry even when revocation itself fails.
    pub async fn logout(&self) -> Result<(), McpOAuthError> {
        let credentials = self.credentials.load_stored().await?;
        let revoke_result = match credentials {
            Some(credentials) => self.revoke_stored_tokens(credentials).await,
            None => Ok(()),
        };
        let clear_result = self.credentials.clear_stored().await;
        clear_result?;
        revoke_result
    }

    async fn new_manager(&self) -> Result<AuthorizationManager, McpOAuthError> {
        let mut manager = AuthorizationManager::new(self.endpoint.clone())
            .await
            .map_err(protocol_error)?;
        manager.set_credential_store(self.credentials.clone());
        Ok(manager)
    }

    fn configured_scopes(&self) -> Vec<&str> {
        self.config
            .scope
            .as_deref()
            .map(str::split_whitespace)
            .into_iter()
            .flatten()
            .filter(|scope| !scope.is_empty())
            .collect()
    }

    async fn revoke_stored_tokens(
        &self,
        credentials: StoredCredentials,
    ) -> Result<(), McpOAuthError> {
        let manager = self.new_manager().await?;
        let metadata = manager.discover_metadata().await.map_err(protocol_error)?;
        let Some(raw_endpoint) = metadata
            .additional_fields
            .get("revocation_endpoint")
            .and_then(serde_json::Value::as_str)
        else {
            return Ok(());
        };
        let endpoint = Url::parse(raw_endpoint).map_err(|_| McpOAuthError::Revocation)?;
        validate_remote_url(&endpoint).map_err(|_| McpOAuthError::Revocation)?;

        let Some(tokens) = credentials.token_response else {
            return Ok(());
        };
        let client = Client::builder()
            .redirect(Policy::none())
            .timeout(OAUTH_REQUEST_TIMEOUT)
            .build()
            .map_err(|_| McpOAuthError::Revocation)?;
        let mut first_error = None;
        if let Some(refresh) = tokens.refresh_token()
            && revoke_token(&client, &endpoint, refresh.secret(), "refresh_token")
                .await
                .is_err()
        {
            first_error = Some(McpOAuthError::Revocation);
        }
        if revoke_token(
            &client,
            &endpoint,
            tokens.access_token().secret(),
            "access_token",
        )
        .await
        .is_err()
            && first_error.is_none()
        {
            first_error = Some(McpOAuthError::Revocation);
        }
        first_error.map_or(Ok(()), Err)
    }
}

/// An authorization transaction that owns the PKCE and CSRF state until callback completion.
pub struct McpOAuthAuthorization {
    manager: AuthorizationManager,
    authorization_url: Url,
}

impl McpOAuthAuthorization {
    /// Returns the discovered authorization URL that may be opened externally.
    #[must_use]
    pub fn authorization_url(&self) -> &Url {
        &self.authorization_url
    }

    /// Validates and exchanges one OAuth redirect callback.
    pub async fn handle_callback_url(&self, callback_url: &str) -> Result<(), McpOAuthError> {
        let callback =
            AuthorizationCallback::from_redirect_url(callback_url).map_err(auth_error)?;
        self.manager
            .exchange_code_for_token_with_issuer(
                &callback.code,
                &callback.csrf_token,
                callback.issuer.as_deref(),
            )
            .await
            .map(|_| ())
            .map_err(auth_error)
    }
}

async fn revoke_token(
    client: &Client,
    endpoint: &Url,
    token: &str,
    token_type_hint: &str,
) -> Result<(), McpOAuthError> {
    let response = client
        .post(endpoint.clone())
        .form(&[("token", token), ("token_type_hint", token_type_hint)])
        .send()
        .await
        .map_err(|_| McpOAuthError::Revocation)?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(McpOAuthError::Revocation)
    }
}

fn validate_remote_url(url: &Url) -> Result<(), ()> {
    if !matches!(url.scheme(), "https" | "http")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(());
    }
    if url.scheme() == "https" {
        return Ok(());
    }
    let Some(host) = url.host_str() else {
        return Err(());
    };
    is_loopback_host(host).then_some(()).ok_or(())
}

fn validate_callback_url(url: &Url) -> Result<(), McpOAuthError> {
    if url.scheme() != "http"
        || url.host_str() != Some("127.0.0.1")
        || url.path() != "/oauth/callback"
        || url.query().is_some()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err(McpOAuthError::InvalidCallbackUrl);
    }
    Ok(())
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == "localhost"
        || host.ends_with(".localhost")
        || matches!(host.parse::<std::net::IpAddr>(), Ok(address) if address.is_loopback())
}

fn map_credential_store_error(error: McpSecretStoreError) -> McpOAuthError {
    match error {
        McpSecretStoreError::Corrupt => McpOAuthError::InvalidStoredCredential,
        McpSecretStoreError::SecretTooLarge => McpOAuthError::StoredCredentialTooLarge,
        McpSecretStoreError::NotFound
        | McpSecretStoreError::AccessDenied
        | McpSecretStoreError::Unavailable
        | McpSecretStoreError::InvalidIdentifier
        | McpSecretStoreError::EmptySecret => McpOAuthError::CredentialStore,
    }
}

fn auth_store_error(_: McpOAuthError) -> AuthError {
    AuthError::InternalError("CodeZ OAuth credential storage failed".to_string())
}

fn auth_error(error: AuthError) -> McpOAuthError {
    match error {
        AuthError::AuthorizationRequired | AuthError::TokenExpired => {
            McpOAuthError::AuthorizationRequired
        }
        _ => McpOAuthError::Protocol,
    }
}

fn protocol_error(_: AuthError) -> McpOAuthError {
    McpOAuthError::Protocol
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, io, path::Path, process::Stdio, sync::Arc, time::Duration};

    use reqwest_013::redirect::Policy;
    use rmcp::transport::auth::CredentialStore as _;
    use serde_json::{Value, json};
    use tokio::{
        io::{AsyncBufReadExt, BufReader},
        process::{Child, Command},
        sync::Mutex,
        time::timeout,
    };

    use super::{McpOAuthClient, McpOAuthCredentialStore, McpOAuthError};
    use crate::{
        McpOAuthConfig, McpSecretKey, McpSecretStore, McpSecretStoreError, McpSecretValue,
        SecretFuture,
    };

    #[derive(Default)]
    struct MemorySecretStore {
        values: Mutex<BTreeMap<McpSecretKey, String>>,
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
                    .insert(key, value.expose_secret().to_owned());
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

    fn fingerprint() -> &'static str {
        "a3c3270f415b8a0535f7a5a07551060b4bd6bf68eb32f3a87c4d9608502b7d90"
    }

    #[tokio::test]
    async fn credentials_use_a_fingerprint_key_and_redact_token_debug_output() {
        let secrets = Arc::new(MemorySecretStore::default());
        let store = McpOAuthCredentialStore::new(
            fingerprint(),
            Arc::clone(&secrets) as Arc<dyn McpSecretStore>,
        )
        .expect("test fingerprint must be valid");
        let credentials = serde_json::from_value(json!({
            "client_id": "codez-test-client",
            "token_response": {
                "access_token": "access-secret",
                "token_type": "Bearer",
                "refresh_token": "refresh-secret"
            },
            "granted_scopes": ["mcp"],
            "token_received_at": 1
        }))
        .expect("fixture credentials must deserialize");

        store
            .save(credentials)
            .await
            .expect("credentials should be stored in the keychain adapter");
        let loaded = store
            .load()
            .await
            .expect("stored credentials should load")
            .expect("stored credentials should exist");

        assert_eq!(store.key().as_str(), format!("mcp.oauth.{}", fingerprint()));
        assert!(!format!("{loaded:?}").contains("access-secret"));
    }

    #[test]
    fn credential_store_rejects_non_fingerprint_identity() {
        let result = McpOAuthCredentialStore::new(
            "not-a-fingerprint",
            Arc::new(MemorySecretStore::default()),
        );

        assert_eq!(result.err(), Some(McpOAuthError::InvalidCredentialIdentity));
    }

    #[tokio::test]
    async fn oauth_client_authorizes_refreshes_revokes_and_clears_credentials()
    -> Result<(), Box<dyn std::error::Error>> {
        let (mut server, origin) = start_oauth_fixture().await?;
        let secrets = Arc::new(MemorySecretStore::default());
        let client = McpOAuthClient::new(
            &format!("{origin}/mcp"),
            fingerprint(),
            McpOAuthConfig {
                client_id: None,
                callback_port: None,
                scope: Some("mcp".to_string()),
            },
            Arc::clone(&secrets) as Arc<dyn McpSecretStore>,
        )?;
        let authorization = client
            .start_authorization("http://127.0.0.1:43119/oauth/callback", "CodeZ MCP test")
            .await?;
        let browser = reqwest_013::Client::builder()
            .redirect(Policy::none())
            .build()?;
        let response = browser
            .get(authorization.authorization_url().clone())
            .send()
            .await?;
        let callback = response
            .headers()
            .get(reqwest_013::header::LOCATION)
            .ok_or_else(|| io::Error::other("OAuth fixture did not redirect"))?
            .to_str()?;
        authorization.handle_callback_url(callback).await?;

        assert_eq!(client.access_token().await?, "access-1");
        client.refresh().await?;
        assert_eq!(client.access_token().await?, "access-2");
        client.logout().await?;
        assert_eq!(
            client.access_token().await.err(),
            Some(McpOAuthError::AuthorizationRequired)
        );
        let revocations: Value = browser
            .get(format!("{origin}/revoke-status"))
            .send()
            .await?
            .json()
            .await?;
        assert_eq!(revocations["count"], 2);

        server.start_kill()?;
        server.wait().await?;
        Ok(())
    }

    async fn start_oauth_fixture() -> Result<(Child, String), Box<dyn std::error::Error>> {
        let workspace = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| {
                io::Error::other("codez-mcp must be inside the workspace crates directory")
            })?;
        let fixture =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcp-oauth-server.cjs");
        let mut server = Command::new("node")
            .arg(fixture)
            .current_dir(workspace)
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        let stdout = server
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("OAuth fixture stdout was unavailable"))?;
        let mut lines = BufReader::new(stdout).lines();
        let line = timeout(Duration::from_secs(5), lines.next_line())
            .await
            .map_err(|_| io::Error::new(io::ErrorKind::TimedOut, "OAuth fixture did not start"))??
            .ok_or_else(|| io::Error::other("OAuth fixture exited before reporting its origin"))?;
        let origin = serde_json::from_str::<Value>(&line)?["origin"]
            .as_str()
            .ok_or_else(|| io::Error::other("OAuth fixture reported an invalid origin"))?
            .to_string();
        Ok((server, origin))
    }
}
