use serde::{Deserialize, Serialize};

use crate::SchemaFamily;

const MIB: u64 = 1024 * 1024;

/// Logical owner of one legacy persistence entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyDataSet {
    /// `providers.json` and its Electron credential references.
    Providers,
    /// Session index and embedded runtime snapshots.
    Sessions,
    /// General application settings.
    Settings,
    /// Recently opened workspace records.
    RecentProjects,
    /// Persisted allow and deny rules.
    PermissionRules,
    /// Per-workspace permission modes.
    WorkspacePermissions,
    /// Append-only permission audit evidence.
    PermissionAudit,
    /// User MCP server definitions.
    McpUserConfig,
    /// MCP project trust fingerprints.
    McpProjectTrust,
    /// Electron-encrypted MCP named secrets.
    McpSecrets,
    /// Electron-encrypted MCP OAuth state.
    McpOAuth,
    /// Immutable MCP content and metadata.
    McpContent,
    /// Draft and session attachment payloads and metadata.
    Attachments,
    /// Per-session canonical context ledger.
    ContextLedger,
    /// Per-session compacted context snapshot.
    ContextSnapshot,
    /// Edit transaction metadata and original bytes.
    EditBackups,
    /// Rotating tool execution journal.
    ToolJournal,
    /// Persisted large tool results and metadata.
    LargeToolResults,
    /// Workspace parallel execution snapshots.
    ParallelExecutions,
    /// User-authored plans under the global CodeZ directory.
    Plans,
    /// Global and workspace skill enablement configuration.
    SkillsConfig,
    /// Disposable workspace analysis cache.
    ProjectAnalysisCache,
    /// User and workspace rules and memory files.
    WorkspaceRulesMemory,
}

impl LegacyDataSet {
    /// Returns the stable inventory identifier used in migration manifests.
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
            Self::McpSecrets => "mcp-secrets",
            Self::McpOAuth => "mcp-oauth",
            Self::McpContent => "mcp-content",
            Self::Attachments => "attachments",
            Self::ContextLedger => "context-ledger",
            Self::ContextSnapshot => "context-snapshot",
            Self::EditBackups => "edit-backups",
            Self::ToolJournal => "tool-journal",
            Self::LargeToolResults => "large-tool-results",
            Self::ParallelExecutions => "parallel-executions",
            Self::Plans => "plans",
            Self::SkillsConfig => "skills-config",
            Self::ProjectAnalysisCache => "project-analysis-cache",
            Self::WorkspaceRulesMemory => "workspace-rules-memory",
        }
    }
}

/// Root authority from which a catalog discovery rule is resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RootScope {
    /// Electron's legacy `userData` directory.
    UserData,
    /// The current user's home directory.
    UserHome,
    /// Each explicitly supplied workspace root.
    Workspace,
}

/// Physical legacy file format before versioned transformation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LegacyFormat {
    /// One JSON object per file.
    Json,
    /// One JSON object per line.
    JsonLines,
    /// Electron safeStorage ciphertext or an equivalent secret envelope.
    SecretEnvelope,
    /// A directory containing structured metadata and opaque payloads.
    Mixed,
    /// User-authored or binary data copied without JSON parsing.
    Opaque,
}

/// Sensitivity classification applied before any content is inspected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataSensitivity {
    /// Non-secret user data that still must remain local.
    UserData,
    /// Credential material or a file containing credential references.
    Secret,
}

/// Filter applied while recursively walking one known legacy directory.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TreeSelector {
    /// Includes every regular file below the root.
    All,
    /// Includes files with an exact basename.
    FileName(&'static str),
    /// Includes files with an exact extension, excluding the leading dot.
    Extension(&'static str),
}

/// Determines which files in a data set carry a versioned JSON schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SchemaSelector {
    /// The data set has no JSON persistence schema.
    None,
    /// Every file selected by the discovery rule carries the schema.
    All,
    /// Only files with this exact basename carry the schema.
    FileName(&'static str),
    /// Only files with this extension carry the schema.
    Extension(&'static str),
}

/// One exact, prefix, or recursive lookup rooted in a trusted scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DiscoveryRule {
    /// Discovers one known relative file when present.
    ExactFile {
        scope: RootScope,
        relative_path: &'static str,
    },
    /// Discovers regular files in one directory whose names share a prefix.
    PrefixFiles {
        scope: RootScope,
        relative_directory: &'static str,
        prefix: &'static str,
    },
    /// Recursively discovers selected files below one known relative directory.
    RecursiveTree {
        scope: RootScope,
        relative_directory: &'static str,
        selector: TreeSelector,
    },
}

impl DiscoveryRule {
    /// Returns the scope that owns this lookup.
    #[must_use]
    pub const fn scope(self) -> RootScope {
        match self {
            Self::ExactFile { scope, .. }
            | Self::PrefixFiles { scope, .. }
            | Self::RecursiveTree { scope, .. } => scope,
        }
    }
}

/// Static migration contract for one inventory data set.
#[derive(Debug, Clone, Copy)]
pub struct LegacyDataSpec {
    /// Stable inventory identity.
    pub data_set: LegacyDataSet,
    /// Legacy physical format.
    pub format: LegacyFormat,
    /// Sensitivity applied to every discovered file.
    pub sensitivity: DataSensitivity,
    /// Maximum bytes accepted from any single legacy file.
    pub max_file_bytes: u64,
    /// Target versioned family when structured metadata is present.
    pub schema: Option<SchemaFamily>,
    /// Selects which discovered files carry `schema`.
    pub schema_selector: SchemaSelector,
    /// One or more known discovery roots for this data set.
    pub rules: &'static [DiscoveryRule],
}

const PROVIDERS: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "providers.json",
}];
const SESSIONS: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "sessions.json",
}];
const SETTINGS: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "settings.json",
}];
const RECENT_PROJECTS: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "recent-projects.json",
}];
const PERMISSION_RULES: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "permission-rules.json",
}];
const WORKSPACE_PERMISSIONS: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "workspace-permissions.json",
}];
const PERMISSION_AUDIT: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "permission-audit.jsonl",
}];
const MCP_USER_CONFIG: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "mcp.json",
}];
const MCP_PROJECT_TRUST: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "mcp-project-trust.json",
}];
const MCP_SECRETS: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "mcp-secrets.secure",
}];
const MCP_OAUTH: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::UserData,
    relative_path: "mcp-oauth.secure",
}];
const MCP_CONTENT: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::UserData,
    relative_directory: "mcp-content-v2",
    selector: TreeSelector::All,
}];
const ATTACHMENTS: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::UserData,
    relative_directory: "attachments",
    selector: TreeSelector::All,
}];
const CONTEXT_LEDGER: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::UserData,
    relative_directory: "session-runtime",
    selector: TreeSelector::FileName("ledger.jsonl"),
}];
const CONTEXT_SNAPSHOT: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::UserData,
    relative_directory: "session-runtime",
    selector: TreeSelector::FileName("snapshot.json"),
}];
const EDIT_BACKUPS: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::UserData,
    relative_directory: "edit-backups",
    selector: TreeSelector::All,
}];
const TOOL_JOURNAL: &[DiscoveryRule] = &[DiscoveryRule::PrefixFiles {
    scope: RootScope::UserData,
    relative_directory: "",
    prefix: "tool-execution-journal.jsonl",
}];
const LARGE_TOOL_RESULTS: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::UserData,
    relative_directory: "tool-results-v2",
    selector: TreeSelector::All,
}];
const PARALLEL_EXECUTIONS: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::Workspace,
    relative_directory: ".codez/executions",
    selector: TreeSelector::Extension("json"),
}];
const PLANS: &[DiscoveryRule] = &[DiscoveryRule::RecursiveTree {
    scope: RootScope::UserHome,
    relative_directory: ".codez/projects",
    selector: TreeSelector::Extension("md"),
}];
const SKILLS_CONFIG: &[DiscoveryRule] = &[
    DiscoveryRule::ExactFile {
        scope: RootScope::UserHome,
        relative_path: ".codez/skills-config.json",
    },
    DiscoveryRule::ExactFile {
        scope: RootScope::Workspace,
        relative_path: ".codez-cache/skills-config.json",
    },
];
const PROJECT_ANALYSIS_CACHE: &[DiscoveryRule] = &[DiscoveryRule::ExactFile {
    scope: RootScope::Workspace,
    relative_path: ".codez-cache/project-snapshots.json",
}];
const WORKSPACE_RULES_MEMORY: &[DiscoveryRule] = &[
    DiscoveryRule::RecursiveTree {
        scope: RootScope::UserHome,
        relative_directory: ".codez/rules",
        selector: TreeSelector::All,
    },
    DiscoveryRule::RecursiveTree {
        scope: RootScope::UserHome,
        relative_directory: ".codez/memory",
        selector: TreeSelector::All,
    },
    DiscoveryRule::RecursiveTree {
        scope: RootScope::Workspace,
        relative_directory: ".codez/rules",
        selector: TreeSelector::All,
    },
    DiscoveryRule::RecursiveTree {
        scope: RootScope::Workspace,
        relative_directory: ".codez/memory",
        selector: TreeSelector::All,
    },
];

/// Complete migration catalog corresponding to the reviewed 23-entry inventory.
pub const LEGACY_DATA_CATALOG: [LegacyDataSpec; 23] = [
    LegacyDataSpec {
        data_set: LegacyDataSet::Providers,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::Secret,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::Providers),
        schema_selector: SchemaSelector::All,
        rules: PROVIDERS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::Sessions,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 64 * MIB,
        schema: Some(SchemaFamily::Sessions),
        schema_selector: SchemaSelector::All,
        rules: SESSIONS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::Settings,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::Settings),
        schema_selector: SchemaSelector::All,
        rules: SETTINGS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::RecentProjects,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::RecentProjects),
        schema_selector: SchemaSelector::All,
        rules: RECENT_PROJECTS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::PermissionRules,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::PermissionRules),
        schema_selector: SchemaSelector::All,
        rules: PERMISSION_RULES,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::WorkspacePermissions,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::WorkspacePermissions),
        schema_selector: SchemaSelector::All,
        rules: WORKSPACE_PERMISSIONS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::PermissionAudit,
        format: LegacyFormat::JsonLines,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 64 * MIB,
        schema: Some(SchemaFamily::PermissionAudit),
        schema_selector: SchemaSelector::All,
        rules: PERMISSION_AUDIT,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::McpUserConfig,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::McpUserConfig),
        schema_selector: SchemaSelector::All,
        rules: MCP_USER_CONFIG,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::McpProjectTrust,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::McpProjectTrust),
        schema_selector: SchemaSelector::All,
        rules: MCP_PROJECT_TRUST,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::McpSecrets,
        format: LegacyFormat::SecretEnvelope,
        sensitivity: DataSensitivity::Secret,
        max_file_bytes: 16 * MIB,
        schema: None,
        schema_selector: SchemaSelector::None,
        rules: MCP_SECRETS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::McpOAuth,
        format: LegacyFormat::SecretEnvelope,
        sensitivity: DataSensitivity::Secret,
        max_file_bytes: 16 * MIB,
        schema: None,
        schema_selector: SchemaSelector::None,
        rules: MCP_OAUTH,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::McpContent,
        format: LegacyFormat::Mixed,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 25 * MIB,
        schema: Some(SchemaFamily::McpContentMetadata),
        schema_selector: SchemaSelector::Extension("json"),
        rules: MCP_CONTENT,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::Attachments,
        format: LegacyFormat::Mixed,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 100 * MIB,
        schema: Some(SchemaFamily::AttachmentMetadata),
        schema_selector: SchemaSelector::FileName("meta.json"),
        rules: ATTACHMENTS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::ContextLedger,
        format: LegacyFormat::JsonLines,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 64 * MIB,
        schema: Some(SchemaFamily::ContextLedger),
        schema_selector: SchemaSelector::All,
        rules: CONTEXT_LEDGER,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::ContextSnapshot,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 64 * MIB,
        schema: Some(SchemaFamily::ContextSnapshot),
        schema_selector: SchemaSelector::All,
        rules: CONTEXT_SNAPSHOT,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::EditBackups,
        format: LegacyFormat::Mixed,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 128 * MIB,
        schema: Some(SchemaFamily::EditBackupMetadata),
        schema_selector: SchemaSelector::FileName("metadata.json"),
        rules: EDIT_BACKUPS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::ToolJournal,
        format: LegacyFormat::JsonLines,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 10 * MIB,
        schema: Some(SchemaFamily::ToolJournal),
        schema_selector: SchemaSelector::All,
        rules: TOOL_JOURNAL,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::LargeToolResults,
        format: LegacyFormat::Mixed,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 128 * MIB,
        schema: Some(SchemaFamily::LargeToolResultMetadata),
        schema_selector: SchemaSelector::Extension("json"),
        rules: LARGE_TOOL_RESULTS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::ParallelExecutions,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 64 * MIB,
        schema: Some(SchemaFamily::ParallelExecution),
        schema_selector: SchemaSelector::All,
        rules: PARALLEL_EXECUTIONS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::Plans,
        format: LegacyFormat::Opaque,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: None,
        schema_selector: SchemaSelector::None,
        rules: PLANS,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::SkillsConfig,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: Some(SchemaFamily::SkillsConfig),
        schema_selector: SchemaSelector::All,
        rules: SKILLS_CONFIG,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::ProjectAnalysisCache,
        format: LegacyFormat::Json,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 64 * MIB,
        schema: Some(SchemaFamily::ProjectAnalysisCache),
        schema_selector: SchemaSelector::All,
        rules: PROJECT_ANALYSIS_CACHE,
    },
    LegacyDataSpec {
        data_set: LegacyDataSet::WorkspaceRulesMemory,
        format: LegacyFormat::Opaque,
        sensitivity: DataSensitivity::UserData,
        max_file_bytes: 16 * MIB,
        schema: None,
        schema_selector: SchemaSelector::None,
        rules: WORKSPACE_RULES_MEMORY,
    },
];

#[cfg(test)]
mod tests {
    use super::LEGACY_DATA_CATALOG;

    #[test]
    fn migration_catalog_matches_the_reviewed_inventory_ids() {
        let ids = LEGACY_DATA_CATALOG
            .iter()
            .map(|entry| entry.data_set.id())
            .collect::<Vec<_>>();

        assert_eq!(
            ids,
            [
                "providers",
                "sessions",
                "settings",
                "recent-projects",
                "permission-rules",
                "workspace-permissions",
                "permission-audit",
                "mcp-user-config",
                "mcp-project-trust",
                "mcp-secrets",
                "mcp-oauth",
                "mcp-content",
                "attachments",
                "context-ledger",
                "context-snapshot",
                "edit-backups",
                "tool-journal",
                "large-tool-results",
                "parallel-executions",
                "plans",
                "skills-config",
                "project-analysis-cache",
                "workspace-rules-memory",
            ]
        );
    }
}
