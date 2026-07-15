use serde::{Deserialize, Serialize};
use thiserror::Error;

const CURRENT_SCHEMA_VERSION: u32 = 1;

/// Stable identity of a versioned JSON or JSONL persistence family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SchemaFamily {
    /// Provider configuration and credential references.
    Providers,
    /// Session index and embedded runtime references.
    Sessions,
    /// General application settings.
    Settings,
    /// Recently opened workspace records.
    RecentProjects,
    /// Persisted permission rules.
    PermissionRules,
    /// Per-workspace permission modes.
    WorkspacePermissions,
    /// Append-only permission decisions and audit evidence.
    PermissionAudit,
    /// User-level MCP server configuration.
    McpUserConfig,
    /// MCP project trust fingerprints.
    McpProjectTrust,
    /// Metadata for immutable MCP content objects.
    McpContentMetadata,
    /// Attachment metadata stored beside immutable payloads.
    AttachmentMetadata,
    /// Canonical append-only context ledger records.
    ContextLedger,
    /// Compacted context ledger snapshot.
    ContextSnapshot,
    /// Edit transaction backup metadata.
    EditBackupMetadata,
    /// Tool execution journal records.
    ToolJournal,
    /// Metadata for persisted large tool results.
    LargeToolResultMetadata,
    /// Durable parallel execution state.
    ParallelExecution,
    /// Global or workspace skill enablement configuration.
    SkillsConfig,
    /// Disposable project analysis cache.
    ProjectAnalysisCache,
}

impl SchemaFamily {
    /// Returns the stable serialized identity for this schema family.
    #[must_use]
    pub const fn id(self) -> &'static str {
        match self {
            Self::Providers => "providers",
            Self::Sessions => "sessions",
            Self::Settings => "settings",
            Self::RecentProjects => "recent-projects",
            Self::PermissionRules => "permission-rules",
            Self::WorkspacePermissions => "workspace-permissions",
            Self::PermissionAudit => "permission-audit",
            Self::McpUserConfig => "mcp-user-config",
            Self::McpProjectTrust => "mcp-project-trust",
            Self::McpContentMetadata => "mcp-content-metadata",
            Self::AttachmentMetadata => "attachment-metadata",
            Self::ContextLedger => "context-ledger",
            Self::ContextSnapshot => "context-snapshot",
            Self::EditBackupMetadata => "edit-backup-metadata",
            Self::ToolJournal => "tool-journal",
            Self::LargeToolResultMetadata => "large-tool-result-metadata",
            Self::ParallelExecution => "parallel-execution",
            Self::SkillsConfig => "skills-config",
            Self::ProjectAnalysisCache => "project-analysis-cache",
        }
    }

    /// Returns the current on-disk version for this family.
    #[must_use]
    pub const fn current_version(self) -> u32 {
        CURRENT_SCHEMA_VERSION
    }

    /// Returns whether this family is stored as JSON or JSONL.
    #[must_use]
    pub const fn format(self) -> SchemaFormat {
        match self {
            Self::PermissionAudit | Self::ContextLedger | Self::ToolJournal => {
                SchemaFormat::JsonLines
            }
            Self::Providers
            | Self::Sessions
            | Self::Settings
            | Self::RecentProjects
            | Self::PermissionRules
            | Self::WorkspacePermissions
            | Self::McpUserConfig
            | Self::McpProjectTrust
            | Self::McpContentMetadata
            | Self::AttachmentMetadata
            | Self::ContextSnapshot
            | Self::EditBackupMetadata
            | Self::LargeToolResultMetadata
            | Self::ParallelExecution
            | Self::SkillsConfig
            | Self::ProjectAnalysisCache => SchemaFormat::Json,
        }
    }
}

/// Physical structured-data format used by a schema family.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SchemaFormat {
    /// One JSON object per file.
    Json,
    /// One independently versioned JSON object per line.
    JsonLines,
}

/// Version header and object payload persisted without an extra nesting layer.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionedDocument<T> {
    schema: SchemaFamily,
    schema_version: u32,
    #[serde(flatten)]
    payload: T,
}

impl<T> VersionedDocument<T> {
    /// Wraps an object payload with the current header for `schema`.
    #[must_use]
    pub const fn new(schema: SchemaFamily, payload: T) -> Self {
        Self {
            schema,
            schema_version: schema.current_version(),
            payload,
        }
    }

    /// Returns the stable schema family declared by this document.
    #[must_use]
    pub const fn schema(&self) -> SchemaFamily {
        self.schema
    }

    /// Returns the serialized schema version.
    #[must_use]
    pub const fn schema_version(&self) -> u32 {
        self.schema_version
    }

    /// Borrows the persistence payload.
    #[must_use]
    pub const fn payload(&self) -> &T {
        &self.payload
    }

    /// Consumes the version header and returns the persistence payload.
    #[must_use]
    pub fn into_payload(self) -> T {
        self.payload
    }

    /// Verifies that this document is supported by the expected repository.
    ///
    /// # Errors
    ///
    /// Returns [`SchemaError`] when the family is wrong or the version is not
    /// the current supported version.
    pub fn validate_for(&self, expected: SchemaFamily) -> Result<(), SchemaError> {
        if self.schema != expected {
            return Err(SchemaError::UnexpectedFamily {
                expected,
                actual: self.schema,
            });
        }
        let supported = expected.current_version();
        if self.schema_version != supported {
            return Err(SchemaError::UnsupportedVersion {
                schema: expected,
                supported,
                actual: self.schema_version,
            });
        }
        Ok(())
    }
}

/// Versioned JSONL record with the same stable header as JSON documents.
pub type VersionedRecord<T> = VersionedDocument<T>;

/// A persistence header cannot be consumed by the selected repository.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum SchemaError {
    /// The file belongs to another persistence family.
    #[error("expected {expected:?} schema but found {actual:?}")]
    UnexpectedFamily {
        expected: SchemaFamily,
        actual: SchemaFamily,
    },
    /// The file version requires a migration not implemented by this binary.
    #[error("unsupported {schema:?} schema version {actual}; current version is {supported}")]
    UnsupportedVersion {
        schema: SchemaFamily,
        supported: u32,
        actual: u32,
    },
}

#[cfg(test)]
mod tests {
    use serde::{Deserialize, Serialize};
    use serde_json::json;

    use super::{SchemaError, SchemaFamily, VersionedDocument};

    #[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
    struct SessionsPayload {
        sessions: Vec<String>,
    }

    #[test]
    fn versioned_document_keeps_legacy_root_fields_without_extra_nesting() {
        let document = VersionedDocument::new(
            SchemaFamily::Sessions,
            SessionsPayload {
                sessions: vec!["session-1".to_string()],
            },
        );

        assert_eq!(
            serde_json::to_value(document).expect("fixture document must serialize"),
            json!({
                "schema": "sessions",
                "schemaVersion": 1,
                "sessions": ["session-1"]
            })
        );
    }

    #[test]
    fn repository_validation_rejects_a_different_schema_family() {
        let document = VersionedDocument::new(
            SchemaFamily::Settings,
            SessionsPayload {
                sessions: Vec::new(),
            },
        );

        assert_eq!(
            document.validate_for(SchemaFamily::Sessions),
            Err(SchemaError::UnexpectedFamily {
                expected: SchemaFamily::Sessions,
                actual: SchemaFamily::Settings,
            })
        );
    }
}
