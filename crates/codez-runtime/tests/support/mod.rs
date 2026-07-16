use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::Mutex,
};

use codez_core::{AppError, AtomicCreateOutcome, AtomicPersistence, PortFuture};

#[derive(Debug, Default)]
pub struct MemoryAtomicPersistence {
    files: Mutex<HashMap<PathBuf, Vec<u8>>>,
}

impl AtomicPersistence for MemoryAtomicPersistence {
    fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>> {
        Box::pin(async move {
            Ok(self
                .files
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .get(path)
                .cloned())
        })
    }

    fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.files
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
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
            let mut files = self
                .files
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            match files.get(path) {
                Some(existing) if existing.as_slice() == bytes => Ok(AtomicCreateOutcome::Reused),
                Some(_) => Err(AppError::conflict(
                    "The in-memory persistence target contains different bytes",
                )),
                None => {
                    files.insert(path.to_path_buf(), bytes.to_vec());
                    Ok(AtomicCreateOutcome::Created)
                }
            }
        })
    }

    fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()> {
        Box::pin(async move {
            self.files
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .entry(path.to_path_buf())
                .or_default()
                .extend_from_slice(bytes);
            Ok(())
        })
    }

    fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool> {
        Box::pin(async move {
            Ok(self
                .files
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(path)
                .is_some())
        })
    }
}
