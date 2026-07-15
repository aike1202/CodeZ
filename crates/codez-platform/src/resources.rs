use std::{fs, path::PathBuf};

use thiserror::Error;

const REQUIRED_BUILTIN_SKILLS: [&str; 3] = ["find-skills", "rule-creator", "skill-creator"];

/// Resolves immutable files bundled next to the Tauri executable.
#[derive(Debug, Clone)]
pub struct ResourceLocator {
    root: PathBuf,
}

/// Required resource paths after their type and presence have been validated.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RequiredResources {
    pub builtin_skills_directory: PathBuf,
    pub ripgrep_executable: PathBuf,
}

/// A required bundled resource is missing or has the wrong filesystem type.
#[derive(Debug, Error)]
pub enum ResourceError {
    #[error("required resource directory is missing: {0}")]
    MissingDirectory(PathBuf),
    #[error("required resource file is missing: {0}")]
    MissingFile(PathBuf),
    #[error("failed to inspect bundled resource {path}: {source}")]
    Inspect {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}

impl ResourceLocator {
    /// Creates a locator rooted at Tauri's platform-specific `resource_dir`.
    #[must_use]
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Returns the root supplied by the Tauri path resolver.
    #[must_use]
    pub fn root(&self) -> &std::path::Path {
        &self.root
    }

    /// Returns the fixed installed path containing the three built-in skills.
    #[must_use]
    pub fn builtin_skills_directory(&self) -> PathBuf {
        self.root.join("builtin-skills")
    }

    /// Returns the fixed installed ripgrep executable path for this target OS.
    #[must_use]
    pub fn ripgrep_executable(&self) -> PathBuf {
        self.root
            .join("tools")
            .join(if cfg!(windows) { "rg.exe" } else { "rg" })
    }

    /// Validates all resources required before local tools and built-in skills start.
    ///
    /// # Errors
    ///
    /// Returns [`ResourceError`] when a path cannot be inspected, a built-in skill
    /// directory is absent, or the bundled ripgrep executable is absent.
    pub fn validate_required(&self) -> Result<RequiredResources, ResourceError> {
        let builtin_skills_directory = self.builtin_skills_directory();
        require_directory(&builtin_skills_directory)?;
        for skill in REQUIRED_BUILTIN_SKILLS {
            require_file(&builtin_skills_directory.join(skill).join("SKILL.md"))?;
        }

        let ripgrep_executable = self.ripgrep_executable();
        require_file(&ripgrep_executable)?;
        Ok(RequiredResources {
            builtin_skills_directory,
            ripgrep_executable,
        })
    }
}

fn require_directory(path: &std::path::Path) -> Result<(), ResourceError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(ResourceError::MissingDirectory(path.to_path_buf()));
        }
        Err(source) => {
            return Err(ResourceError::Inspect {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    if metadata.is_dir() {
        Ok(())
    } else {
        Err(ResourceError::MissingDirectory(path.to_path_buf()))
    }
}

fn require_file(path: &std::path::Path) -> Result<(), ResourceError> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(source) if source.kind() == std::io::ErrorKind::NotFound => {
            return Err(ResourceError::MissingFile(path.to_path_buf()));
        }
        Err(source) => {
            return Err(ResourceError::Inspect {
                path: path.to_path_buf(),
                source,
            });
        }
    };
    if metadata.is_file() {
        Ok(())
    } else {
        Err(ResourceError::MissingFile(path.to_path_buf()))
    }
}
