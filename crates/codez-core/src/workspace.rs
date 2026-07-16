use thiserror::Error;

use crate::WorkspaceRoot;

const MAX_ID_BYTES: usize = 160;
const MAX_NAME_BYTES: usize = 256;
const MAX_PROJECT_TYPE_BYTES: usize = 64;
const MAX_TIMESTAMP_BYTES: usize = 64;

/// Validated recently opened workspace retained by the repository port.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentProject {
    id: String,
    root: WorkspaceRoot,
    name: String,
    project_type: String,
    opened_at: String,
}

/// A recent-project record cannot satisfy bounded persistence invariants.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum RecentProjectError {
    #[error("recent project {field} cannot be empty")]
    Empty { field: &'static str },
    #[error("recent project {field} exceeds its {max_bytes}-byte limit")]
    TooLong {
        field: &'static str,
        max_bytes: usize,
    },
}

impl RecentProject {
    /// Creates one bounded record from a physically validated workspace root.
    ///
    /// # Errors
    ///
    /// Returns [`RecentProjectError`] for empty or oversized text fields.
    pub fn new(
        id: String,
        root: WorkspaceRoot,
        name: String,
        project_type: String,
        opened_at: String,
    ) -> Result<Self, RecentProjectError> {
        validate_field("id", &id, MAX_ID_BYTES)?;
        validate_field("name", &name, MAX_NAME_BYTES)?;
        validate_field("project type", &project_type, MAX_PROJECT_TYPE_BYTES)?;
        validate_field("opened at", &opened_at, MAX_TIMESTAMP_BYTES)?;
        Ok(Self {
            id,
            root,
            name,
            project_type,
            opened_at,
        })
    }

    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }

    #[must_use]
    pub const fn root(&self) -> &WorkspaceRoot {
        &self.root
    }

    #[must_use]
    pub fn name(&self) -> &str {
        &self.name
    }

    #[must_use]
    pub fn project_type(&self) -> &str {
        &self.project_type
    }

    #[must_use]
    pub fn opened_at(&self) -> &str {
        &self.opened_at
    }

    /// Updates the display name after applying the same persistence bound.
    ///
    /// # Errors
    ///
    /// Returns [`RecentProjectError`] for an empty or oversized name.
    pub fn rename(&mut self, name: String) -> Result<(), RecentProjectError> {
        validate_field("name", &name, MAX_NAME_BYTES)?;
        self.name = name;
        Ok(())
    }
}

fn validate_field(
    field: &'static str,
    value: &str,
    max_bytes: usize,
) -> Result<(), RecentProjectError> {
    if value.trim().is_empty() {
        return Err(RecentProjectError::Empty { field });
    }
    if value.len() > max_bytes {
        return Err(RecentProjectError::TooLong { field, max_bytes });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{RecentProject, RecentProjectError};
    use crate::WorkspaceRoot;

    fn root() -> WorkspaceRoot {
        WorkspaceRoot::from_canonical(std::env::temp_dir().join("codez-recent-project"))
            .expect("fixture workspace root must be absolute")
    }

    #[test]
    fn recent_projects_reject_empty_and_oversized_user_fields() {
        let empty = RecentProject::new(
            "id".to_string(),
            root(),
            " ".to_string(),
            "rust".to_string(),
            "2026-07-16T00:00:00Z".to_string(),
        );
        let oversized = RecentProject::new(
            "id".to_string(),
            root(),
            "x".repeat(257),
            "rust".to_string(),
            "2026-07-16T00:00:00Z".to_string(),
        );

        assert!(matches!(
            empty,
            Err(RecentProjectError::Empty { field: "name" })
        ));
        assert!(matches!(
            oversized,
            Err(RecentProjectError::TooLong { field: "name", .. })
        ));
    }
}
