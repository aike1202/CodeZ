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
const BASH_EXECUTABLE_OVERRIDES: &[&str] = &["CODEZ_BASH_PATH", "GIT_BASH_PATH"];
const POWERSHELL_EXECUTABLE_OVERRIDE: &str = "CODEZ_POWERSHELL_PATH";
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
const POWERSHELL_INHERITED_ENVIRONMENT_KEYS: &[&str] = &[
    "SystemRoot",
    "WINDIR",
    "COMSPEC",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "TEMP",
    "TMP",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PATHEXT",
    "PSModulePath",
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

/// A host-resolved Bash executable and its complete filtered child environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BashInstallation {
    executable: PathBuf,
    environment: BTreeMap<OsString, OsString>,
}

/// Failure to resolve a canonical Bash executable at the platform boundary.
#[derive(Debug, Error)]
pub enum BashDiscoveryError {
    #[error("configured Bash executable path must be absolute: {0}")]
    RelativeOverride(PathBuf),
    #[error("configured Bash executable is not a regular bash executable: {0}")]
    InvalidOverride(PathBuf),
    #[error("failed to inspect configured Bash executable {path}: {source}")]
    InspectOverride {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Bash was not found in an explicit override or a standard installation")]
    NotFound,
    #[error("failed to construct the explicit Bash PATH environment: {0}")]
    InvalidPath(#[source] env::JoinPathsError),
}

impl From<BashDiscoveryError> for AppError {
    fn from(value: BashDiscoveryError) -> Self {
        match value {
            BashDiscoveryError::RelativeOverride(_) | BashDiscoveryError::InvalidOverride(_) => {
                AppError::validation("The configured Bash executable is invalid")
            }
            BashDiscoveryError::NotFound => AppError::not_found("Bash executable was not found"),
            BashDiscoveryError::InspectOverride { .. } | BashDiscoveryError::InvalidPath(_) => {
                AppError::external("Bash executable discovery failed", value.to_string(), false)
            }
        }
    }
}

impl BashInstallation {
    /// Discovers Bash from an explicit absolute override or fixed platform locations.
    ///
    /// `CODEZ_BASH_PATH` takes precedence over `GIT_BASH_PATH`. An invalid
    /// override fails closed instead of falling through to another executable.
    /// The child environment is captured once and contains only allowlisted
    /// values plus a rebuilt PATH of absolute directories.
    ///
    /// # Errors
    ///
    /// Returns [`BashDiscoveryError`] when an override is invalid, no standard
    /// Bash executable exists, or the explicit PATH cannot be constructed.
    pub fn discover() -> Result<Self, BashDiscoveryError> {
        let get_environment = |key: &str| env::var_os(key);
        let candidates = platform_bash_candidates(&get_environment);
        discover_bash_with(&get_environment, &candidates)
    }

    /// Splits the installation into values suitable for `codez-runtime` injection.
    #[must_use]
    pub fn into_parts(self) -> (PathBuf, BTreeMap<OsString, OsString>) {
        (self.executable, self.environment)
    }
}

fn discover_bash_with<F>(
    get_environment: &F,
    platform_candidates: &[PathBuf],
) -> Result<BashInstallation, BashDiscoveryError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let configured = BASH_EXECUTABLE_OVERRIDES.iter().find_map(|key| {
        get_environment(key)
            .filter(|value| !value.is_empty())
            .map(PathBuf::from)
    });
    let executable = match configured {
        Some(path) => resolve_bash_override(path)?,
        None => platform_candidates
            .iter()
            .find_map(|candidate| canonical_bash_executable(candidate).ok().flatten())
            .ok_or(BashDiscoveryError::NotFound)?,
    };
    let environment = build_bash_environment(get_environment, &executable)?;
    Ok(BashInstallation {
        executable,
        environment,
    })
}

fn resolve_bash_override(path: PathBuf) -> Result<PathBuf, BashDiscoveryError> {
    if !path.is_absolute() {
        return Err(BashDiscoveryError::RelativeOverride(path));
    }
    match canonical_bash_executable(&path) {
        Ok(Some(executable)) => Ok(executable),
        Ok(None) => Err(BashDiscoveryError::InvalidOverride(path)),
        Err(source) => Err(BashDiscoveryError::InspectOverride { path, source }),
    }
}

fn canonical_bash_executable(path: &Path) -> io::Result<Option<PathBuf>> {
    let Some(executable) = canonical_executable(path)? else {
        return Ok(None);
    };
    if !is_bash_executable(&executable) {
        return Ok(None);
    }
    Ok(Some(executable))
}

fn is_bash_executable(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| {
            if cfg!(windows) {
                name.eq_ignore_ascii_case("bash.exe")
            } else {
                name == "bash"
            }
        })
}

fn build_bash_environment<F>(
    get_environment: &F,
    executable: &Path,
) -> Result<BTreeMap<OsString, OsString>, BashDiscoveryError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let mut environment = INHERITED_ENVIRONMENT_KEYS
        .iter()
        .filter_map(|key| get_environment(key).map(|value| (OsString::from(*key), value)))
        .collect::<BTreeMap<_, _>>();
    let mut explicit_path = bash_installation_directories(executable);
    if let Some(path) = get_environment("PATH") {
        for directory in env::split_paths(&path).filter(|path| path.is_absolute()) {
            push_unique_path(&mut explicit_path, directory);
        }
    }
    let path = env::join_paths(explicit_path).map_err(BashDiscoveryError::InvalidPath)?;
    environment.insert(OsString::from("PATH"), path);
    environment.insert(OsString::from("CHERE_INVOKING"), OsString::from("1"));
    Ok(environment)
}

fn bash_installation_directories(executable: &Path) -> Vec<PathBuf> {
    let mut directories = Vec::new();
    let Some(parent) = executable.parent() else {
        return directories;
    };
    push_unique_path(&mut directories, parent.to_path_buf());

    #[cfg(windows)]
    if parent
        .file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
    {
        let installation_root = parent.parent().and_then(|candidate| {
            if candidate
                .file_name()
                .and_then(OsStr::to_str)
                .is_some_and(|name| name.eq_ignore_ascii_case("usr"))
            {
                candidate.parent()
            } else {
                Some(candidate)
            }
        });
        if let Some(root) = installation_root {
            for relative in ["cmd", "bin", "usr/bin", "mingw64/bin"] {
                let candidate = root.join(relative);
                if candidate.is_absolute() && candidate.is_dir() {
                    push_unique_path(&mut directories, candidate);
                }
            }
        }
    }
    directories
}

fn platform_bash_candidates<F>(get_environment: &F) -> Vec<PathBuf>
where
    F: Fn(&str) -> Option<OsString>,
{
    #[cfg(windows)]
    {
        let mut roots = ["ProgramFiles", "ProgramFiles(x86)"]
            .into_iter()
            .filter_map(get_environment)
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .collect::<Vec<_>>();
        for fallback in [r"C:\Program Files", r"C:\Program Files (x86)"] {
            push_unique_path(&mut roots, PathBuf::from(fallback));
        }
        roots
            .into_iter()
            .flat_map(|root| {
                [
                    root.join("Git/bin/bash.exe"),
                    root.join("Git/usr/bin/bash.exe"),
                ]
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        let _ = get_environment;
        vec![PathBuf::from("/bin/bash"), PathBuf::from("/usr/bin/bash")]
    }
}

/// A host-resolved Windows PowerShell executable and its complete child environment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PowerShellInstallation {
    executable: PathBuf,
    environment: BTreeMap<OsString, OsString>,
}

/// Failure to resolve the trusted Windows PowerShell host executable.
#[derive(Debug, Error)]
pub enum PowerShellDiscoveryError {
    #[error("configured PowerShell executable path must be absolute: {0}")]
    RelativeOverride(PathBuf),
    #[error("configured PowerShell executable is not powershell.exe or is not a regular file: {0}")]
    InvalidOverride(PathBuf),
    #[error("failed to inspect configured PowerShell executable {path}: {source}")]
    InspectOverride {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to inspect the Windows PowerShell installation {path}: {source}")]
    InspectInstallation {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("Windows PowerShell is unavailable on this platform")]
    UnsupportedPlatform,
    #[error(
        "powershell.exe was not found in CODEZ_POWERSHELL_PATH or the standard Windows installation"
    )]
    NotFound,
    #[error("failed to construct the explicit PowerShell PATH environment: {0}")]
    InvalidPath(#[source] env::JoinPathsError),
}

impl From<PowerShellDiscoveryError> for AppError {
    fn from(value: PowerShellDiscoveryError) -> Self {
        match value {
            PowerShellDiscoveryError::RelativeOverride(_)
            | PowerShellDiscoveryError::InvalidOverride(_) => {
                AppError::validation("The configured PowerShell executable is invalid")
            }
            PowerShellDiscoveryError::UnsupportedPlatform => {
                AppError::unsupported("Windows PowerShell is unavailable on this platform")
            }
            PowerShellDiscoveryError::NotFound => {
                AppError::not_found("Windows PowerShell executable was not found")
            }
            PowerShellDiscoveryError::InspectOverride { .. }
            | PowerShellDiscoveryError::InspectInstallation { .. }
            | PowerShellDiscoveryError::InvalidPath(_) => AppError::external(
                "PowerShell executable discovery failed",
                value.to_string(),
                false,
            ),
        }
    }
}

impl PowerShellInstallation {
    /// Discovers the canonical Windows PowerShell executable and captures its
    /// explicitly filtered child environment.
    ///
    /// `CODEZ_POWERSHELL_PATH` takes precedence and must name an absolute,
    /// regular `powershell.exe`. Without an override, the adapter checks the
    /// standard Windows PowerShell 5.1 installation below `SystemRoot`.
    ///
    /// # Errors
    ///
    /// Returns [`PowerShellDiscoveryError`] when the platform is unsupported,
    /// an override is invalid, no trusted executable exists, or the explicit
    /// child environment cannot be constructed.
    pub fn discover() -> Result<Self, PowerShellDiscoveryError> {
        #[cfg(windows)]
        {
            let get_environment = |key: &str| env::var_os(key);
            discover_windows_powershell_with(&get_environment)
        }
        #[cfg(not(windows))]
        {
            Err(PowerShellDiscoveryError::UnsupportedPlatform)
        }
    }

    /// Splits the installation into values suitable for dependency injection.
    #[must_use]
    pub fn into_parts(self) -> (PathBuf, BTreeMap<OsString, OsString>) {
        (self.executable, self.environment)
    }
}

fn discover_windows_powershell_with<F>(
    get_environment: &F,
) -> Result<PowerShellInstallation, PowerShellDiscoveryError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let executable = match get_environment(POWERSHELL_EXECUTABLE_OVERRIDE)
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
    {
        Some(path) => resolve_powershell_override(path)?,
        None => resolve_standard_powershell(get_environment)?,
    };
    let environment = build_powershell_environment(get_environment, &executable)?;

    Ok(PowerShellInstallation {
        executable,
        environment,
    })
}

fn resolve_powershell_override(path: PathBuf) -> Result<PathBuf, PowerShellDiscoveryError> {
    if !path.is_absolute() {
        return Err(PowerShellDiscoveryError::RelativeOverride(path));
    }
    match canonical_powershell_executable(&path) {
        Ok(Some(executable)) => Ok(executable),
        Ok(None) => Err(PowerShellDiscoveryError::InvalidOverride(path)),
        Err(source) => Err(PowerShellDiscoveryError::InspectOverride { path, source }),
    }
}

fn resolve_standard_powershell<F>(get_environment: &F) -> Result<PathBuf, PowerShellDiscoveryError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let Some(system_root) = get_environment("SystemRoot")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
    else {
        return Err(PowerShellDiscoveryError::NotFound);
    };
    let candidate = system_root.join("System32/WindowsPowerShell/v1.0/powershell.exe");
    match canonical_powershell_executable(&candidate) {
        Ok(Some(executable)) => Ok(executable),
        Ok(None) => Err(PowerShellDiscoveryError::NotFound),
        Err(source) => Err(PowerShellDiscoveryError::InspectInstallation {
            path: candidate,
            source,
        }),
    }
}

fn canonical_powershell_executable(path: &Path) -> io::Result<Option<PathBuf>> {
    let Some(executable) = canonical_executable(path)? else {
        return Ok(None);
    };
    if !is_windows_powershell(&executable) {
        return Ok(None);
    }
    Ok(Some(executable))
}

fn is_windows_powershell(path: &Path) -> bool {
    path.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case("powershell.exe"))
}

fn build_powershell_environment<F>(
    get_environment: &F,
    executable: &Path,
) -> Result<BTreeMap<OsString, OsString>, PowerShellDiscoveryError>
where
    F: Fn(&str) -> Option<OsString>,
{
    let mut environment = POWERSHELL_INHERITED_ENVIRONMENT_KEYS
        .iter()
        .filter_map(|key| get_environment(key).map(|value| (OsString::from(*key), value)))
        .collect::<BTreeMap<_, _>>();

    let mut explicit_path = executable
        .parent()
        .map(Path::to_path_buf)
        .into_iter()
        .collect::<Vec<_>>();
    if let Some(path) = get_environment("PATH") {
        for directory in env::split_paths(&path).filter(|path| path.is_absolute()) {
            push_unique_path(&mut explicit_path, directory);
        }
    }
    let path = env::join_paths(explicit_path).map_err(PowerShellDiscoveryError::InvalidPath)?;
    environment.insert(OsString::from("PATH"), path);
    Ok(environment)
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

    use codez_core::{AppError, AppErrorKind};

    use super::{
        BASH_EXECUTABLE_OVERRIDES, BashDiscoveryError, GIT_EXECUTABLE_OVERRIDE, GitDiscoveryError,
        POWERSHELL_EXECUTABLE_OVERRIDE, POWERSHELL_INHERITED_ENVIRONMENT_KEYS,
        PowerShellDiscoveryError, discover_bash_with, discover_git_with,
        discover_windows_powershell_with, git_executable_name,
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

    fn bash_executable_name() -> &'static str {
        if cfg!(windows) { "bash.exe" } else { "bash" }
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

    #[test]
    fn bash_discovery_should_canonicalize_an_absolute_override() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(bash_executable_name());
        create_executable(&executable);
        let values = BTreeMap::from([(
            BASH_EXECUTABLE_OVERRIDES[0].to_string(),
            executable.as_os_str().to_owned(),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_bash_with(&get_environment, &[])
            .expect("an absolute Bash override should resolve");

        assert_eq!(
            installation.executable,
            dunce::canonicalize(executable).expect("test executable should canonicalize")
        );
    }

    #[test]
    fn bash_discovery_should_reject_a_relative_override() {
        let values = BTreeMap::from([(
            BASH_EXECUTABLE_OVERRIDES[0].to_string(),
            OsString::from(bash_executable_name()),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let error = discover_bash_with(&get_environment, &[])
            .expect_err("a relative Bash override must be rejected");

        assert!(matches!(error, BashDiscoveryError::RelativeOverride(_)));
    }

    #[test]
    fn bash_discovery_should_fail_closed_on_the_first_invalid_override() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(bash_executable_name());
        create_executable(&executable);
        let values = BTreeMap::from([
            (
                BASH_EXECUTABLE_OVERRIDES[0].to_string(),
                OsString::from("relative-bash"),
            ),
            (
                BASH_EXECUTABLE_OVERRIDES[1].to_string(),
                executable.into_os_string(),
            ),
        ]);
        let get_environment = |key: &str| values.get(key).cloned();

        let error = discover_bash_with(&get_environment, &[])
            .expect_err("the first invalid override must not fall through");

        assert!(matches!(error, BashDiscoveryError::RelativeOverride(_)));
    }

    #[test]
    fn bash_discovery_should_use_a_fixed_platform_candidate() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(bash_executable_name());
        create_executable(&executable);
        let values = BTreeMap::<String, OsString>::new();
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_bash_with(&get_environment, std::slice::from_ref(&executable))
            .expect("a fixed Bash candidate should resolve");

        assert_eq!(
            installation.executable,
            dunce::canonicalize(executable).expect("test executable should canonicalize")
        );
    }

    #[test]
    fn bash_discovery_should_filter_environment_and_relative_path_entries() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join(bash_executable_name());
        create_executable(&executable);
        let search_directory = tempdir().expect("search directory should be available");
        let values = BTreeMap::from([
            (
                BASH_EXECUTABLE_OVERRIDES[0].to_string(),
                executable.into_os_string(),
            ),
            ("HOME".to_string(), OsString::from("allowed-home")),
            (
                "PATH".to_string(),
                env::join_paths([Path::new("relative-bin"), search_directory.path()])
                    .expect("test PATH should be valid"),
            ),
            (
                "UNRELATED_SECRET".to_string(),
                OsString::from("must-not-leak"),
            ),
        ]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation =
            discover_bash_with(&get_environment, &[]).expect("Bash fixture should resolve");
        let path = installation
            .environment
            .get(OsStr::new("PATH"))
            .map(env::split_paths)
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();

        assert!(
            installation.environment.get(OsStr::new("HOME"))
                == Some(&OsString::from("allowed-home"))
                && !installation
                    .environment
                    .contains_key(OsStr::new("UNRELATED_SECRET"))
                && path.iter().all(|entry| entry.is_absolute())
                && path.contains(&search_directory.path().to_path_buf())
        );
    }

    fn create_powershell_executable(path: &Path) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("PowerShell fixture directory should be created");
        }
        create_executable(path);
    }

    #[test]
    fn powershell_discovery_should_canonicalize_an_absolute_override() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join("powershell.exe");
        create_powershell_executable(&executable);
        let values = BTreeMap::from([(
            POWERSHELL_EXECUTABLE_OVERRIDE.to_string(),
            executable.as_os_str().to_owned(),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_windows_powershell_with(&get_environment)
            .expect("an absolute powershell.exe override should resolve");

        assert_eq!(
            installation.executable,
            dunce::canonicalize(executable).expect("test executable should canonicalize")
        );
    }

    #[test]
    fn powershell_discovery_should_reject_a_relative_override() {
        let values = BTreeMap::from([(
            POWERSHELL_EXECUTABLE_OVERRIDE.to_string(),
            OsString::from("powershell.exe"),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let error = discover_windows_powershell_with(&get_environment)
            .expect_err("a relative PowerShell override must be rejected");

        assert!(matches!(
            error,
            PowerShellDiscoveryError::RelativeOverride(_)
        ));
    }

    #[test]
    fn powershell_discovery_should_reject_pwsh_override() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join("pwsh.exe");
        create_powershell_executable(&executable);
        let values = BTreeMap::from([(
            POWERSHELL_EXECUTABLE_OVERRIDE.to_string(),
            executable.as_os_str().to_owned(),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let error = discover_windows_powershell_with(&get_environment)
            .expect_err("pwsh.exe is not the Windows PowerShell host contract");

        assert!(matches!(
            error,
            PowerShellDiscoveryError::InvalidOverride(_)
        ));
    }

    #[test]
    fn powershell_discovery_should_use_the_system_root_installation() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory
            .path()
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        create_powershell_executable(&executable);
        let values = BTreeMap::from([(
            "SystemRoot".to_string(),
            directory.path().as_os_str().to_owned(),
        )]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_windows_powershell_with(&get_environment)
            .expect("the standard Windows PowerShell installation should resolve");

        assert_eq!(
            installation.executable,
            dunce::canonicalize(executable).expect("test executable should canonicalize")
        );
    }

    #[test]
    fn powershell_discovery_should_not_fall_back_from_an_invalid_override() {
        let directory = tempdir().expect("temporary directory should be available");
        let standard_executable = directory
            .path()
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
        create_powershell_executable(&standard_executable);
        let values = BTreeMap::from([
            (
                POWERSHELL_EXECUTABLE_OVERRIDE.to_string(),
                directory
                    .path()
                    .join("missing/powershell.exe")
                    .into_os_string(),
            ),
            (
                "SystemRoot".to_string(),
                directory.path().as_os_str().to_owned(),
            ),
        ]);
        let get_environment = |key: &str| values.get(key).cloned();

        let error = discover_windows_powershell_with(&get_environment)
            .expect_err("an invalid override must fail closed");

        assert!(matches!(
            error,
            PowerShellDiscoveryError::InvalidOverride(_)
        ));
    }

    #[test]
    fn powershell_discovery_should_build_only_the_allowlisted_environment() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join("powershell.exe");
        create_powershell_executable(&executable);
        let mut values = POWERSHELL_INHERITED_ENVIRONMENT_KEYS
            .iter()
            .map(|key| (key.to_string(), OsString::from(format!("value-{key}"))))
            .collect::<BTreeMap<_, _>>();
        values.insert(
            POWERSHELL_EXECUTABLE_OVERRIDE.to_string(),
            executable.into_os_string(),
        );
        values.insert(
            "PATH".to_string(),
            env::join_paths([directory.path()]).expect("test PATH should be valid"),
        );
        values.insert(
            "UNRELATED_SECRET".to_string(),
            OsString::from("must-not-leak"),
        );
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_windows_powershell_with(&get_environment)
            .expect("PowerShell fixture should resolve");
        let mut expected = POWERSHELL_INHERITED_ENVIRONMENT_KEYS
            .iter()
            .map(|key| {
                (
                    OsString::from(*key),
                    values
                        .get(*key)
                        .expect("allowlisted fixture value should exist")
                        .clone(),
                )
            })
            .collect::<BTreeMap<_, _>>();
        expected.insert(
            OsString::from("PATH"),
            env::join_paths([installation
                .executable
                .parent()
                .expect("canonical executable should have a parent")])
            .expect("expected PATH should be valid"),
        );

        assert_eq!(installation.environment, expected);
    }

    #[test]
    fn powershell_discovery_should_remove_relative_path_entries() {
        let directory = tempdir().expect("temporary directory should be available");
        let executable = directory.path().join("powershell.exe");
        create_powershell_executable(&executable);
        let search_directory = tempdir().expect("search directory should be available");
        let values = BTreeMap::from([
            (
                POWERSHELL_EXECUTABLE_OVERRIDE.to_string(),
                executable.into_os_string(),
            ),
            (
                "PATH".to_string(),
                env::join_paths([Path::new("relative-bin"), search_directory.path()])
                    .expect("test PATH should be valid"),
            ),
        ]);
        let get_environment = |key: &str| values.get(key).cloned();

        let installation = discover_windows_powershell_with(&get_environment)
            .expect("PowerShell fixture should resolve");
        let actual = installation
            .environment
            .get(OsStr::new("PATH"))
            .map(env::split_paths)
            .into_iter()
            .flatten()
            .collect::<Vec<_>>();
        let expected = vec![
            installation
                .executable
                .parent()
                .expect("canonical executable should have a parent")
                .to_path_buf(),
            search_directory.path().to_path_buf(),
        ];

        assert_eq!(actual, expected);
    }

    #[test]
    fn unsupported_powershell_discovery_should_map_to_an_unsupported_app_error() {
        let error = AppError::from(PowerShellDiscoveryError::UnsupportedPlatform);

        assert_eq!(error.kind(), AppErrorKind::Unsupported);
    }

    #[test]
    fn missing_powershell_discovery_should_map_to_a_not_found_app_error() {
        let error = AppError::from(PowerShellDiscoveryError::NotFound);

        assert_eq!(error.kind(), AppErrorKind::NotFound);
    }

    #[cfg(not(windows))]
    #[test]
    fn powershell_discovery_should_be_typed_as_unsupported_off_windows() {
        let error = super::PowerShellInstallation::discover()
            .expect_err("Windows PowerShell must not be discovered off Windows");

        assert!(matches!(
            error,
            PowerShellDiscoveryError::UnsupportedPlatform
        ));
    }
}
