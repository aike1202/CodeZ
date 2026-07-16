use crate::permission::contract::PermissionCapability;
use crate::permission::shell::types::NormalizedOperationGraph;
use regex::Regex;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PermissionImpactKind {
    System,
    Credential,
    Network,
    Process,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CriticalEnforcement {
    AbsoluteRedline,
    ModelDirected,
}

pub struct CriticalOperationFinding {
    pub rule_id: String,
    pub reason: String,
    pub pattern: String,
    pub impact: PermissionImpactKind,
    pub enforcement: CriticalEnforcement,
    pub permission: PermissionCapability,
}

struct CriticalPattern {
    id: &'static str,
    pattern: Option<Regex>,
    reason: &'static str,
    impact: PermissionImpactKind,
    enforcement: CriticalEnforcement,
    permission: PermissionCapability,
}

lazy_static::lazy_static! {
    static ref PATTERNS: Vec<CriticalPattern> = vec![
        CriticalPattern {
            id: "critical.privilege.sudo",
            pattern: Regex::new(r"(?i)(?:^|[;&|\n]\s*)sudo\b|\bStart-Process\b[^\n]*-Verb\s+RunAs").ok(),
            reason: "请求管理员或根权限",
            impact: PermissionImpactKind::System,
            enforcement: CriticalEnforcement::AbsoluteRedline,
            permission: PermissionCapability::Hardline,
        },
        CriticalPattern {
            id: "critical.delete.system-root",
            pattern: Regex::new(r#"(?i)\brm\s+(?:-[^\s]+\s+)*(?:["']?/(?:["']?|\s|$)|["']?/(?:etc|usr|var|bin|sbin|boot|lib)(?:/|["']|\s|$))"#).ok(),
            reason: "递归删除系统根目录或系统目录",
            impact: PermissionImpactKind::System,
            enforcement: CriticalEnforcement::AbsoluteRedline,
            permission: PermissionCapability::Hardline,
        },
        CriticalPattern {
            id: "critical.disk.format",
            pattern: Regex::new(r"(?i)\b(?:mkfs(?:\.\w+)?|format\s+[a-z]:)\b").ok(),
            reason: "格式化文件系统",
            impact: PermissionImpactKind::System,
            enforcement: CriticalEnforcement::AbsoluteRedline,
            permission: PermissionCapability::Hardline,
        },
        CriticalPattern {
            id: "critical.remote.execute",
            pattern: Regex::new(r"(?i)\b(?:curl|wget)\b[^|]*\|\s*(?:bash|sh|zsh)|\b(?:invoke-expression|iex)\b[^\n]*(?:invoke-webrequest|invoke-restmethod|iwr|irm)|\b(?:invoke-webrequest|invoke-restmethod|iwr|irm)\b[^|]*\|\s*(?:invoke-expression|iex)\b").ok(),
            reason: "下载或获取远程内容后直接执行",
            impact: PermissionImpactKind::Network,
            enforcement: CriticalEnforcement::ModelDirected,
            permission: PermissionCapability::Network,
        },
        CriticalPattern {
            id: "critical.hidden.encoded-command",
            pattern: Regex::new(r"(?i)\b(?:powershell|pwsh)(?:\.exe)?\b[^\n]*-(?:encodedcommand|enc|e)\b|\b(?:base64|xxd|openssl)\b[^|]*\|\s*(?:bash|sh|zsh)").ok(),
            reason: "编码或解码后隐藏执行",
            impact: PermissionImpactKind::System,
            enforcement: CriticalEnforcement::ModelDirected,
            permission: PermissionCapability::ShellUnparsed,
        },
        CriticalPattern {
            id: "critical.permission-config.write",
            pattern: Regex::new(r"(?i)(?:>|>>|\btee\b|\bset-content\b|\badd-content\b|\bout-file\b|\bremove-item\b|\brm\b|\bdel\b)[^\n]*(?:[\\/]codez[\\/](?:permission-rules|workspace-permissions)\.json)\b").ok(),
            reason: "修改 CodeZ 权限配置",
            impact: PermissionImpactKind::System,
            enforcement: CriticalEnforcement::AbsoluteRedline,
            permission: PermissionCapability::Hardline,
        },
    ];
}

pub struct CriticalOperationGuard;

impl CriticalOperationGuard {
    pub fn scan_raw(command: &str) -> Option<CriticalOperationFinding> {
        for p in PATTERNS.iter() {
            if p.pattern
                .as_ref()
                .is_some_and(|pattern| pattern.is_match(command))
            {
                return Some(CriticalOperationFinding {
                    rule_id: p.id.to_string(),
                    reason: p.reason.to_string(),
                    pattern: p
                        .pattern
                        .as_ref()
                        .map_or_else(String::new, |pattern| pattern.as_str().to_string()),
                    impact: p.impact.clone(),
                    enforcement: p.enforcement.clone(),
                    permission: p.permission.clone(),
                });
            }
        }
        None
    }

    pub fn scan_graph(graph: &NormalizedOperationGraph) -> Option<CriticalOperationFinding> {
        for op in &graph.operations {
            let exec = op.executable.to_lowercase();
            if exec == "systemctl" || exec == "sc" || exec == "schtasks" {
                return Some(CriticalOperationFinding {
                    rule_id: "critical.system.service".to_string(),
                    reason: "配置系统服务或计划任务".to_string(),
                    pattern: exec,
                    impact: PermissionImpactKind::System,
                    enforcement: CriticalEnforcement::AbsoluteRedline,
                    permission: PermissionCapability::Hardline,
                });
            }
            if ["pkexec", "doas", "runas", "su"].contains(&exec.as_str()) {
                return Some(CriticalOperationFinding {
                    rule_id: "critical.privilege.escalation".to_string(),
                    reason: "请求管理员或根权限".to_string(),
                    pattern: exec,
                    impact: PermissionImpactKind::System,
                    enforcement: CriticalEnforcement::AbsoluteRedline,
                    permission: PermissionCapability::Hardline,
                });
            }
        }
        None
    }
}
