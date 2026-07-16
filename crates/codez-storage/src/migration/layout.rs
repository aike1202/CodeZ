use std::{
    ffi::OsString,
    fs, io,
    path::{Component, Path, PathBuf},
};

use super::{
    DiscoveryRule, LEGACY_DATA_CATALOG, LegacyFormat, LegacyRoots, MigrationError,
    MigrationManifest, RootScope,
};

const MIGRATIONS_DIRECTORY: &str = ".codez/migrations";

pub(super) fn is_reserved_migration_path(roots: &LegacyRoots, path: &Path) -> bool {
    path_is_within(path, &roots.user_home().join(MIGRATIONS_DIRECTORY))
}

pub(super) fn validate_backup_layout(
    roots: &LegacyRoots,
    manifest: &MigrationManifest,
    backup_root: &Path,
) -> Result<(), MigrationError> {
    reject_filesystem_redirects(backup_root)?;
    validate_reserved_global_location(roots, backup_root, LayoutKind::Backup)?;
    reject_root_overlap(backup_root, roots.user_data(), LayoutKind::Backup)?;

    let plan = WritePlan::for_backup(manifest, backup_root)?;
    validate_plan_against_sources(roots, manifest, &plan, LayoutKind::Backup)
}

pub(super) fn validate_transform_layout(
    roots: &LegacyRoots,
    manifest: &MigrationManifest,
    backup_root: &Path,
    target_root: &Path,
) -> Result<(), MigrationError> {
    reject_filesystem_redirects(backup_root)?;
    reject_filesystem_redirects(target_root)?;
    validate_reserved_global_location(roots, target_root, LayoutKind::Target)?;
    reject_root_overlap(target_root, roots.user_data(), LayoutKind::Target)?;
    if paths_overlap(backup_root, target_root) {
        return Err(LayoutKind::Target.error(target_root));
    }

    let backup_plan = WritePlan::for_backup(manifest, backup_root)?;
    let target_plan = WritePlan::for_target(manifest, target_root)?;
    if plans_overlap(&backup_plan, &target_plan) {
        return Err(LayoutKind::Target.error(target_root));
    }
    validate_plan_against_sources(roots, manifest, &target_plan, LayoutKind::Target)
}

pub(super) fn reject_filesystem_redirects(path: &Path) -> Result<(), MigrationError> {
    let mut ancestors = path.ancestors().collect::<Vec<_>>();
    ancestors.reverse();
    for current in ancestors {
        match fs::symlink_metadata(current) {
            Ok(metadata) if metadata_is_redirect(&metadata) => {
                return Err(MigrationError::SymbolicLink(current.to_path_buf()));
            }
            Ok(_) => {}
            Err(source) if source.kind() == io::ErrorKind::NotFound => break,
            Err(source) => {
                return Err(MigrationError::Io {
                    operation: "inspect migration path component",
                    path: current.to_path_buf(),
                    source,
                });
            }
        }
    }
    Ok(())
}

pub(super) fn metadata_is_redirect(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt as _;

        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        metadata.file_type().is_symlink()
            || metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

#[derive(Clone, Copy)]
enum LayoutKind {
    Backup,
    Target,
}

impl LayoutKind {
    fn error(self, path: &Path) -> MigrationError {
        match self {
            Self::Backup => MigrationError::OverlappingBackupRoot(path.to_path_buf()),
            Self::Target => MigrationError::OverlappingTargetRoot(path.to_path_buf()),
        }
    }
}

struct WritePlan {
    root: PathBuf,
    subtrees: Vec<PathBuf>,
    files: Vec<PathBuf>,
}

impl WritePlan {
    fn for_backup(
        manifest: &MigrationManifest,
        backup_root: &Path,
    ) -> Result<Self, MigrationError> {
        let run_directory = backup_root.join(manifest.run_id.as_str());
        let mut files = Vec::with_capacity(manifest.entries.len().saturating_add(3));
        for entry in &manifest.entries {
            validate_relative_path(&entry.relative_path)?;
            files.push(
                run_directory
                    .join(entry.scope.backup_directory_name())
                    .join(&entry.relative_path),
            );
        }
        files.extend([
            run_directory.join("migration-manifest.json"),
            run_directory.join("backup-complete.json"),
            run_directory.join("credential-migration.json"),
        ]);
        Ok(Self {
            root: backup_root.to_path_buf(),
            subtrees: vec![run_directory],
            files,
        })
    }

    fn for_target(
        manifest: &MigrationManifest,
        target_root: &Path,
    ) -> Result<Self, MigrationError> {
        let run_directory = target_root
            .join("migration-repositories")
            .join(manifest.run_id.as_str());
        let repository = run_directory.join("repository");
        let mut files = Vec::with_capacity(manifest.entries.len().saturating_add(2));
        for entry in &manifest.entries {
            validate_relative_path(&entry.relative_path)?;
            if entry.format != LegacyFormat::SecretEnvelope {
                files.push(
                    repository
                        .join(entry.scope.backup_directory_name())
                        .join(&entry.relative_path),
                );
            }
        }
        files.extend([
            run_directory.join("transform-complete.json"),
            target_root.join("migration-commit.json"),
        ]);
        Ok(Self {
            root: target_root.to_path_buf(),
            subtrees: vec![run_directory],
            files,
        })
    }
}

fn validate_plan_against_sources(
    roots: &LegacyRoots,
    manifest: &MigrationManifest,
    plan: &WritePlan,
    kind: LayoutKind,
) -> Result<(), MigrationError> {
    for entry in &manifest.entries {
        validate_relative_path(&entry.relative_path)?;
        let source_root = roots.resolve_scope(entry.scope)?;
        let source = source_root.join(&entry.relative_path);
        reject_filesystem_redirects(&source)?;
        if plan_overlaps_path(plan, &source) {
            return Err(kind.error(&plan.root));
        }
    }

    for spec in &LEGACY_DATA_CATALOG {
        for rule in spec.rules {
            for scope_root in scope_roots(roots, rule.scope()) {
                match *rule {
                    DiscoveryRule::ExactFile { relative_path, .. } => {
                        if plan_overlaps_path(plan, &scope_root.join(relative_path)) {
                            return Err(kind.error(&plan.root));
                        }
                    }
                    DiscoveryRule::PrefixFiles {
                        relative_directory,
                        prefix,
                        ..
                    } => {
                        let directory = scope_root.join(relative_directory);
                        if plan.files.iter().any(|path| {
                            path.parent()
                                .is_some_and(|parent| paths_equal(parent, &directory))
                                && path
                                    .file_name()
                                    .and_then(|name| name.to_str())
                                    .is_some_and(|name| rotated_file_matches(name, prefix))
                        }) {
                            return Err(kind.error(&plan.root));
                        }
                    }
                    DiscoveryRule::RecursiveTree {
                        relative_directory, ..
                    } => {
                        let tree = scope_root.join(relative_directory);
                        if plan_overlaps_path(plan, &tree) {
                            return Err(kind.error(&plan.root));
                        }
                    }
                }
            }
        }
    }
    Ok(())
}

fn validate_reserved_global_location(
    roots: &LegacyRoots,
    write_root: &Path,
    kind: LayoutKind,
) -> Result<(), MigrationError> {
    let global_root = roots.user_home().join(".codez");
    if paths_overlap(write_root, &global_root)
        && !path_is_within(write_root, &global_root.join("migrations"))
    {
        return Err(kind.error(write_root));
    }
    Ok(())
}

fn reject_root_overlap(
    write_root: &Path,
    protected_root: &Path,
    kind: LayoutKind,
) -> Result<(), MigrationError> {
    if paths_overlap(write_root, protected_root) {
        Err(kind.error(write_root))
    } else {
        Ok(())
    }
}

fn plans_overlap(left: &WritePlan, right: &WritePlan) -> bool {
    left.subtrees.iter().any(|left_tree| {
        right
            .subtrees
            .iter()
            .any(|right_tree| paths_overlap(left_tree, right_tree))
            || right
                .files
                .iter()
                .any(|right_file| path_is_within(right_file, left_tree))
    }) || right.subtrees.iter().any(|right_tree| {
        left.files
            .iter()
            .any(|left_file| path_is_within(left_file, right_tree))
    }) || left.files.iter().any(|left_file| {
        right
            .files
            .iter()
            .any(|right_file| paths_equal(left_file, right_file))
    })
}

fn plan_overlaps_path(plan: &WritePlan, path: &Path) -> bool {
    path_is_within(path, &plan.root)
        || plan
            .subtrees
            .iter()
            .any(|subtree| paths_overlap(subtree, path))
        || plan.files.iter().any(|file| paths_equal(file, path))
}

fn scope_roots(roots: &LegacyRoots, scope: RootScope) -> Vec<&Path> {
    match scope {
        RootScope::UserData => vec![roots.user_data()],
        RootScope::UserHome => vec![roots.user_home()],
        RootScope::Workspace => roots.workspaces().iter().map(PathBuf::as_path).collect(),
    }
}

fn paths_overlap(left: &Path, right: &Path) -> bool {
    path_is_within(left, right) || path_is_within(right, left)
}

fn paths_equal(left: &Path, right: &Path) -> bool {
    comparison_components(left) == comparison_components(right)
}

fn path_is_within(path: &Path, ancestor: &Path) -> bool {
    let path = comparison_components(path);
    let ancestor = comparison_components(ancestor);
    path.len() >= ancestor.len() && path[..ancestor.len()] == ancestor
}

#[cfg(not(windows))]
fn comparison_components(path: &Path) -> Vec<OsString> {
    path.components()
        .filter(|component| *component != Component::CurDir)
        .map(|component| component.as_os_str().to_os_string())
        .collect()
}

#[cfg(windows)]
fn comparison_components(path: &Path) -> Vec<OsString> {
    path.components()
        .filter(|component| *component != Component::CurDir)
        .map(|component| OsString::from(component.as_os_str().to_string_lossy().to_lowercase()))
        .collect()
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

fn rotated_file_matches(file_name: &str, base_name: &str) -> bool {
    if file_name == base_name {
        return true;
    }
    file_name
        .strip_prefix(base_name)
        .and_then(|suffix| suffix.strip_prefix('.'))
        .is_some_and(|suffix| matches!(suffix, "1" | "2" | "3" | "4"))
}
