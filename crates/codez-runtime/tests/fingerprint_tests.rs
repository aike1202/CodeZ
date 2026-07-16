use codez_runtime::fingerprint::ReadFingerprintStore;
use std::path::PathBuf;

#[tokio::test]
async fn test_fingerprint_store_delivery_tracking() {
    let store = ReadFingerprintStore::new(10_000_000, 10_000_000);
    let session = "session1";
    let context = "context1";
    let path = PathBuf::from("test.txt");
    let sha = "dummy_sha_hash";

    assert!(!store.has_delivery(session, context, &path, sha));

    store.record_delivery(session, context, &path, sha);

    assert!(store.has_delivery(session, context, &path, sha));
    assert!(!store.has_delivery(session, context, &path, "different_sha"));
    assert!(!store.has_delivery(session, "context2", &path, sha));
    assert!(!store.has_delivery("session2", context, &path, sha));
}
