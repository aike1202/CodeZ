use std::{
    collections::{BTreeSet, HashSet},
    fs::{self, File},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use tempfile::Builder;

use super::{
    BACKUP_REPORT_SCHEMA_VERSION, BackupReport, DiscoveryLimits, DiscoveryRule,
    LEGACY_DATA_CATALOG, LegacyDataSet, LegacyDataSpec, LegacyFormat, LegacyRoots,
    LegacyValidation, MANIFEST_SCHEMA_VERSION, ManifestScope, MigrationError, MigrationManifest,
    MigrationManifestEntry, MigrationPhase, MigrationRunId, RootScope, SchemaSelector,
    TreeSelector,
};

const HASH_BUFFER_BYTES: usize = 64 * 1024;

pub(super) fn discover_blocking(
    roots: &LegacyRoots,
    run_id: MigrationRunId,
    limits: DiscoveryLimits,
) -> Result<MigrationManifest, MigrationError> {
    let mut discovery = DiscoveryAccumulator::new(limits);
    for spec in &LEGACY_DATA_CATALOG {
        for rule in spec.rules {
            discover_rule(roots, *spec, *rule, &mut discovery)?;
        }
    }
    discovery.finish(run_id)
}

pub(super) fn backup_blocking(
    roots: &LegacyRoots,
    manifest: &MigrationManifest,
    backup_root: &Path,
) -> Result<BackupReport, MigrationError> {
    verify_manifest_fingerprint(manifest)?;
    ensure_backup_is_disjoint(roots, backup_root)?;
    let run_directory = backup_root.join(manifest.run_id.as_str());
    reject_symlink_if_present(&run_directory)?;
    create_secure_directory(&run_directory)?;

    let mut copied_files = 0;
    let mut reused_files = 0;
    let mut total_bytes = 0_u64;
    for entry in &manifest.entries {
        validate_relative_path(&entry.relative_path)?;
        let source_root = roots.resolve_scope(entry.scope)?;
        reject_symlink_descendants(source_root, &entry.relative_path)?;
        let source_path = source_root.join(&entry.relative_path);
        let current = inspect_source_checksum(&source_path, entry.byte_length)?;
        if current.sha256 != entry.sha256 || current.byte_length != entry.byte_length {
            return Err(MigrationError::SourceChanged(source_path));
        }

        let target_relative_path =
            Path::new(&entry.scope.backup_directory_name()).join(&entry.relative_path);
        reject_symlink_descendants(&run_directory, &target_relative_path)?;
        let target_path = run_directory.join(target_relative_path);
        match copy_verified_source(&source_path, &target_path, entry)? {
            CopyOutcome::Copied => copied_files += 1,
            CopyOutcome::Reused => reused_files += 1,
        }
        total_bytes = total_bytes.saturating_add(entry.byte_length);
    }

    Ok(BackupReport {
        schema_version: BACKUP_REPORT_SCHEMA_VERSION,
        run_id: manifest.run_id.clone(),
        manifest_fingerprint: manifest.fingerprint.clone(),
        copied_files,
        reused_files,
        total_bytes,
        phase: MigrationPhase::BackedUp,
    })
}

pub(super) fn read_verified_backup(
    manifest: &MigrationManifest,
    backup_root: &Path,
    data_set: LegacyDataSet,
) -> Result<Option<Vec<u8>>, MigrationError> {
    verify_manifest_fingerprint(manifest)?;
    let mut matches = manifest
        .entries
        .iter()
        .filter(|entry| entry.data_set == data_set);
    let Some(entry) = matches.next() else {
        return Ok(None);
    };
    if matches.next().is_some() {
        return Err(MigrationError::CatalogCollision {
            scope: entry.scope,
            relative_path: entry.relative_path.clone(),
        });
    }

    read_verified_backup_entry(manifest, backup_root, entry).map(Some)
}

pub(super) fn read_verified_backup_entry(
    manifest: &MigrationManifest,
    backup_root: &Path,
    entry: &MigrationManifestEntry,
) -> Result<Vec<u8>, MigrationError> {
    verify_manifest_fingerprint(manifest)?;
    validate_relative_path(&entry.relative_path)?;
    let run_directory = backup_root.join(manifest.run_id.as_str());
    let metadata = reject_symlink(&run_directory)?;
    if !metadata.is_dir() {
        return Err(MigrationError::UnsupportedFileType(run_directory));
    }
    let relative_path = Path::new(&entry.scope.backup_directory_name()).join(&entry.relative_path);
    reject_symlink_descendants(&run_directory, &relative_path)?;
    let backup_path = run_directory.join(relative_path);
    let bytes = read_bounded(&backup_path, entry.byte_length)?;
    let byte_length = u64::try_from(bytes.len()).unwrap_or(u64::MAX);
    if byte_length != entry.byte_length || sha256_bytes(&bytes) != entry.sha256 {
        return Err(MigrationError::BackupConflict(backup_path));
    }
    Ok(bytes)
}

pub(super) fn write_immutable_target(path: &Path, bytes: &[u8]) -> Result<(), MigrationError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(MigrationError::SymbolicLink(path.to_path_buf()));
            }
            if !metadata.is_file() {
                return Err(MigrationError::UnsupportedFileType(path.to_path_buf()));
            }
            if metadata.len() != u64::try_from(bytes.len()).unwrap_or(u64::MAX) {
                return Err(MigrationError::TransformConflict(path.to_path_buf()));
            }
            let existing = fs::read(path)
                .map_err(|source| io_error("read transformed target", path, source))?;
            if existing == bytes {
                return Ok(());
            }
            return Err(MigrationError::TransformConflict(path.to_path_buf()));
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => {}
        Err(source) => return Err(io_error("inspect transformed target", path, source)),
    }

    let parent = path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| MigrationError::UnsafeRelativePath(path.to_path_buf()))?;
    create_secure_directory(parent)?;
    let mut temporary = Builder::new()
        .prefix(".codez-transform-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|source| io_error("create transformed temporary file", path, source))?;
    set_secure_file_permissions(temporary.as_file(), path)?;
    temporary
        .write_all(bytes)
        .map_err(|source| io_error("write transformed temporary file", path, source))?;
    temporary
        .flush()
        .map_err(|source| io_error("flush transformed temporary file", path, source))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|source| io_error("sync transformed temporary file", path, source))?;
    match temporary.persist_noclobber(path) {
        Ok(persisted) => {
            persisted
                .sync_all()
                .map_err(|source| io_error("sync transformed target", path, source))?;
            sync_parent_directory(parent, path)
        }
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            let metadata = inspect_regular_file(path)?;
            if metadata.len() != u64::try_from(bytes.len()).unwrap_or(u64::MAX) {
                return Err(MigrationError::TransformConflict(path.to_path_buf()));
            }
            let existing = fs::read(path)
                .map_err(|source| io_error("read raced transformed target", path, source))?;
            if existing == bytes {
                Ok(())
            } else {
                Err(MigrationError::TransformConflict(path.to_path_buf()))
            }
        }
        Err(error) => Err(io_error(
            "persist transformed target without clobbering",
            path,
            error.error,
        )),
    }
}

pub(super) fn read_verified_target(
    path: &Path,
    expected_bytes: u64,
    expected_sha256: &str,
) -> Result<Vec<u8>, MigrationError> {
    let bytes = read_bounded(path, expected_bytes)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) != expected_bytes
        || sha256_bytes(&bytes) != expected_sha256
    {
        return Err(MigrationError::TransformConflict(path.to_path_buf()));
    }
    Ok(bytes)
}

struct DiscoveryAccumulator {
    entries: Vec<MigrationManifestEntry>,
    seen_paths: BTreeSet<(ManifestScope, PathBuf)>,
    seen_data_sets: HashSet<LegacyDataSet>,
    visited_entries: usize,
    total_bytes: u64,
    limits: DiscoveryLimits,
}

impl DiscoveryAccumulator {
    fn new(limits: DiscoveryLimits) -> Self {
        Self {
            entries: Vec::new(),
            seen_paths: BTreeSet::new(),
            seen_data_sets: HashSet::new(),
            visited_entries: 0,
            total_bytes: 0,
            limits,
        }
    }

    fn visit_filesystem_entry(&mut self) -> Result<(), MigrationError> {
        self.visited_entries = self.visited_entries.saturating_add(1);
        if self.visited_entries > self.limits.max_entries {
            return Err(MigrationError::EntryLimitExceeded {
                max_entries: self.limits.max_entries,
            });
        }
        Ok(())
    }

    fn add_file(
        &mut self,
        spec: LegacyDataSpec,
        scope: ManifestScope,
        scope_root: &Path,
        source_path: &Path,
    ) -> Result<(), MigrationError> {
        let relative_path = source_path
            .strip_prefix(scope_root)
            .map_err(|_| MigrationError::UnsafeRelativePath(source_path.to_path_buf()))?
            .to_path_buf();
        validate_relative_path(&relative_path)?;
        reject_symlink_descendants(scope_root, &relative_path)?;
        if !self.seen_paths.insert((scope, relative_path.clone())) {
            return Err(MigrationError::CatalogCollision {
                scope,
                relative_path,
            });
        }

        let metadata = inspect_regular_file(source_path)?;
        if metadata.len() > spec.max_file_bytes {
            return Err(MigrationError::FileByteLimitExceeded {
                path: source_path.to_path_buf(),
                max_bytes: spec.max_file_bytes,
            });
        }
        let format = resolve_entry_format(spec.format, source_path);
        let schema = if schema_selector_matches(spec.schema_selector, source_path) {
            spec.schema
        } else {
            None
        };
        let inspected = inspect_source(source_path, format, spec.max_file_bytes)?;
        self.total_bytes = self.total_bytes.saturating_add(inspected.byte_length);
        if self.total_bytes > self.limits.max_total_bytes {
            return Err(MigrationError::TotalByteLimitExceeded {
                max_bytes: self.limits.max_total_bytes,
            });
        }
        self.seen_data_sets.insert(spec.data_set);
        self.entries.push(MigrationManifestEntry {
            data_set: spec.data_set,
            scope,
            relative_path,
            format,
            sensitivity: spec.sensitivity,
            schema,
            byte_length: inspected.byte_length,
            sha256: inspected.sha256,
            validation: inspected.validation,
        });
        Ok(())
    }

    fn finish(mut self, run_id: MigrationRunId) -> Result<MigrationManifest, MigrationError> {
        self.entries.sort_by(|left, right| {
            left.scope
                .cmp(&right.scope)
                .then_with(|| left.relative_path.cmp(&right.relative_path))
                .then_with(|| left.data_set.id().cmp(right.data_set.id()))
        });
        let absent_data_sets = LEGACY_DATA_CATALOG
            .iter()
            .filter_map(|spec| {
                (!self.seen_data_sets.contains(&spec.data_set)).then_some(spec.data_set)
            })
            .collect::<Vec<_>>();
        let fingerprint = manifest_fingerprint(&self.entries, &absent_data_sets, self.total_bytes)?;
        Ok(MigrationManifest {
            schema_version: MANIFEST_SCHEMA_VERSION,
            run_id,
            entries: self.entries,
            absent_data_sets,
            total_bytes: self.total_bytes,
            fingerprint,
        })
    }
}

fn discover_rule(
    roots: &LegacyRoots,
    spec: LegacyDataSpec,
    rule: DiscoveryRule,
    discovery: &mut DiscoveryAccumulator,
) -> Result<(), MigrationError> {
    for (scope, scope_root) in scope_roots(roots, rule.scope()) {
        match rule {
            DiscoveryRule::ExactFile { relative_path, .. } => {
                let source_path = scope_root.join(relative_path);
                match fs::symlink_metadata(&source_path) {
                    Ok(_) => {
                        discovery.visit_filesystem_entry()?;
                        discovery.add_file(spec, scope, scope_root, &source_path)?;
                    }
                    Err(source) if source.kind() == io::ErrorKind::NotFound => {}
                    Err(source) => {
                        return Err(io_error("inspect exact source", &source_path, source));
                    }
                }
            }
            DiscoveryRule::PrefixFiles {
                relative_directory,
                prefix,
                ..
            } => discover_prefix_files(
                spec,
                scope,
                scope_root,
                relative_directory,
                prefix,
                discovery,
            )?,
            DiscoveryRule::RecursiveTree {
                relative_directory,
                selector,
                ..
            } => discover_tree(
                spec,
                scope,
                scope_root,
                relative_directory,
                selector,
                discovery,
            )?,
        }
    }
    Ok(())
}

fn discover_prefix_files(
    spec: LegacyDataSpec,
    scope: ManifestScope,
    scope_root: &Path,
    relative_directory: &str,
    prefix: &str,
    discovery: &mut DiscoveryAccumulator,
) -> Result<(), MigrationError> {
    let directory = scope_root.join(relative_directory);
    let Some(mut paths) = read_directory_paths(&directory, discovery)? else {
        return Ok(());
    };
    paths.sort();
    for path in paths {
        let Some(file_name) = path.file_name().and_then(|name| name.to_str()) else {
            return Err(MigrationError::UnsafeRelativePath(path));
        };
        if !rotated_file_matches(file_name, prefix) {
            continue;
        }
        let metadata = reject_symlink(&path)?;
        if !metadata.is_file() {
            return Err(MigrationError::UnsupportedFileType(path));
        }
        discovery.add_file(spec, scope, scope_root, &path)?;
    }
    Ok(())
}

fn discover_tree(
    spec: LegacyDataSpec,
    scope: ManifestScope,
    scope_root: &Path,
    relative_directory: &str,
    selector: TreeSelector,
    discovery: &mut DiscoveryAccumulator,
) -> Result<(), MigrationError> {
    let tree_root = scope_root.join(relative_directory);
    let metadata = match fs::symlink_metadata(&tree_root) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(source) => return Err(io_error("inspect tree root", &tree_root, source)),
    };
    if metadata.file_type().is_symlink() {
        return Err(MigrationError::SymbolicLink(tree_root));
    }
    if !metadata.is_dir() {
        return Err(MigrationError::UnsupportedFileType(tree_root));
    }

    let mut pending = vec![tree_root];
    while let Some(directory) = pending.pop() {
        let Some(mut paths) = read_directory_paths(&directory, discovery)? else {
            continue;
        };
        paths.sort_by(|left, right| right.cmp(left));
        for path in paths {
            let metadata = reject_symlink(&path)?;
            if metadata.is_dir() {
                pending.push(path);
            } else if metadata.is_file() {
                if tree_selector_matches(selector, &path) {
                    discovery.add_file(spec, scope, scope_root, &path)?;
                }
            } else {
                return Err(MigrationError::UnsupportedFileType(path));
            }
        }
    }
    Ok(())
}

fn scope_roots(roots: &LegacyRoots, scope: RootScope) -> Vec<(ManifestScope, &Path)> {
    match scope {
        RootScope::UserData => vec![(ManifestScope::UserData, roots.user_data())],
        RootScope::UserHome => vec![(ManifestScope::UserHome, roots.user_home())],
        RootScope::Workspace => roots
            .workspaces()
            .iter()
            .enumerate()
            .map(|(index, root)| (ManifestScope::Workspace { index }, root.as_path()))
            .collect(),
    }
}

fn read_directory_paths(
    directory: &Path,
    discovery: &mut DiscoveryAccumulator,
) -> Result<Option<Vec<PathBuf>>, MigrationError> {
    let metadata = match fs::symlink_metadata(directory) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_error("inspect directory", directory, source)),
    };
    if metadata.file_type().is_symlink() {
        return Err(MigrationError::SymbolicLink(directory.to_path_buf()));
    }
    if !metadata.is_dir() {
        return Err(MigrationError::UnsupportedFileType(directory.to_path_buf()));
    }
    let mut entries = Vec::new();
    for entry in
        fs::read_dir(directory).map_err(|source| io_error("read directory", directory, source))?
    {
        discovery.visit_filesystem_entry()?;
        entries.push(
            entry
                .map(|value| value.path())
                .map_err(|source| io_error("read directory entry", directory, source))?,
        );
    }
    Ok(Some(entries))
}

fn inspect_source(
    path: &Path,
    format: LegacyFormat,
    max_bytes: u64,
) -> Result<InspectedSource, MigrationError> {
    match format {
        LegacyFormat::Json | LegacyFormat::JsonLines => {
            let bytes = read_bounded(path, max_bytes)?;
            let validation = validate_structured_bytes(format, &bytes);
            Ok(InspectedSource {
                byte_length: u64::try_from(bytes.len()).unwrap_or(u64::MAX),
                sha256: sha256_bytes(&bytes),
                validation,
            })
        }
        LegacyFormat::SecretEnvelope | LegacyFormat::Mixed | LegacyFormat::Opaque => {
            let checksum = inspect_checksum(path, max_bytes)?;
            Ok(InspectedSource {
                byte_length: checksum.byte_length,
                sha256: checksum.sha256,
                validation: if format == LegacyFormat::SecretEnvelope {
                    LegacyValidation::PendingCredentialMigration
                } else {
                    LegacyValidation::Opaque
                },
            })
        }
    }
}

fn validate_structured_bytes(format: LegacyFormat, bytes: &[u8]) -> LegacyValidation {
    match format {
        LegacyFormat::Json => match serde_json::from_slice::<Value>(bytes) {
            Ok(Value::Object(_)) => LegacyValidation::ValidJson,
            Ok(_) => LegacyValidation::InvalidJsonRoot,
            Err(source) => LegacyValidation::InvalidJson {
                line: source.line(),
                column: source.column(),
            },
        },
        LegacyFormat::JsonLines => validate_json_lines(bytes),
        LegacyFormat::SecretEnvelope | LegacyFormat::Mixed | LegacyFormat::Opaque => {
            LegacyValidation::Opaque
        }
    }
}

fn validate_json_lines(bytes: &[u8]) -> LegacyValidation {
    let mut valid_records = 0;
    for (index, line) in bytes.split(|byte| *byte == b'\n').enumerate() {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        match serde_json::from_slice::<Value>(line) {
            Ok(Value::Object(_)) => valid_records += 1,
            Ok(_) | Err(_) => {
                return LegacyValidation::PartialJsonLines {
                    valid_records,
                    first_invalid_line: index + 1,
                };
            }
        }
    }
    LegacyValidation::ValidJsonLines {
        record_count: valid_records,
    }
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, MigrationError> {
    let metadata = inspect_regular_file(path)?;
    if metadata.len() > max_bytes {
        return Err(MigrationError::FileByteLimitExceeded {
            path: path.to_path_buf(),
            max_bytes,
        });
    }
    let file = File::open(path).map_err(|source| io_error("open source", path, source))?;
    let capacity = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(capacity.min(1024 * 1024));
    file.take(max_bytes.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(|source| io_error("read source", path, source))?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max_bytes {
        return Err(MigrationError::FileByteLimitExceeded {
            path: path.to_path_buf(),
            max_bytes,
        });
    }
    reject_symlink(path)?;
    Ok(bytes)
}

fn inspect_checksum(path: &Path, max_bytes: u64) -> Result<FileChecksum, MigrationError> {
    let metadata = inspect_regular_file(path)?;
    if metadata.len() > max_bytes {
        return Err(MigrationError::FileByteLimitExceeded {
            path: path.to_path_buf(),
            max_bytes,
        });
    }
    let mut file = File::open(path).map_err(|source| io_error("open source", path, source))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut byte_length = 0_u64;
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|source| io_error("hash source", path, source))?;
        if count == 0 {
            break;
        }
        byte_length = byte_length.saturating_add(u64::try_from(count).unwrap_or(u64::MAX));
        if byte_length > max_bytes {
            return Err(MigrationError::FileByteLimitExceeded {
                path: path.to_path_buf(),
                max_bytes,
            });
        }
        hasher.update(&buffer[..count]);
    }
    reject_symlink(path)?;
    Ok(FileChecksum {
        byte_length,
        sha256: encode_digest(hasher.finalize().as_slice()),
    })
}

fn inspect_source_checksum(
    path: &Path,
    expected_bytes: u64,
) -> Result<FileChecksum, MigrationError> {
    match inspect_checksum(path, expected_bytes) {
        Err(MigrationError::FileByteLimitExceeded { .. }) => {
            Err(MigrationError::SourceChanged(path.to_path_buf()))
        }
        Err(MigrationError::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
            Err(MigrationError::SourceChanged(path.to_path_buf()))
        }
        result => result,
    }
}

fn inspect_backup_checksum(
    path: &Path,
    expected_bytes: u64,
) -> Result<FileChecksum, MigrationError> {
    match inspect_checksum(path, expected_bytes) {
        Err(MigrationError::FileByteLimitExceeded { .. }) => {
            Err(MigrationError::BackupConflict(path.to_path_buf()))
        }
        result => result,
    }
}

fn copy_verified_source(
    source_path: &Path,
    target_path: &Path,
    expected: &MigrationManifestEntry,
) -> Result<CopyOutcome, MigrationError> {
    match fs::symlink_metadata(target_path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err(MigrationError::SymbolicLink(target_path.to_path_buf()));
            }
            if !metadata.is_file() {
                return Err(MigrationError::UnsupportedFileType(
                    target_path.to_path_buf(),
                ));
            }
            let backup = inspect_backup_checksum(target_path, expected.byte_length)?;
            if backup.byte_length == expected.byte_length && backup.sha256 == expected.sha256 {
                return Ok(CopyOutcome::Reused);
            }
            return Err(MigrationError::BackupConflict(target_path.to_path_buf()));
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => {}
        Err(source) => return Err(io_error("inspect backup target", target_path, source)),
    }

    let parent = target_path
        .parent()
        .filter(|value| !value.as_os_str().is_empty())
        .ok_or_else(|| MigrationError::UnsafeRelativePath(target_path.to_path_buf()))?;
    create_secure_directory(parent)?;
    let mut source = File::open(source_path)
        .map_err(|error| io_error("open backup source", source_path, error))?;
    let mut temporary = Builder::new()
        .prefix(".codez-backup-")
        .suffix(".tmp")
        .tempfile_in(parent)
        .map_err(|error| io_error("create backup temporary file", target_path, error))?;
    set_secure_file_permissions(temporary.as_file(), target_path)?;

    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut copied_bytes = 0_u64;
    loop {
        let count = source
            .read(&mut buffer)
            .map_err(|error| io_error("read backup source", source_path, error))?;
        if count == 0 {
            break;
        }
        copied_bytes = copied_bytes.saturating_add(u64::try_from(count).unwrap_or(u64::MAX));
        if copied_bytes > expected.byte_length {
            return Err(MigrationError::SourceChanged(source_path.to_path_buf()));
        }
        hasher.update(&buffer[..count]);
        temporary
            .write_all(&buffer[..count])
            .map_err(|error| io_error("write backup temporary file", target_path, error))?;
    }
    let copied_sha = encode_digest(hasher.finalize().as_slice());
    if copied_bytes != expected.byte_length || copied_sha != expected.sha256 {
        return Err(MigrationError::SourceChanged(source_path.to_path_buf()));
    }
    reject_symlink(source_path)?;
    temporary
        .flush()
        .map_err(|error| io_error("flush backup temporary file", target_path, error))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(|error| io_error("sync backup temporary file", target_path, error))?;
    match temporary.persist_noclobber(target_path) {
        Ok(persisted) => {
            persisted
                .sync_all()
                .map_err(|error| io_error("sync backup file", target_path, error))?;
            sync_parent_directory(parent, target_path)?;
            Ok(CopyOutcome::Copied)
        }
        Err(error) if error.error.kind() == io::ErrorKind::AlreadyExists => {
            let backup = inspect_backup_checksum(target_path, expected.byte_length)?;
            if backup.byte_length == expected.byte_length && backup.sha256 == expected.sha256 {
                Ok(CopyOutcome::Reused)
            } else {
                Err(MigrationError::BackupConflict(target_path.to_path_buf()))
            }
        }
        Err(error) => Err(io_error(
            "persist no-clobber backup",
            target_path,
            error.error,
        )),
    }
}

fn inspect_regular_file(path: &Path) -> Result<fs::Metadata, MigrationError> {
    let metadata = reject_symlink(path)?;
    if metadata.is_file() {
        Ok(metadata)
    } else {
        Err(MigrationError::UnsupportedFileType(path.to_path_buf()))
    }
}

fn reject_symlink(path: &Path) -> Result<fs::Metadata, MigrationError> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|source| io_error("inspect filesystem entry", path, source))?;
    if metadata.file_type().is_symlink() {
        Err(MigrationError::SymbolicLink(path.to_path_buf()))
    } else {
        Ok(metadata)
    }
}

fn reject_symlink_if_present(path: &Path) -> Result<(), MigrationError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                Err(MigrationError::SymbolicLink(path.to_path_buf()))
            } else {
                Ok(())
            }
        }
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(source) => Err(io_error("inspect filesystem entry", path, source)),
    }
}

fn reject_symlink_descendants(root: &Path, relative_path: &Path) -> Result<(), MigrationError> {
    validate_relative_path(relative_path)?;
    let mut current = root.to_path_buf();
    for component in relative_path.components() {
        let Component::Normal(value) = component else {
            continue;
        };
        current.push(value);
        match fs::symlink_metadata(&current) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(MigrationError::SymbolicLink(current));
            }
            Ok(_) => {}
            Err(source) if source.kind() == io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(io_error("inspect path component", &current, source));
            }
        }
    }
    Ok(())
}

fn resolve_entry_format(format: LegacyFormat, path: &Path) -> LegacyFormat {
    if format != LegacyFormat::Mixed {
        return format;
    }
    match path.extension().and_then(|extension| extension.to_str()) {
        Some("json") => LegacyFormat::Json,
        Some("jsonl") => LegacyFormat::JsonLines,
        _ => LegacyFormat::Opaque,
    }
}

fn schema_selector_matches(selector: SchemaSelector, path: &Path) -> bool {
    match selector {
        SchemaSelector::None => false,
        SchemaSelector::All => true,
        SchemaSelector::FileName(expected) => path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|actual| actual == expected),
        SchemaSelector::Extension(expected) => path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|actual| actual == expected),
    }
}

fn tree_selector_matches(selector: TreeSelector, path: &Path) -> bool {
    match selector {
        TreeSelector::All => true,
        TreeSelector::FileName(expected) => path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|actual| actual == expected),
        TreeSelector::Extension(expected) => path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|actual| actual == expected),
    }
}

fn rotated_file_matches(file_name: &str, base_name: &str) -> bool {
    if file_name == base_name {
        return true;
    }
    file_name
        .strip_prefix(base_name)
        .and_then(|suffix| suffix.strip_prefix('.'))
        .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4"))
}

fn validate_relative_path(path: &Path) -> Result<(), MigrationError> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path.components().any(|component| {
            matches!(
                component,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err(MigrationError::UnsafeRelativePath(path.to_path_buf()));
    }
    Ok(())
}

fn manifest_fingerprint(
    entries: &[MigrationManifestEntry],
    absent_data_sets: &[LegacyDataSet],
    total_bytes: u64,
) -> Result<String, MigrationError> {
    #[derive(Serialize)]
    #[serde(rename_all = "camelCase")]
    struct FingerprintInput<'a> {
        schema_version: u32,
        entries: &'a [MigrationManifestEntry],
        absent_data_sets: &'a [LegacyDataSet],
        total_bytes: u64,
    }

    let bytes = serde_json::to_vec(&FingerprintInput {
        schema_version: MANIFEST_SCHEMA_VERSION,
        entries,
        absent_data_sets,
        total_bytes,
    })
    .map_err(MigrationError::ManifestSerialization)?;
    Ok(sha256_bytes(&bytes))
}

pub(super) fn verify_manifest_fingerprint(
    manifest: &MigrationManifest,
) -> Result<(), MigrationError> {
    let actual = manifest_fingerprint(
        &manifest.entries,
        &manifest.absent_data_sets,
        manifest.total_bytes,
    )?;
    if actual == manifest.fingerprint && manifest.schema_version == MANIFEST_SCHEMA_VERSION {
        Ok(())
    } else {
        Err(MigrationError::ManifestFingerprintMismatch)
    }
}

fn ensure_backup_is_disjoint(
    roots: &LegacyRoots,
    backup_root: &Path,
) -> Result<(), MigrationError> {
    let mut protected_roots = vec![
        roots.user_data().to_path_buf(),
        roots.user_home().join(".codez"),
    ];
    for workspace in roots.workspaces() {
        protected_roots.push(workspace.join(".codez"));
        protected_roots.push(workspace.join(".codez-cache"));
    }
    if protected_roots.iter().any(|source_root| {
        backup_root.starts_with(source_root) || source_root.starts_with(backup_root)
    }) {
        Err(MigrationError::OverlappingBackupRoot(
            backup_root.to_path_buf(),
        ))
    } else {
        Ok(())
    }
}

pub(super) fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    encode_digest(hasher.finalize().as_slice())
}

fn encode_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

fn io_error(operation: &'static str, path: &Path, source: io::Error) -> MigrationError {
    MigrationError::Io {
        operation,
        path: path.to_path_buf(),
        source,
    }
}

#[cfg(unix)]
fn create_secure_directory(path: &Path) -> Result<(), MigrationError> {
    use std::os::unix::fs::PermissionsExt;

    fs::create_dir_all(path).map_err(|source| io_error("create backup directory", path, source))?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .map_err(|source| io_error("set backup directory permissions", path, source))
}

#[cfg(not(unix))]
fn create_secure_directory(path: &Path) -> Result<(), MigrationError> {
    fs::create_dir_all(path).map_err(|source| io_error("create backup directory", path, source))
}

#[cfg(unix)]
fn set_secure_file_permissions(file: &File, path: &Path) -> Result<(), MigrationError> {
    use std::os::unix::fs::PermissionsExt;

    file.set_permissions(fs::Permissions::from_mode(0o600))
        .map_err(|source| io_error("set backup file permissions", path, source))
}

#[cfg(not(unix))]
fn set_secure_file_permissions(_file: &File, _path: &Path) -> Result<(), MigrationError> {
    Ok(())
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path, target: &Path) -> Result<(), MigrationError> {
    File::open(parent)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| io_error("sync backup directory", target, source))
}

#[cfg(not(unix))]
fn sync_parent_directory(_parent: &Path, _target: &Path) -> Result<(), MigrationError> {
    Ok(())
}

struct InspectedSource {
    byte_length: u64,
    sha256: String,
    validation: LegacyValidation,
}

struct FileChecksum {
    byte_length: u64,
    sha256: String,
}

enum CopyOutcome {
    Copied,
    Reused,
}
