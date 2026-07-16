use std::path::Path;

use crate::PortFuture;

/// Result of an idempotent no-clobber persistence operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtomicCreateOutcome {
    /// The target did not exist and the bytes were committed.
    Created,
    /// The target already contained the same bytes.
    Reused,
}

/// Atomic raw-byte persistence supplied by a storage adapter.
///
/// Implementations bound reads and writes, reject unsafe filesystem objects,
/// serialize mutations for each resource, and durably commit before resolving.
/// Higher layers own serialization formats and recovery policy.
pub trait AtomicPersistence: Send + Sync {
    /// Reads the complete bounded resource, or `None` when it does not exist.
    fn read<'a>(&'a self, path: &'a Path) -> PortFuture<'a, Option<Vec<u8>>>;

    /// Atomically replaces the resource with `bytes`.
    fn replace<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()>;

    /// Creates an immutable resource without replacing different existing bytes.
    fn create_no_clobber<'a>(
        &'a self,
        path: &'a Path,
        bytes: &'a [u8],
    ) -> PortFuture<'a, AtomicCreateOutcome>;

    /// Appends and synchronizes one raw byte segment under the resource writer lock.
    fn append<'a>(&'a self, path: &'a Path, bytes: &'a [u8]) -> PortFuture<'a, ()>;

    /// Removes a regular resource and reports whether it existed.
    fn remove<'a>(&'a self, path: &'a Path) -> PortFuture<'a, bool>;
}
