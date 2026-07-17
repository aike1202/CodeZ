use dashmap::DashMap;
use std::{
    collections::VecDeque,
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::Mutex;

use codez_core::AppError;

pub struct ReadSnapshot {
    pub sha256: String,
    pub buffer: Vec<u8>,
    pub stat_signature: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum ReadSnapshotSource {
    Filesystem,
    SharedCache,
}

struct SnapshotCacheEntry {
    session_id: String,
    path: PathBuf,
}

pub struct ReadFingerprintStore {
    sessions: DashMap<String, DashMap<PathBuf, String>>,
    snapshots: DashMap<String, DashMap<PathBuf, Arc<ReadSnapshot>>>,

    // Limits
    max_snapshot_entries: usize,
    max_snapshot_bytes: usize,

    snapshot_bytes: std::sync::atomic::AtomicUsize,
    snapshot_order: Mutex<VecDeque<SnapshotCacheEntry>>,

    deliveries: DashMap<String, DashMap<String, DashMap<PathBuf, String>>>,

    inflight: DashMap<String, Arc<tokio::sync::Mutex<Option<Arc<ReadSnapshot>>>>>,
}

impl Default for ReadFingerprintStore {
    fn default() -> Self {
        Self::new(100, 25 * 1024 * 1024)
    }
}

impl ReadFingerprintStore {
    #[must_use]
    pub fn new(max_snapshot_entries: usize, max_snapshot_bytes: usize) -> Self {
        Self {
            sessions: DashMap::new(),
            snapshots: DashMap::new(),
            max_snapshot_entries,
            max_snapshot_bytes,
            snapshot_bytes: std::sync::atomic::AtomicUsize::new(0),
            snapshot_order: Mutex::new(VecDeque::new()),
            deliveries: DashMap::new(),
            inflight: DashMap::new(),
        }
    }

    fn normalize(file_path: &Path) -> PathBuf {
        let resolved = dunce::canonicalize(file_path).unwrap_or_else(|_| file_path.to_path_buf());
        #[cfg(windows)]
        {
            PathBuf::from(resolved.to_string_lossy().to_lowercase())
        }
        #[cfg(not(windows))]
        {
            resolved
        }
    }

    pub fn record(&self, session_id: &str, abs_path: &Path, sha256: &str) {
        let normalized = Self::normalize(abs_path);
        let session = self.sessions.entry(session_id.to_string()).or_default();
        session.insert(normalized, sha256.to_string());
    }

    pub async fn record_snapshot(
        &self,
        session_id: &str,
        abs_path: &Path,
        snapshot: Arc<ReadSnapshot>,
    ) {
        let normalized = Self::normalize(abs_path);
        let session = self.sessions.entry(session_id.to_string()).or_default();
        session.insert(normalized.clone(), snapshot.sha256.clone());

        let snapshots = self.snapshots.entry(session_id.to_string()).or_default();
        let old_size = if let Some(old) = snapshots.get(&normalized) {
            old.buffer.len()
        } else {
            0
        };

        let new_size = snapshot.buffer.len();
        snapshots.insert(normalized.clone(), snapshot);

        let mut old_bytes = self
            .snapshot_bytes
            .load(std::sync::atomic::Ordering::SeqCst);
        loop {
            let next_bytes = (old_bytes - old_size) + new_size;
            match self.snapshot_bytes.compare_exchange_weak(
                old_bytes,
                next_bytes,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            ) {
                Ok(_) => break,
                Err(x) => old_bytes = x,
            }
        }

        let mut order = self.snapshot_order.lock().await;
        order.push_back(SnapshotCacheEntry {
            session_id: session_id.to_string(),
            path: normalized,
        });

        self.evict_snapshots(&mut order).await;
    }

    async fn evict_snapshots(&self, order: &mut VecDeque<SnapshotCacheEntry>) {
        while order.len() > self.max_snapshot_entries
            || self
                .snapshot_bytes
                .load(std::sync::atomic::Ordering::SeqCst)
                > self.max_snapshot_bytes
        {
            if let Some(entry) = order.pop_front() {
                if let Some(session_snapshots) = self.snapshots.get(&entry.session_id) {
                    if let Some((_, old)) = session_snapshots.remove(&entry.path) {
                        self.snapshot_bytes
                            .fetch_sub(old.buffer.len(), std::sync::atomic::Ordering::SeqCst);
                    }
                }
            } else {
                break;
            }
        }
    }

    pub fn get_snapshot(
        &self,
        session_id: &str,
        abs_path: &Path,
        stat_signature: &str,
    ) -> Option<Arc<ReadSnapshot>> {
        let normalized = Self::normalize(abs_path);
        if let Some(session_snapshots) = self.snapshots.get(session_id) {
            if let Some(snapshot) = session_snapshots.get(&normalized) {
                if snapshot.stat_signature == stat_signature {
                    return Some(snapshot.clone());
                }
            }
        }
        None
    }

    pub async fn get_or_load_snapshot<F, Fut>(
        &self,
        session_id: &str,
        abs_path: &Path,
        stat_signature: &str,
        loader: F,
    ) -> Result<(Arc<ReadSnapshot>, ReadSnapshotSource), AppError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<Arc<ReadSnapshot>, AppError>>,
    {
        if let Some(cached) = self.get_snapshot(session_id, abs_path, stat_signature) {
            return Ok((cached, ReadSnapshotSource::SharedCache));
        }

        let normalized = Self::normalize(abs_path);
        let inflight_key = format!(
            "{}:{}:{}",
            session_id,
            normalized.to_string_lossy(),
            stat_signature
        );

        let lock = self
            .inflight
            .entry(inflight_key.clone())
            .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(None)))
            .clone();

        let mut guard = lock.lock().await;

        if let Some(res) = &*guard {
            return Ok((res.clone(), ReadSnapshotSource::SharedCache));
        }

        let snapshot = loader().await?;
        self.record_snapshot(session_id, abs_path, snapshot.clone())
            .await;
        *guard = Some(snapshot.clone());

        self.inflight.remove(&inflight_key);

        Ok((snapshot, ReadSnapshotSource::Filesystem))
    }

    pub fn record_delivery(
        &self,
        session_id: &str,
        context_scope_id: &str,
        abs_path: &Path,
        sha256: &str,
    ) {
        let normalized = Self::normalize(abs_path);
        let session = self.deliveries.entry(session_id.to_string()).or_default();
        let scope = session.entry(context_scope_id.to_string()).or_default();
        scope.insert(normalized, sha256.to_string());
    }

    pub fn has_delivery(
        &self,
        session_id: &str,
        context_scope_id: &str,
        abs_path: &Path,
        sha256: &str,
    ) -> bool {
        let normalized = Self::normalize(abs_path);
        if let Some(session) = self.deliveries.get(session_id) {
            if let Some(scope) = session.get(context_scope_id) {
                if let Some(stored_sha256) = scope.get(&normalized) {
                    return stored_sha256.as_str() == sha256;
                }
            }
        }
        false
    }

    /// Drops all in-memory read and delivery state owned by one deleted session.
    pub async fn clear_session(&self, session_id: &str) {
        self.sessions.remove(session_id);
        self.deliveries.remove(session_id);
        self.inflight
            .retain(|key, _| !key.starts_with(&format!("{session_id}:")));

        if let Some((_, snapshots)) = self.snapshots.remove(session_id) {
            let released_bytes = snapshots
                .iter()
                .map(|entry| entry.value().buffer.len())
                .sum::<usize>();
            self.snapshot_bytes
                .fetch_update(
                    std::sync::atomic::Ordering::SeqCst,
                    std::sync::atomic::Ordering::SeqCst,
                    |current| Some(current.saturating_sub(released_bytes)),
                )
                .ok();
        }

        self.snapshot_order
            .lock()
            .await
            .retain(|entry| entry.session_id != session_id);
    }
}

#[cfg(test)]
mod tests {
    use std::{path::PathBuf, sync::Arc};

    use super::{ReadFingerprintStore, ReadSnapshot};

    #[tokio::test]
    async fn clear_session_removes_read_snapshots_and_delivery_tracking() {
        let store = ReadFingerprintStore::new(10, 1_024);
        let path = PathBuf::from("fixture.txt");
        let snapshot = Arc::new(ReadSnapshot {
            sha256: "fixture-sha".to_string(),
            buffer: b"fixture".to_vec(),
            stat_signature: "fixture-stat".to_string(),
        });
        store
            .record_snapshot("session-1", &path, Arc::clone(&snapshot))
            .await;
        store.record_delivery("session-1", "main", &path, "fixture-sha");

        store.clear_session("session-1").await;

        assert!(
            store
                .get_snapshot("session-1", &path, "fixture-stat")
                .is_none()
        );
        assert!(!store.has_delivery("session-1", "main", &path, "fixture-sha"));
    }
}
