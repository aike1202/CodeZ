use std::time::{SystemTime, UNIX_EPOCH};

use codez_storage::{
    CredentialError, CredentialId, CredentialKind, CredentialStore, OsCredentialStore, SecretValue,
};

struct CredentialCleanup<'a> {
    store: &'a OsCredentialStore,
    id: &'a CredentialId,
    armed: bool,
}

impl Drop for CredentialCleanup<'_> {
    fn drop(&mut self) {
        if self.armed {
            let _ = self.store.delete(self.id);
        }
    }
}

#[test]
#[ignore = "writes one uniquely named credential to the operating-system store and deletes it"]
fn operating_system_credential_store_round_trips_and_deletes_a_secret()
-> Result<(), Box<dyn std::error::Error>> {
    let suffix = format!(
        "{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let store = OsCredentialStore::new(format!("com.codez.desktop.smoke.{suffix}"))?;
    let id = CredentialId::new(CredentialKind::ProviderApiKey, format!("probe-{suffix}"))?;
    let secret = format!("codez-credential-smoke-{suffix}");
    let value = SecretValue::new(secret.clone())?;

    store.set(&id, &value)?;
    let mut cleanup = CredentialCleanup {
        store: &store,
        id: &id,
        armed: true,
    };
    let restored = store.get(&id)?;
    assert_eq!(restored.expose_secret(), secret);

    store.delete(&id)?;
    cleanup.armed = false;
    assert!(matches!(
        store.get(&id),
        Err(CredentialError::NotFound { .. })
    ));
    Ok(())
}
