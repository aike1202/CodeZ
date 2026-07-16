use std::collections::{BTreeMap, BTreeSet};

use codez_contracts::subagent::{
    SubAgentDetailResult, SubAgentInfo, SubAgentModelSelection, SubAgentOutputField,
    SubAgentOutputSpec, SubAgentSettingsDetail, SubAgentUnavailableDetail,
};
use codez_core::AppError;
use codez_runtime::agent::{
    registry::{self, SubAgentDefinition},
    sub_agent::{SubAgentModelId, SubAgentRole},
};
use serde_json::{Map, Value};

use crate::state::AppState;

const SETTINGS_FILE: &str = "settings.json";

/// A typed Provider/model catalog used to validate settings mutations.
pub(crate) type ProviderModelCatalog = BTreeMap<String, BTreeSet<String>>;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ValidatedSubAgentModelSelection {
    provider_id: String,
    model: SubAgentModelId,
}

impl ValidatedSubAgentModelSelection {
    fn into_wire(self) -> SubAgentModelSelection {
        SubAgentModelSelection {
            provider_id: self.provider_id,
            model: self.model.as_str().to_string(),
        }
    }
}

#[derive(Debug, Clone)]
pub(crate) struct KnownSubAgent {
    role: SubAgentRole,
    definition: SubAgentDefinition,
}

impl KnownSubAgent {
    fn from_definition(definition: SubAgentDefinition) -> Result<Self, AppError> {
        let role = SubAgentRole::parse(definition.r#type.clone()).map_err(|_| {
            AppError::internal("The built-in sub-agent registry contains an invalid type")
        })?;
        Ok(Self { role, definition })
    }

    fn info(&self, settings: &SubAgentSettings) -> SubAgentInfo {
        SubAgentInfo {
            kind: self.definition.r#type.clone(),
            description: self.definition.description.clone(),
            when_to_use: Some(self.definition.when_to_use.clone()),
            cost_hint: self.definition.cost_hint.clone(),
            enabled: settings.is_enabled(&self.role),
            configured_models: settings.models_for(&self.role),
        }
    }

    fn detail(&self, settings: &SubAgentSettings) -> SubAgentSettingsDetail {
        SubAgentSettingsDetail {
            kind: self.definition.r#type.clone(),
            description: self.definition.description.clone(),
            when_to_use: self.definition.when_to_use.clone(),
            when_not_to_use: self.definition.when_not_to_use.clone(),
            cost_hint: self.definition.cost_hint.clone(),
            max_loops: self.definition.max_loops,
            can_run_in_background: self.definition.can_run_in_background,
            isolation: self.definition.isolation.clone(),
            output_spec: self
                .definition
                .output_spec
                .as_ref()
                .map(output_spec_from_registry),
            enabled: settings.is_enabled(&self.role),
            configured_models: settings.models_for(&self.role),
        }
    }
}

#[derive(Debug, Clone, Default)]
pub(crate) struct SubAgentSettings {
    disabled_sub_agents: BTreeSet<String>,
    sub_agent_models: BTreeMap<String, Vec<SubAgentModelSelection>>,
}

impl SubAgentSettings {
    fn from_root(root: &Map<String, Value>) -> Result<Self, AppError> {
        let disabled_sub_agents = decode_optional_field(root, "disabledSubAgents")?
            .unwrap_or_default()
            .into_iter()
            .collect();
        let sub_agent_models = decode_optional_field(root, "subAgentModels")?.unwrap_or_default();
        Ok(Self {
            disabled_sub_agents,
            sub_agent_models,
        })
    }

    fn is_enabled(&self, role: &SubAgentRole) -> bool {
        !self.disabled_sub_agents.contains(role.as_str())
    }

    fn models_for(&self, role: &SubAgentRole) -> Option<Vec<SubAgentModelSelection>> {
        self.sub_agent_models
            .get(role.as_str())
            .map(|selections| {
                selections
                    .iter()
                    .filter(|selection| is_structurally_valid_selection(selection))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .filter(|selections| !selections.is_empty())
    }

    pub(crate) fn set_enabled(&mut self, role: &SubAgentRole, enabled: bool) {
        if enabled {
            self.disabled_sub_agents.remove(role.as_str());
        } else {
            self.disabled_sub_agents.insert(role.as_str().to_string());
        }
    }

    pub(crate) fn set_models(
        &mut self,
        role: &SubAgentRole,
        selections: Vec<ValidatedSubAgentModelSelection>,
    ) {
        if selections.is_empty() {
            self.sub_agent_models.remove(role.as_str());
        } else {
            self.sub_agent_models.insert(
                role.as_str().to_string(),
                selections
                    .into_iter()
                    .map(ValidatedSubAgentModelSelection::into_wire)
                    .collect(),
            );
        }
    }

    fn write_to_root(&self, root: &mut Map<String, Value>) -> Result<(), AppError> {
        let disabled = serde_json::to_value(&self.disabled_sub_agents).map_err(|error| {
            AppError::internal(format!("serialize disabled sub-agent settings: {error}"))
        })?;
        let models = serde_json::to_value(&self.sub_agent_models).map_err(|error| {
            AppError::internal(format!("serialize sub-agent model settings: {error}"))
        })?;
        root.insert("disabledSubAgents".to_string(), disabled);
        root.insert("subAgentModels".to_string(), models);
        Ok(())
    }
}

/// A settings document that preserves all non-sub-agent preferences unchanged.
pub(crate) struct SubAgentSettingsDocument {
    root: Map<String, Value>,
    settings: SubAgentSettings,
}

impl SubAgentSettingsDocument {
    fn from_value(value: Value) -> Result<Self, AppError> {
        let root = value.as_object().cloned().ok_or_else(|| {
            AppError::storage(
                "Settings data is invalid",
                "settings document root is not an object",
                false,
            )
        })?;
        let settings = SubAgentSettings::from_root(&root)?;
        Ok(Self { root, settings })
    }

    pub(crate) fn settings(&self) -> &SubAgentSettings {
        &self.settings
    }

    pub(crate) fn settings_mut(&mut self) -> &mut SubAgentSettings {
        &mut self.settings
    }

    fn into_value(mut self) -> Result<Value, AppError> {
        self.settings.write_to_root(&mut self.root)?;
        Ok(Value::Object(self.root))
    }
}

/// Reads settings through the storage port while preserving unrelated fields.
pub(crate) async fn read_settings(state: &AppState) -> Result<SubAgentSettingsDocument, AppError> {
    let path = state.paths.data_directory().join(SETTINGS_FILE);
    let document = state
        .storage
        .read_json::<Value>(&path)
        .await
        .map_err(AppError::from)?
        .unwrap_or_else(|| Value::Object(Map::new()));
    SubAgentSettingsDocument::from_value(document)
}

/// Persists a settings mutation through the storage port atomically.
pub(crate) async fn save_settings(
    state: &AppState,
    document: SubAgentSettingsDocument,
) -> Result<(), AppError> {
    let path = state.paths.data_directory().join(SETTINGS_FILE);
    let value = document.into_value()?;
    state
        .storage
        .write_json(&path, &value)
        .await
        .map_err(AppError::from)
}

/// Returns every registered built-in sub-agent as static settings definitions.
pub(crate) fn known_subagents() -> Result<Vec<KnownSubAgent>, AppError> {
    registry::get_builtin_subagents()
        .into_iter()
        .map(KnownSubAgent::from_definition)
        .collect()
}

/// Validates input text with the typed core before resolving a built-in agent.
pub(crate) fn find_known_subagent(subagent_type: &str) -> Result<KnownSubAgent, AppError> {
    let role = SubAgentRole::parse(subagent_type.to_string())
        .map_err(|_| AppError::validation("Sub-agent type is invalid"))?;
    known_subagents()?
        .into_iter()
        .find(|agent| agent.role == role)
        .ok_or_else(|| AppError::not_found("Sub-agent type is not available"))
}

/// Builds the settings list without claiming that a configured model is currently usable.
pub(crate) fn list_subagents(settings: &SubAgentSettings) -> Result<Vec<SubAgentInfo>, AppError> {
    known_subagents().map(|agents| agents.iter().map(|agent| agent.info(settings)).collect())
}

/// Returns the settings detail that Rust can honestly provide for one known agent.
pub(crate) fn detail_for_subagent(
    subagent_type: &str,
    settings: &SubAgentSettings,
) -> Result<SubAgentDetailResult, AppError> {
    let role = SubAgentRole::parse(subagent_type.to_string())
        .map_err(|_| AppError::validation("Sub-agent type is invalid"))?;
    let Some(agent) = known_subagents()?
        .into_iter()
        .find(|agent| agent.role == role)
    else {
        return Ok(SubAgentDetailResult::NotFound {
            subagent_type: role.as_str().to_string(),
        });
    };

    Ok(SubAgentDetailResult::Partial {
        detail: agent.detail(settings),
        unavailable: vec![
            SubAgentUnavailableDetail::SystemPrompt,
            SubAgentUnavailableDetail::ToolCatalog,
        ],
    })
}

/// Converts a Provider snapshot into the lookup structure needed for validation.
pub(crate) fn provider_model_catalog(
    providers: &[codez_core::provider::ProviderInfo],
) -> ProviderModelCatalog {
    providers
        .iter()
        .map(|provider| {
            let models = provider
                .models
                .iter()
                .map(|model| model.name.clone())
                .collect();
            (provider.id.clone(), models)
        })
        .collect()
}

/// Validates ordered model candidates against the typed core and configured Providers.
pub(crate) fn validate_model_selections(
    selections: Vec<SubAgentModelSelection>,
    providers: &ProviderModelCatalog,
) -> Result<Vec<ValidatedSubAgentModelSelection>, AppError> {
    let mut seen = BTreeSet::new();
    selections
        .into_iter()
        .map(|selection| {
            let model = SubAgentModelId::parse(selection.model).map_err(|_| {
                AppError::validation("The selected sub-agent model identifier is invalid")
            })?;
            let Some(models) = providers.get(&selection.provider_id) else {
                return Err(AppError::validation(
                    "The selected sub-agent Provider is not available",
                ));
            };
            if !models.contains(model.as_str()) {
                return Err(AppError::validation(
                    "The selected sub-agent model is not available",
                ));
            }
            let pair = (selection.provider_id.clone(), model.as_str().to_string());
            if !seen.insert(pair) {
                return Err(AppError::validation(
                    "The same sub-agent model cannot be configured more than once",
                ));
            }
            Ok(ValidatedSubAgentModelSelection {
                provider_id: selection.provider_id,
                model,
            })
        })
        .collect()
}

fn decode_optional_field<T>(
    root: &Map<String, Value>,
    field: &'static str,
) -> Result<Option<T>, AppError>
where
    T: serde::de::DeserializeOwned,
{
    root.get(field)
        .map(|value| {
            serde_json::from_value(value.clone()).map_err(|error| {
                AppError::storage(
                    "Settings data is invalid",
                    format!("settings field `{field}` is invalid: {error}"),
                    false,
                )
            })
        })
        .transpose()
}

fn is_structurally_valid_selection(selection: &SubAgentModelSelection) -> bool {
    SubAgentRole::parse(selection.provider_id.clone()).is_ok()
        && SubAgentModelId::parse(selection.model.clone()).is_ok()
}

fn output_spec_from_registry(spec: &registry::SubAgentOutputSpec) -> SubAgentOutputSpec {
    SubAgentOutputSpec {
        description: spec.description.clone(),
        fields: spec
            .fields
            .iter()
            .map(|field| SubAgentOutputField {
                name: field.name.clone(),
                kind: field.r#type.clone(),
                description: field.description.clone(),
                required: field.required,
            })
            .collect(),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use codez_contracts::subagent::{SubAgentDetailResult, SubAgentModelSelection};
    use serde_json::json;

    use super::{
        ProviderModelCatalog, SubAgentSettingsDocument, detail_for_subagent, find_known_subagent,
        list_subagents, validate_model_selections,
    };

    fn provider_catalog() -> ProviderModelCatalog {
        BTreeMap::from([(
            "provider-1".to_string(),
            BTreeSet::from(["fast-model".to_string(), "careful-model".to_string()]),
        )])
    }

    #[test]
    fn list_should_honor_electron_disabled_and_model_settings() {
        let document = SubAgentSettingsDocument::from_value(json!({
            "otherPreference": true,
            "disabledSubAgents": ["Reviewer"],
            "subAgentModels": {
                "Explore": [{ "providerId": "provider-1", "model": "fast-model" }]
            }
        }))
        .expect("Electron-compatible settings must parse");

        let agents = list_subagents(document.settings()).expect("built-ins must be valid");
        let explore = agents
            .iter()
            .find(|agent| agent.kind == "Explore")
            .expect("Explore must be registered");
        let reviewer = agents
            .iter()
            .find(|agent| agent.kind == "Reviewer")
            .expect("Reviewer must be registered");

        assert_eq!(
            (explore.enabled, explore.configured_models.as_ref().map(Vec::len), reviewer.enabled),
            (true, Some(1), false)
        );
    }

    #[test]
    fn toggle_should_write_disabled_sub_agents_without_losing_other_settings() {
        let mut document = SubAgentSettingsDocument::from_value(json!({
            "otherPreference": "keep",
            "disabledSubAgents": [],
            "subAgentModels": {}
        }))
        .expect("settings fixture must parse");
        let explorer = find_known_subagent("Explore").expect("Explore must be registered");

        document.settings_mut().set_enabled(&explorer.role, false);
        let value = document.into_value().expect("settings must serialize");

        assert_eq!(
            (value["otherPreference"].as_str(), value["disabledSubAgents"]),
            (Some("keep"), json!(["Explore"]))
        );
    }

    #[test]
    fn detail_should_report_dynamic_fields_as_unavailable_instead_of_fabricating_them() {
        let document = SubAgentSettingsDocument::from_value(json!({})).expect("empty settings are valid");

        let result = detail_for_subagent("Explore", document.settings())
            .expect("known detail lookup must succeed");

        let SubAgentDetailResult::Partial {
            detail,
            unavailable,
        } = result
        else {
            panic!("known agent must report partial typed detail");
        };
        assert!(
            detail.kind == "Explore"
                && unavailable.iter().any(|value| value.to_string() == "SystemPrompt")
        );
    }

    #[test]
    fn model_selection_should_reject_an_unknown_provider() {
        let error = validate_model_selections(
            vec![SubAgentModelSelection {
                provider_id: "missing-provider".to_string(),
                model: "fast-model".to_string(),
            }],
            &provider_catalog(),
        )
        .expect_err("unknown providers must not be persisted");

        assert_eq!(error.public_message(), "The selected sub-agent Provider is not available");
    }

    #[test]
    fn model_selection_should_preserve_order_and_reject_duplicates() {
        let catalog = provider_catalog();
        let selections = validate_model_selections(
            vec![
                SubAgentModelSelection {
                    provider_id: "provider-1".to_string(),
                    model: "careful-model".to_string(),
                },
                SubAgentModelSelection {
                    provider_id: "provider-1".to_string(),
                    model: "fast-model".to_string(),
                },
            ],
            &catalog,
        )
        .expect("known ordered selections must validate");
        let duplicate = validate_model_selections(
            vec![
                SubAgentModelSelection {
                    provider_id: "provider-1".to_string(),
                    model: "fast-model".to_string(),
                },
                SubAgentModelSelection {
                    provider_id: "provider-1".to_string(),
                    model: "fast-model".to_string(),
                },
            ],
            &catalog,
        )
        .expect_err("duplicate selection must be rejected");

        assert!(
            selections[0].model.as_str() == "careful-model"
                && duplicate.public_message()
                    == "The same sub-agent model cannot be configured more than once"
        );
    }
}
