use std::path::Path;

use thiserror::Error;
#[cfg(windows)]
use zeroize::Zeroizing;

use crate::SecretValue;

/// Migration-only port for decrypting an Electron `safeStorage` envelope.
///
/// This interface is intentionally separate from [`crate::CredentialStore`]: it may
/// only read legacy ciphertext and cannot encrypt or persist new credentials.
pub trait LegacyCredentialReader: Send + Sync {
    /// Decrypts one Base64-encoded legacy envelope into an owned secret.
    ///
    /// # Errors
    ///
    /// Returns [`LegacyCredentialReadError`] when the platform reader is not
    /// available or the encoded envelope cannot be authenticated as UTF-8.
    fn decrypt(&self, encoded: &str) -> Result<SecretValue, LegacyCredentialReadError>;
}

/// Stable, secret-free reasons why an Electron credential could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum LegacyCredentialReadError {
    /// This platform has no verified Electron safe-storage compatibility layer.
    #[error("legacy credential decryption is unsupported on this platform")]
    UnsupportedPlatform,
    /// Chromium's `Local State` file could not be read in this user context.
    #[error("legacy Local State is unavailable")]
    LocalStateUnavailable,
    /// Chromium's `Local State` did not contain a supported wrapped key.
    #[error("legacy Local State is invalid")]
    InvalidLocalState,
    /// The current operating-system user could not unwrap the legacy key.
    #[error("legacy safe-storage key is unavailable in this user context")]
    KeyUnavailable,
    /// The credential value was not valid Base64.
    #[error("legacy credential encoding is invalid")]
    InvalidEncoding,
    /// The credential used an unknown Electron envelope version.
    #[error("legacy credential envelope is unsupported")]
    UnsupportedEnvelope,
    /// AES-GCM authentication rejected the ciphertext or key.
    #[error("legacy credential authentication failed")]
    AuthenticationFailed,
    /// The authenticated plaintext was empty or not UTF-8.
    #[error("legacy credential plaintext is invalid")]
    InvalidPlaintext,
}

/// Read-only Electron safe-storage adapter selected for the current platform.
///
/// Windows loads Chromium's user-scoped DPAPI-wrapped AES key from `Local
/// State`. Other platforms fail closed until their native formats have been
/// verified independently.
pub struct ElectronSafeStorageReader {
    state: ElectronReaderState,
}

enum ElectronReaderState {
    #[cfg(windows)]
    Ready(Zeroizing<Vec<u8>>),
    Unavailable(LegacyCredentialReadError),
}

impl ElectronSafeStorageReader {
    /// Creates a reader for an Electron `userData` directory.
    ///
    /// Construction never exposes platform errors. A missing, malformed, or
    /// inaccessible `Local State` is retained as a stable decryption failure so
    /// each affected credential can receive an explicit re-entry decision.
    #[must_use]
    pub fn from_user_data(user_data: &Path) -> Self {
        #[cfg(windows)]
        {
            let local_state_path = user_data.join("Local State");
            let state = match load_windows_master_key(&local_state_path) {
                Ok(key) => ElectronReaderState::Ready(key),
                Err(error) => ElectronReaderState::Unavailable(error),
            };
            Self { state }
        }

        #[cfg(not(windows))]
        {
            let _ = user_data;
            Self {
                state: ElectronReaderState::Unavailable(
                    LegacyCredentialReadError::UnsupportedPlatform,
                ),
            }
        }
    }
}

impl LegacyCredentialReader for ElectronSafeStorageReader {
    fn decrypt(&self, encoded: &str) -> Result<SecretValue, LegacyCredentialReadError> {
        match &self.state {
            #[cfg(windows)]
            ElectronReaderState::Ready(master_key) => {
                decrypt_windows_envelope(master_key.as_slice(), encoded)
            }
            ElectronReaderState::Unavailable(error) => Err(*error),
        }
    }
}

#[cfg(windows)]
#[derive(serde::Deserialize)]
struct ChromiumLocalState {
    os_crypt: ChromiumOsCrypt,
}

#[cfg(windows)]
#[derive(serde::Deserialize)]
struct ChromiumOsCrypt {
    encrypted_key: String,
}

#[cfg(windows)]
fn load_windows_master_key(
    local_state_path: &Path,
) -> Result<Zeroizing<Vec<u8>>, LegacyCredentialReadError> {
    use std::{fs, io::Read as _};

    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use windows_dpapi::{Scope, decrypt_data};

    const MAX_LOCAL_STATE_BYTES: u64 = 16 * 1024 * 1024;

    super::layout::reject_filesystem_redirects(local_state_path)
        .map_err(|_| LegacyCredentialReadError::InvalidLocalState)?;
    let metadata = fs::symlink_metadata(local_state_path)
        .map_err(|_| LegacyCredentialReadError::LocalStateUnavailable)?;
    if super::layout::metadata_is_redirect(&metadata)
        || !metadata.is_file()
        || metadata.len() > MAX_LOCAL_STATE_BYTES
    {
        return Err(LegacyCredentialReadError::InvalidLocalState);
    }
    let file = fs::File::open(local_state_path)
        .map_err(|_| LegacyCredentialReadError::LocalStateUnavailable)?;
    let capacity = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(capacity.min(1024 * 1024));
    file.take(MAX_LOCAL_STATE_BYTES.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|_| LegacyCredentialReadError::LocalStateUnavailable)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > MAX_LOCAL_STATE_BYTES {
        return Err(LegacyCredentialReadError::InvalidLocalState);
    }
    let final_metadata = fs::symlink_metadata(local_state_path)
        .map_err(|_| LegacyCredentialReadError::LocalStateUnavailable)?;
    if super::layout::metadata_is_redirect(&final_metadata) || !final_metadata.is_file() {
        return Err(LegacyCredentialReadError::InvalidLocalState);
    }
    let local_state = serde_json::from_slice::<ChromiumLocalState>(&bytes)
        .map_err(|_| LegacyCredentialReadError::InvalidLocalState)?;
    let wrapped_key = STANDARD
        .decode(local_state.os_crypt.encrypted_key)
        .map_err(|_| LegacyCredentialReadError::InvalidLocalState)?;
    let dpapi_blob = wrapped_key
        .strip_prefix(b"DPAPI")
        .ok_or(LegacyCredentialReadError::InvalidLocalState)?;
    let key = Zeroizing::new(
        decrypt_data(dpapi_blob, Scope::User, None)
            .map_err(|_| LegacyCredentialReadError::KeyUnavailable)?,
    );
    if key.len() != 32 {
        return Err(LegacyCredentialReadError::InvalidLocalState);
    }
    Ok(key)
}

#[cfg(windows)]
fn decrypt_windows_envelope(
    master_key: &[u8],
    encoded: &str,
) -> Result<SecretValue, LegacyCredentialReadError> {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use zeroize::Zeroize;

    const PREFIX_BYTES: usize = 3;
    const NONCE_BYTES: usize = 12;
    const TAG_BYTES: usize = 16;

    let encrypted = STANDARD
        .decode(encoded.trim())
        .map_err(|_| LegacyCredentialReadError::InvalidEncoding)?;
    if !encrypted.starts_with(b"v10") || encrypted.len() < PREFIX_BYTES + NONCE_BYTES + TAG_BYTES {
        return Err(LegacyCredentialReadError::UnsupportedEnvelope);
    }
    let cipher = Aes256Gcm::new_from_slice(master_key)
        .map_err(|_| LegacyCredentialReadError::InvalidLocalState)?;
    let nonce = Nonce::from_slice(&encrypted[PREFIX_BYTES..PREFIX_BYTES + NONCE_BYTES]);
    let decrypted = cipher
        .decrypt(nonce, &encrypted[PREFIX_BYTES + NONCE_BYTES..])
        .map_err(|_| LegacyCredentialReadError::AuthenticationFailed)?;
    let plaintext = match String::from_utf8(decrypted) {
        Ok(value) => value,
        Err(error) => {
            let mut bytes = error.into_bytes();
            bytes.zeroize();
            return Err(LegacyCredentialReadError::InvalidPlaintext);
        }
    };
    SecretValue::new(plaintext).map_err(|_| LegacyCredentialReadError::InvalidPlaintext)
}

#[cfg(all(test, windows))]
mod windows_tests {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    use super::{
        ElectronSafeStorageReader, LegacyCredentialReadError, LegacyCredentialReader,
        decrypt_windows_envelope,
    };

    fn encrypted_fixture(key: &[u8; 32], plaintext: &[u8]) -> String {
        let nonce_bytes = [7_u8; 12];
        let cipher = Aes256Gcm::new_from_slice(key).expect("fixture key length is valid");
        let ciphertext = cipher
            .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
            .expect("fixture encryption must succeed");
        let mut envelope = b"v10".to_vec();
        envelope.extend_from_slice(&nonce_bytes);
        envelope.extend_from_slice(&ciphertext);
        STANDARD.encode(envelope)
    }

    #[test]
    fn windows_reader_decrypts_an_authenticated_v10_envelope() {
        let key = [9_u8; 32];
        let encoded = encrypted_fixture(&key, b"fixture-secret");

        let secret =
            decrypt_windows_envelope(&key, &encoded).expect("authenticated fixture must decrypt");

        assert_eq!(secret.expose_secret(), "fixture-secret");
    }

    #[test]
    fn windows_reader_rejects_a_v10_envelope_with_the_wrong_key() {
        let encoded = encrypted_fixture(&[9_u8; 32], b"fixture-secret");

        let result = decrypt_windows_envelope(&[8_u8; 32], &encoded);

        assert!(matches!(
            result,
            Err(LegacyCredentialReadError::AuthenticationFailed)
        ));
    }

    #[test]
    fn windows_reader_fails_closed_when_local_state_is_missing() {
        let directory = tempfile::tempdir().expect("fixture directory must be available");
        let reader = ElectronSafeStorageReader::from_user_data(directory.path());

        assert!(matches!(
            reader.decrypt("not-a-real-envelope"),
            Err(LegacyCredentialReadError::LocalStateUnavailable)
        ));
    }
}

#[cfg(all(test, not(windows)))]
mod non_windows_tests {
    use std::path::Path;

    use super::{ElectronSafeStorageReader, LegacyCredentialReadError, LegacyCredentialReader};

    #[test]
    fn unverified_platforms_fail_closed_instead_of_accepting_legacy_ciphertext() {
        let reader = ElectronSafeStorageReader::from_user_data(Path::new("/unused"));

        assert!(matches!(
            reader.decrypt("not-a-real-envelope"),
            Err(LegacyCredentialReadError::UnsupportedPlatform)
        ));
    }
}
