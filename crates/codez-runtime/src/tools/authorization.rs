use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

use crate::tools::types::{PreparedToolCall, ToolEffectPlan};

/// Immutable inputs covered by one tool authorization decision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizationBinding {
    tool_name: String,
    input_digest: String,
    effect_digest: String,
    workspace: String,
    scope_digest: String,
}

impl AuthorizationBinding {
    /// Creates a binding for the exact tool input, effect plan, workspace, and caller scope.
    #[must_use]
    pub fn for_call(
        prepared: &PreparedToolCall,
        workspace: &str,
        session_id: Option<&str>,
        agent_role: &str,
    ) -> Self {
        Self {
            tool_name: prepared.canonical_name.clone(),
            input_digest: digest_json(&prepared.input),
            effect_digest: digest_effects(&prepared.effects),
            workspace: workspace.to_string(),
            scope_digest: digest_parts(&[session_id.unwrap_or_default(), agent_role]),
        }
    }

    fn digest(&self) -> String {
        digest_parts(&[
            &self.tool_name,
            &self.input_digest,
            &self.effect_digest,
            &self.workspace,
            &self.scope_digest,
        ])
    }
}

/// Signed, short-lived proof that a specific tool call passed authorization.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizationReceipt {
    id: String,
    binding_digest: String,
    expires_at_ms: u64,
    signature: String,
}

impl AuthorizationReceipt {
    /// Returns the opaque receipt identifier used for execution correlation.
    #[must_use]
    pub fn id(&self) -> &str {
        &self.id
    }
}

/// Validation failures for authorization receipts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub enum AuthorizationReceiptError {
    /// The authorization window ended before execution began.
    #[error("the authorization receipt expired before execution")]
    Expired,
    /// Tool, input, effects, workspace, or caller scope changed after approval.
    #[error("the authorization receipt does not match the prepared tool call")]
    BindingMismatch,
    /// Receipt fields were changed after issuance.
    #[error("the authorization receipt signature is invalid")]
    InvalidSignature,
}

/// Process-local issuer used to prevent receipt tampering between approval and execution.
#[derive(Clone)]
pub struct AuthorizationReceiptIssuer {
    secret: [u8; 32],
}

impl std::fmt::Debug for AuthorizationReceiptIssuer {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("AuthorizationReceiptIssuer")
            .finish_non_exhaustive()
    }
}

impl Default for AuthorizationReceiptIssuer {
    fn default() -> Self {
        Self::new()
    }
}

impl AuthorizationReceiptIssuer {
    /// Creates an issuer with a random process-local signing secret.
    #[must_use]
    pub fn new() -> Self {
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        let mut secret = [0_u8; 32];
        secret[..16].copy_from_slice(first.as_bytes());
        secret[16..].copy_from_slice(second.as_bytes());
        Self { secret }
    }

    /// Issues a receipt whose validity cannot outlive `valid_for`.
    #[must_use]
    pub fn issue(
        &self,
        binding: &AuthorizationBinding,
        valid_for: Duration,
        now: SystemTime,
    ) -> AuthorizationReceipt {
        let id = Uuid::new_v4().to_string();
        let binding_digest = binding.digest();
        let expires_at_ms = epoch_millis(now)
            .saturating_add(u64::try_from(valid_for.as_millis()).unwrap_or(u64::MAX));
        let signature = self.sign(&id, &binding_digest, expires_at_ms);
        AuthorizationReceipt {
            id,
            binding_digest,
            expires_at_ms,
            signature,
        }
    }

    /// Verifies expiry, exact binding, and signature immediately before execution.
    pub fn validate(
        &self,
        receipt: &AuthorizationReceipt,
        binding: &AuthorizationBinding,
        now: SystemTime,
    ) -> Result<(), AuthorizationReceiptError> {
        if epoch_millis(now) >= receipt.expires_at_ms {
            return Err(AuthorizationReceiptError::Expired);
        }
        if receipt.binding_digest != binding.digest() {
            return Err(AuthorizationReceiptError::BindingMismatch);
        }
        let expected = self.sign(&receipt.id, &receipt.binding_digest, receipt.expires_at_ms);
        if !constant_time_eq(expected.as_bytes(), receipt.signature.as_bytes()) {
            return Err(AuthorizationReceiptError::InvalidSignature);
        }
        Ok(())
    }

    fn sign(&self, id: &str, binding_digest: &str, expires_at_ms: u64) -> String {
        let mut hasher = Sha256::new();
        hasher.update(self.secret);
        update_part(&mut hasher, id);
        update_part(&mut hasher, binding_digest);
        hasher.update(expires_at_ms.to_le_bytes());
        hex::encode(hasher.finalize())
    }
}

fn epoch_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
        .unwrap_or_default()
}

fn digest_effects(effects: &ToolEffectPlan) -> String {
    serde_json::to_value(effects).map_or_else(
        |_| digest_parts(&["invalid-effect-plan"]),
        |value| digest_json(&value),
    )
}

fn digest_json(value: &Value) -> String {
    let canonical = canonical_json(value);
    let bytes = serde_json::to_vec(&canonical).unwrap_or_default();
    hex::encode(Sha256::digest(bytes))
}

fn canonical_json(value: &Value) -> Value {
    match value {
        Value::Array(values) => Value::Array(values.iter().map(canonical_json).collect()),
        Value::Object(values) => {
            let mut keys: Vec<&String> = values.keys().collect();
            keys.sort_unstable();
            let canonical = keys
                .into_iter()
                .map(|key| (key.clone(), canonical_json(&values[key])))
                .collect();
            Value::Object(canonical)
        }
        scalar => scalar.clone(),
    }
}

fn digest_parts(parts: &[&str]) -> String {
    let mut hasher = Sha256::new();
    for part in parts {
        update_part(&mut hasher, part);
    }
    hex::encode(hasher.finalize())
}

fn update_part(hasher: &mut Sha256, part: &str) {
    hasher.update(part.len().to_le_bytes());
    hasher.update(part.as_bytes());
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

#[cfg(test)]
mod tests {
    use std::{sync::Arc, time::Duration};

    use serde_json::json;

    use super::{AuthorizationBinding, AuthorizationReceiptError, AuthorizationReceiptIssuer};
    use crate::tools::{
        builtin::read::ReadTool,
        types::{NormalizedToolCall, PreparedToolCall, ToolEffectPlan},
    };

    fn prepared(input: serde_json::Value) -> PreparedToolCall {
        PreparedToolCall {
            call: NormalizedToolCall {
                call_id: "call-1".to_string(),
                position: 0,
                name: "Read".to_string(),
                raw_arguments: input.to_string(),
                thought_signature: None,
            },
            canonical_name: "Read".to_string(),
            handler: Arc::new(ReadTool::new()),
            input,
            effects: ToolEffectPlan {
                effects: Vec::new(),
                analysis_status: "parsed".to_string(),
            },
            resource_keys: Vec::new(),
        }
    }

    #[test]
    fn validate_rejects_a_receipt_after_the_input_binding_changes() {
        let issuer = AuthorizationReceiptIssuer::new();
        let first = prepared(json!({"files": [{"file_path": "a.txt"}]}));
        let second = prepared(json!({"files": [{"file_path": "b.txt"}]}));
        let first_binding = AuthorizationBinding::for_call(&first, "C:/workspace", None, "main");
        let second_binding = AuthorizationBinding::for_call(&second, "C:/workspace", None, "main");
        let now = std::time::SystemTime::now();
        let receipt = issuer.issue(&first_binding, Duration::from_secs(30), now);

        let error = issuer
            .validate(&receipt, &second_binding, now)
            .expect_err("changed input must invalidate authorization");

        assert_eq!(error, AuthorizationReceiptError::BindingMismatch);
    }

    #[test]
    fn validate_rejects_an_expired_receipt() {
        let issuer = AuthorizationReceiptIssuer::new();
        let call = prepared(json!({"files": [{"file_path": "a.txt"}]}));
        let binding = AuthorizationBinding::for_call(&call, "C:/workspace", None, "main");
        let now = std::time::SystemTime::now();
        let receipt = issuer.issue(&binding, Duration::from_millis(1), now);

        let error = issuer
            .validate(&receipt, &binding, now + Duration::from_millis(1))
            .expect_err("expired authorization must fail closed");

        assert_eq!(error, AuthorizationReceiptError::Expired);
    }

    #[test]
    fn validate_rejects_a_tampered_receipt_signature() {
        let issuer = AuthorizationReceiptIssuer::new();
        let call = prepared(json!({"files": [{"file_path": "a.txt"}]}));
        let binding = AuthorizationBinding::for_call(&call, "C:/workspace", None, "main");
        let now = std::time::SystemTime::now();
        let mut receipt = issuer.issue(&binding, Duration::from_secs(30), now);
        receipt.signature.replace_range(..1, "0");

        let error = issuer
            .validate(&receipt, &binding, now)
            .expect_err("tampered authorization must fail closed");

        assert_eq!(error, AuthorizationReceiptError::InvalidSignature);
    }
}
