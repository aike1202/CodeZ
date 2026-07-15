#![forbid(unsafe_code)]

//! Versioned repositories, atomic files, credentials, and legacy-data migration.

mod atomic_file;

pub use atomic_file::{
    AtomicFileStore, AtomicWriteFaultInjector, AtomicWriteStage, InjectedWriteFault, JsonLinesRead,
    StorageError,
};
