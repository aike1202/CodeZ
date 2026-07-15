#[cfg(windows)]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use std::{env, fs};

    use aes_gcm::{Aes256Gcm, KeyInit, Nonce, aead::Aead};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use windows_dpapi::{Scope, decrypt_data};

    const SENTINEL: &[u8] = b"codez-safe-storage-probe-v1";

    let input_path = env::args()
        .nth(1)
        .ok_or("usage: windows_safe_storage_probe <base64-input-file> <local-state-file>")?;
    let local_state_path = env::args()
        .nth(2)
        .ok_or("usage: windows_safe_storage_probe <base64-input-file> <local-state-file>")?;
    let encoded = fs::read_to_string(input_path)?;
    let encrypted = STANDARD.decode(encoded.trim())?;
    if !encrypted.starts_with(b"v10") || encrypted.len() < 3 + 12 + 16 {
        return Err("unsupported Electron safeStorage ciphertext envelope".into());
    }

    let local_state: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(local_state_path)?)?;
    let wrapped_key = local_state
        .pointer("/os_crypt/encrypted_key")
        .and_then(serde_json::Value::as_str)
        .ok_or("Local State does not contain os_crypt.encrypted_key")?;
    let wrapped_key = STANDARD.decode(wrapped_key)?;
    let dpapi_blob = wrapped_key
        .strip_prefix(b"DPAPI")
        .ok_or("Local State encryption key does not use the DPAPI envelope")?;
    let master_key = decrypt_data(dpapi_blob, Scope::User, None)?;
    let cipher = Aes256Gcm::new_from_slice(&master_key)
        .map_err(|_| "Local State did not contain a 256-bit AES key")?;
    let nonce = Nonce::from_slice(&encrypted[3..15]);
    let decrypted = cipher
        .decrypt(nonce, &encrypted[15..])
        .map_err(|_| "AES-GCM authentication failed")?;

    if decrypted != SENTINEL {
        return Err("Electron safeStorage sentinel did not match after DPAPI decryption".into());
    }

    println!("Windows Electron safeStorage v10 envelope is compatible with DPAPI + AES-256-GCM.");
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    println!("Windows safeStorage probe skipped on this platform.");
}
