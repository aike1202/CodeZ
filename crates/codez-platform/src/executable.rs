use std::{
    collections::BTreeMap,
    env,
    ffi::{OsStr, OsString},
    fs, io,
    path::{Path, PathBuf},
};

use codez_core::AppError;
use thiserror::Error;

const GIT_EXECUTABLE_OVERRIDE: &str = "CODEZ_GIT_PATH";
const INHERITED_ENVIRONMENT_KEYS: &[&str] = &[
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "XDG_CONFIG_HOME",
    "XDG_CONFIG_DIRS",
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "SSH_AUTH_SOCK",
];

/// A host-resolved Git executable and the complete environment passed to it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GitInstallation {
    executable: PathBuf,
    environment: BTreeMap<OsString, OsString>,
}

/// Failure to resolve a safe, absolute Git executable at the platform boundary.
#[derive(Debug, Error)]
pub enum GitDiscoveryError {
    #[error("configured Git executable path must be absolute: {0}")]
    RelativeOverride(PathBuf),
    #[error("configured Git executable is not an executable file: {0}")]
    InvalidOverride(PathBuf),
    #[error("failed to inspect configured Git executable {path}: {source}")]
    InspectOverride {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Git executable was not found in CODEZ_GIT_PATH, PATH, or a standard install location")]
    NotFound,
    #[error("failed to construct the explicit Git PATH environment: {0}")]
    InvalidPath(#[source] env::JoinPathsError),
}

impl From<GitDiscoveryError> for AppError {
    fn from(value: GitDiscoveryError) -> Self {
        match value {
            GitDiscoveryError::RelativeOverride(_) | GitDiscoveryError::InvalidOverride(_) => {
                AppError::validation("The configured Git executable is invalid")
            }
            GitDiscoveryError::NotFound => AppError::not_found("Git executable was not found"),
            GitDiscoveryError::InspectOverride { .. } | GitDiscoveryError::InvalidPath(_) => {
                AppError::external("Git executable discovery failed", value.to_string(), false)
            }
        }
    }
}

impl GitInstallation {
    /// Discovers Git from an explicit override, the host `PATH`, then common
    /// platform install locations.
    ///
    /// The resulting environment is captured once at this adapter boundary so
    /// process execution never performs an ambient executable or variable lookup.
    ///
    /// # Errors
    ///
    /// Returns [`GitDiscoveryError`] when an explicit override is invalid, Git
    /// cannot be found, or an explicit `PATH` cannot be constructed.
    pub fn discover() -> Result<Self, GitDiscoveryError> {
        let get_environment = |key: &str| env::var_os(key);
        let platform_candidates = platform_git_candidates(&get_environment);
        discover_git_with(&get_environment, &platform_candidates)
    }

    /// Splits the installation into values suitable for dependency injection.
    #[must_use]
    pub fn into_parts(self) -> (PathBuf, BTreeMap<OsString, OsString>) {
        (self.executable, self.environment)
    }
}

fn discover_git_with<F>(
    get_environment: &F,
    platform_candidates: &[PathBuf],
) -> Result<GitInstallation, GitDiscoveryError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let search_directories = get_environment("PATH")
        .map(|value| {
            env::split_paths(&value)
                .filter(|path| path.is_absolute())
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let executable = match get_environment(GIT_EXECUTABLE_OVERRIDE)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        Some(path) => resolve_override(path)?,
        None => resolve_from_candidates(&search_directories, platform_candidates)
            .ok_or(GitDiscoveryError::NotFound)?,
    };
    let environment = build_git_environment(get_environment, &executable, &search_directories)?;

    Ok(GitInstallation {
        executable,
        environment,
    })
}

fn resolve_override(path: PathBuf) -> Result<PathBuf, GitDiscoveryError> {
    if !path.is_absolute() {
        return Err(GitDiscoveryError::RelativeOverride(path));
    }
    match canonical_executable(&path) {
        Ok(Some(executable)) => Ok(executable),
        Ok(None) => Err(GitDiscoveryError::InvalidOverride(path)),
        Err(source) => Err(GitDiscoveryError::InspectOverride { path, source }),
    }
}

fn resolve_from_candidates(
    search_directories: &[PathBuf],
    platform_candidates: &[PathBuf],
) -> Option<PathBuf> {
    search_directories
        .iter()
        .map(|directory| directory.join(git_executable_name()))
        .chain(platform_candidates.iter().cloned())
        .find_map(|candidate| canonical_executable(&candidate).ok().flatten())
}

fn canonical_executable(path: &Path) -> io::Result<Option<PathBuf>> {
    if !path.is_absolute() {
        return Ok(None);
    }
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(source),
    };
    if !metadata.is_file() || !has_executable_permissions(&metadata) {
        return Ok(None);
    }
    dunce::canonicalize(path).map(Some)
}

#[cfg(unix)]
fn has_executable_permissions(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;

    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn has_executable_permissions(_metadata: &fs::Metadata) -> bool {
    true
}

fn build_git_environment<F>(
    get_environment: &F,
    executable: &Path,
    search_directories: &[PathBuf],
) -> Result<BTreeMap<OsString, OsString>, GitDiscoveryError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let mut environment = INHERITED_ENVIRONMENT_KEYS
        .iter()
        .filter_map(|key| get_environment(key).map(|value| (OsString::from(*key), value)))
        .collect::<BTreeMap<_, _>>();

    let mut explicit_path = Vec::new();
    if let Some(parent) = executable.parent() {
        push_unique_path(&mut explicit_path, parent.to_path_buf());
    }
    for directory in search_directories {
        push_unique_path(&mut explicit_path, directory.clone());
    }
    let path = env::join_paths(explicit_path).map_err(GitDiscoveryError::InvalidPath)?;

    environment.insert(OsString::from("PATH"), path);
    environment.insert(OsString::from("GIT_TERMINAL_PROMPT"), OsString::from("0"));
    environment.insert(OsString::from("GCM_INTERACTIVE"), OsString::from("Never"));
    environment.insert(OsString::from("LC_ALL"), OsString::from("C"));
    Ok(environment)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, candidate: PathBuf) {
    if !paths.iter().any(|path| paths_equal(path, &candidate)) {
        paths.push(candidate);
    }
}

#[cfg(windows)]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left.as_os_str()
        .to_string_lossy()
        .eq_ignore_ascii_case(&right.as_os_str().to_string_lossy())
}

#[cfg(not(windows))]
fn paths_equal(left: &Path, right: &Path) -> bool {
    left == right
}

#[cfg(windows)]
fn git_executable_name() -> &'static OsStr {
    OsStr::new("git.exe")
}

#[cfg(not(windows))]
fn git_executable_name() -> &'static OsStr {
    OsStr::new("git")
}

#[cfg(windows)]
fn platform_git_candidates<F>(get_environment: &F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    let mut candidates = Vec::new();
    for key in ["ProgramFiles", "ProgramW6432", "ProgramFiles(x86)"] {
        let Some(root) = get_environment(key).map(PathBuf::from) else {
            continue;
        };
        push_unique_path(&mut candidates, root.join("Git/cmd/git.exe"));
        push_unique_path(&mut candidates, root.join("Git/bin/git.exe"));
    }
    if let Some(root) = get_environment("LOCALAPPDATA").map(PathBuf::from) {
        push_unique_path(&mut candidates, root.join("Programs/Git/cmd/git.exe"));
    }
    if let Some(root) = get_environment("USERPROFILE").map(PathBuf::from) {
        push_unique_path(
            &mut candidates,
            root.join("scoop/apps/git/current/cmd/git.exe"),
        );
    }
    candidates
}

#[cfg(target_os = "macos")]
fn platform_git_candidates<F>(_get_environment: &F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    [
        "/opt/homebrew/bin/git",
        "/usr/local/bin/git",
        "/usr/bin/git",
    ]
    .into_iter()
    .map(PathBuf::from)
    .collect()
}

#[cfg(all(unix, not(target_os = "macos")))]
fn platform_git_candidates<F>(_get_environment: &F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    ["/usr/local/bin/git", "/usr/bin/git", "/bin/git"]
        .into_iter()
        .map(PathBuf::from)
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn platform_git_candidates<F>(_get_environment: &F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    Vec::new()
}

#[cfg(test)]
mod tests {
    use std::{
        collections::BTreeMap,
        env,
        ffi::{OsStr, OsString},
        fs,
        path::Path,
    };

    use tempfile::tempdir;

    use super::{
        GIT_EXECUTABLE_OVERRIDE, GitDiscoveryError, discover_git_with, git_executable_name,
    };

    fn create_executable(path: &Path) {
        fs::write(path, b"test executable").expect("test executable should be created");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;

            let mut permissions = fs::metadata(path)
                .expect("test executable metadata should be available")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions)
                .expect("test executable permissions should be updated");
        }
    }

    #[test]
    fn discover_should_use_an_absolute_override() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(git_executable_name());
        create_executable(&executable);
        let values = BTreeMap::from([(
            GIT_EXECUTABLE_OVERRIDE.to_string(),
            executable.as_os_str().to_owned(),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_git_with(&get_environment, &[])
            .expect("an absolute executable override should resolve");

        assert_eq!(
            installation.executable,
            dunce::canonicalize(executable).expect("test executable should canonicalize")
        );
    }

    #[test]
    fn discover_should_reject_a_relative_override() {
        let values = BTreeMap::from([(
            GIT_EXECUTABLE_OVERRIDE.to_string(),
            OsString::from(git_executable_name()),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let error = discover_git_with(&get_environment, &[])
            .expect_err("a relative executable override must be rejected");

        assert!(matches!(error, GitDiscoveryError::RelativeOverride(_)));
    }

    #[test]
    fn discover_should_resolve_git_from_an_absolute_path_entry() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(git_executable_name());
        create_executable(&executable);
        let values = BTreeMap::from([(
            "PATH".to_string(),
            env::join_paths([directory.path()]).expect("test PATH should be valid"),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_git_with(&get_environment, &[])
            .expect("Git should resolve from an absolute PATH entry");

        assert_eq!(
            installation.executable,
            dunce::canonicalize(executable).expect("test executable should canonicalize")
        );
    }

    #[test]
    fn discover_should_fall_back_to_a_platform_candidate() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(git_executable_name());
        create_executable(&executable);
        let values = BTreeMap::<String, OsString>::new();
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_git_with(&get_environment, std::slice::from_ref(&executable))
            .expect("a valid platform candidate should resolve");

        assert_eq!(
            installation.executable,
            dunce::canonicalize(executable).expect("test executable should canonicalize")
        );
    }

    #[test]
    fn discover_should_not_inherit_unrelated_environment_values() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(git_executable_name());
        create_executable(&executable);
        let values = BTreeMap::from([
            (
                GIT_EXECUTABLE_OVERRIDE.to_string(),
                executable.as_os_str().to_owned(),
            ),
            ("UNRELATED_SECRET".to_string(), OsString::from("secret")),
        ]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation =
            discover_git_with(&get_environment, &[]).expect("test Git installation should resolve");

        assert!(
            !installation
                .environment
                .contains_key(OsStr::new("UNRELATED_SECRET"))
        );
    }

    #[test]
    fn discover_should_disable_interactive_git_prompts() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(git_executable_name());
        create_executable(&executable);
        let values = BTreeMap::from([(
            GIT_EXECUTABLE_OVERRIDE.to_string(),
            executable.as_os_str().to_owned(),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation =
            discover_git_with(&get_environment, &[]).expect("test Git installation should resolve");

        assert_eq!(
            installation
                .environment
                .get(OsStr::new("GIT_TERMINAL_PROMPT")),
            Some(&OsString::from("0"))
        );
    }
}
