use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use codez_core::{AppError, CancellationToken};
use tokio::sync::Mutex as TokioMutex;

/// Serializes CodeZ mutations per file while allowing unrelated files to run in parallel.
pub struct FileMutationCoordinator {
    locks: Mutex<HashMap<PathBuf, Arc<TokioMutex<()>>>>,
}

impl Default for FileMutationCoordinator {
    fn default() -> Self {
        Self::new()
    }
}

impl FileMutationCoordinator {
    #[must_use]
    pub fn new() -> Self {
        Self {
            locks: Mutex::new(HashMap::new()),
        }
    }

    fn normalize(file_path: &Path) -> PathBuf {
        let resolved = dunce::canonicalize(file_path).unwrap_or_else(|_| {
            let parent = file_path.parent().unwrap_or_else(|| Path::new(""));
            let file_name = file_path.file_name().unwrap_or_default();
            dunce::canonicalize(parent)
                .map(|p| p.join(file_name))
                .unwrap_or_else(|_| file_path.to_path_buf())
        });
        
        #[cfg(windows)]
        {
            PathBuf::from(resolved.to_string_lossy().to_lowercase())
        }
        #[cfg(not(windows))]
        {
            resolved
        }
    }

    /// Executes `op` exclusively for the normalized `file_path`.
    /// 
    /// If `abort_signal` is provided and cancelled while waiting for the lock,
    /// returns an `AppError::cancellation()`.
    pub async fn run<F, Fut, T>(
        &self,
        file_path: &Path,
        op: F,
        abort_signal: Option<&CancellationToken>,
    ) -> Result<T, AppError>
    where
        F: FnOnce() -> Fut,
        Fut: std::future::Future<Output = Result<T, AppError>>,
        Fut: std::future::Future<Output = Result<T, AppError>>,
    {
        if let Some(token) = abort_signal {
            let guard = self.acquire_with_cancellation(file_path, token).await?;
            let res = op().await;
            drop(guard);
            res
        } else {
            let guard = self.acquire(file_path).await;
            let res = op().await;
            drop(guard);
            res
        }
    }

    pub async fn acquire(&self, file_path: &Path) -> tokio::sync::OwnedMutexGuard<()> {
        let key = Self::normalize(file_path);
        let lock = {
            let mut map = self.locks.lock().unwrap();
            map.entry(key).or_insert_with(|| Arc::new(TokioMutex::new(()))).clone()
        };
        lock.lock_owned().await
    }

    pub async fn acquire_with_cancellation(&self, file_path: &Path, abort_signal: &CancellationToken) -> Result<tokio::sync::OwnedMutexGuard<()>, AppError> {
        let key = Self::normalize(file_path);
        let lock = {
            let mut map = self.locks.lock().unwrap();
            map.entry(key).or_insert_with(|| Arc::new(TokioMutex::new(()))).clone()
        };
        tokio::select! {
            guard = lock.lock_owned() => Ok(guard),
            _ = abort_signal.cancelled() => Err(AppError::cancelled("File mutation was aborted while waiting for its lock.")),
        }
    }
}

