use serde::{Deserialize, Serialize};

use crate::permission::contract::{PermissionAction, PermissionCapability, PermissionDecision};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PermissionMode {
    #[default]
    Auto,
    FullAccess,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolApprovalPreference {
    User,
    Auto,
}

pub struct PermissionDecisionInput {
    pub mode: PermissionMode,
    pub permission: PermissionCapability,
    pub explicit_rule: Option<PermissionAction>,
    pub approval_preference: Option<ToolApprovalPreference>,
    pub absolute_redline: bool,
}

pub struct PermissionCheck {
    pub action: PermissionAction,
}

pub struct PermissionDecisionEngine;

impl PermissionDecisionEngine {
    pub fn decide(input: PermissionDecisionInput) -> PermissionDecision {
        if input.explicit_rule == Some(PermissionAction::Deny) {
            return PermissionDecision {
                action: PermissionAction::Deny,
                reason: None,
            };
        }
        if input.absolute_redline || input.permission == PermissionCapability::Hardline {
            return PermissionDecision {
                action: PermissionAction::Ask,
                reason: None,
            };
        }
        if input.approval_preference == Some(ToolApprovalPreference::User) {
            return PermissionDecision {
                action: PermissionAction::Ask,
                reason: None,
            };
        }
        if input.explicit_rule == Some(PermissionAction::Allow) {
            return PermissionDecision {
                action: PermissionAction::Allow,
                reason: None,
            };
        }
        if matches!(
            input.permission,
            PermissionCapability::Unknown
                | PermissionCapability::ShellUnparsed
                | PermissionCapability::ExternalDirectory
        ) {
            return PermissionDecision {
                action: PermissionAction::Ask,
                reason: None,
            };
        }
        if input.mode == PermissionMode::FullAccess {
            return PermissionDecision {
                action: PermissionAction::Allow,
                reason: None,
            };
        }

        let auto_allow = matches!(
            input.permission,
            PermissionCapability::Read | PermissionCapability::Edit | PermissionCapability::Shell
        );

        PermissionDecision {
            action: if auto_allow {
                PermissionAction::Allow
            } else {
                PermissionAction::Ask
            },
            reason: None,
        }
    }

    pub fn aggregate(checks: &[PermissionCheck]) -> PermissionAction {
        if checks.iter().any(|c| c.action == PermissionAction::Deny) {
            return PermissionAction::Deny;
        }
        if checks.iter().any(|c| c.action == PermissionAction::Ask) {
            return PermissionAction::Ask;
        }
        PermissionAction::Allow
    }
}
