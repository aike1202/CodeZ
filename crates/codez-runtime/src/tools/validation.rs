use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use jsonschema::{Validator, Draft};
use crate::tools::registry::ToolDescriptor;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolInputValidationFailureError {
    pub code: String, // TOOL_ARGUMENTS_TOO_LARGE | TOOL_ARGUMENTS_INVALID_JSON | TOOL_INPUT_INVALID
    pub message: String,
    pub issues: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "ok", rename_all = "camelCase")]
pub enum ToolInputValidationResult {
    #[serde(rename = "true")]
    Success { input: Value },
    #[serde(rename = "false")]
    Failure { error: ToolInputValidationFailureError },
}

pub struct ToolInputValidator {
    max_arguments_bytes: usize,
    validators: Arc<RwLock<HashMap<String, Arc<Validator>>>>,
}

impl ToolInputValidator {
    pub fn new(max_arguments_bytes: Option<usize>) -> Self {
        Self {
            max_arguments_bytes: max_arguments_bytes.unwrap_or(1024 * 1024),
            validators: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub fn compile(&self, fingerprint: &str, descriptors: &[&dyn ToolDescriptor]) {
        let mut cache = self.validators.write().unwrap();
        for desc in descriptors {
            let key = format!("{}:{}:{}", fingerprint, desc.name(), desc.version());
            if !cache.contains_key(&key) {
                if let Ok(validator) = Validator::options()
                    .with_draft(Draft::Draft7)
                    .build(&desc.input_schema()) 
                {
                    cache.insert(key, Arc::new(validator));
                }
            }
        }
    }

    pub fn validate(
        &self,
        fingerprint: &str,
        descriptor: &dyn ToolDescriptor,
        raw_arguments: &str,
    ) -> ToolInputValidationResult {
        if raw_arguments.len() > self.max_arguments_bytes {
            return ToolInputValidationResult::Failure {
                error: ToolInputValidationFailureError {
                    code: "TOOL_ARGUMENTS_TOO_LARGE".to_string(),
                    message: format!("{} arguments exceed the {} byte limit.", descriptor.name(), self.max_arguments_bytes),
                    issues: None,
                },
            };
        }

        let parsed: Value = if raw_arguments.trim().is_empty() {
            Value::Object(serde_json::Map::new())
        } else {
            match serde_json::from_str(raw_arguments) {
                Ok(v) => v,
                Err(e) => {
                    return ToolInputValidationResult::Failure {
                        error: ToolInputValidationFailureError {
                            code: "TOOL_ARGUMENTS_INVALID_JSON".to_string(),
                            message: format!("{} arguments are not valid JSON: {}", descriptor.name(), e),
                            issues: None,
                        },
                    };
                }
            }
        };

        if !parsed.is_object() {
            return ToolInputValidationResult::Failure {
                error: ToolInputValidationFailureError {
                    code: "TOOL_INPUT_INVALID".to_string(),
                    message: format!("{} input must be a JSON object.", descriptor.name()),
                    issues: Some(vec!["The tool input must be an object".to_string()]),
                },
            };
        }

        let key = format!("{}:{}:{}", fingerprint, descriptor.name(), descriptor.version());
        let validator_arc = {
            let cache = self.validators.read().unwrap();
            cache.get(&key).cloned()
        };

        let validator = match validator_arc {
            Some(v) => v,
            None => {
                let v = Validator::options().with_draft(Draft::Draft7).build(&descriptor.input_schema()).unwrap();
                let arc_v = Arc::new(v);
                let mut cache = self.validators.write().unwrap();
                cache.insert(key, arc_v.clone());
                arc_v
            }
        };

        if !validator.is_valid(&parsed) {
            let issues: Vec<String> = validator.iter_errors(&parsed).map(|e| e.to_string()).collect();
            return ToolInputValidationResult::Failure {
                error: ToolInputValidationFailureError {
                    code: "TOOL_INPUT_INVALID".to_string(),
                    message: format!("{} input is invalid.", descriptor.name()),
                    issues: Some(issues),
                },
            };
        }

        ToolInputValidationResult::Success { input: parsed }
    }
}
