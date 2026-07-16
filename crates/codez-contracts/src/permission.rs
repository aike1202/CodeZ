use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// User-selected permission policy for a workspace.
///
/// The desktop boundary owns this representation. Runtime policy types remain
/// independent so the core can operate without a Tauri or contract dependency.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(rename_all = "kebab-case")]
pub enum PermissionMode {
    Auto,
    FullAccess,
}

#[cfg(test)]
mod tests {
    use super::PermissionMode;

    #[test]
    fn full_access_uses_the_legacy_kebab_case_wire_value() {
        let serialized = serde_json::to_string(&PermissionMode::FullAccess)
            .expect("a fixed permission mode must serialize");

        assert_eq!(serialized, "\"full-access\"");
    }
}
