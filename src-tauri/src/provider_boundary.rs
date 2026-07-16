use std::{path::PathBuf, sync::Arc};

use codez_contracts::provider as wire;
use codez_core::provider as domain;
use codez_core::{AppError, PortFuture};
use codez_storage::{
    AtomicFileStore, CredentialError as StorageCredentialError,
    CredentialId as StorageCredentialId, CredentialKind, CredentialStore as StorageCredentialStore,
    SchemaFamily, SecretValue as StorageSecretValue, VersionedDocument,
};

pub(crate) struct StorageProviderRepository {
    files: Arc<AtomicFileStore>,
    path: PathBuf,
}

impl StorageProviderRepository {
    pub(crate) fn new(files: Arc<AtomicFileStore>, path: PathBuf) -> Self {
        Self { files, path }
    }
}

impl domain::ProviderRepository for StorageProviderRepository {
    fn load(&self) -> PortFuture<'_, Option<domain::ProvidersFile>> {
        let files = Arc::clone(&self.files);
        let path = self.path.clone();
        Box::pin(async move {
            let document = files
                .read_json::<VersionedDocument<domain::ProvidersFile>>(&path)
                .await
                .map_err(AppError::from)?;
            document
                .map(|document| {
                    document
                        .validate_for(SchemaFamily::Providers)
                        .map_err(|error| {
                            AppError::storage(
                                "Provider configuration schema is unsupported",
                                error.to_string(),
                                false,
                            )
                        })?;
                    Ok(document.into_payload())
                })
                .transpose()
        })
    }

    fn save(&self, data: domain::ProvidersFile) -> PortFuture<'_, ()> {
        let files = Arc::clone(&self.files);
        let path = self.path.clone();
        Box::pin(async move {
            files
                .write_json(
                    &path,
                    &VersionedDocument::new(SchemaFamily::Providers, data),
                )
                .await
                .map_err(AppError::from)
        })
    }
}

pub(crate) struct StorageProviderCredentials {
    credentials: Arc<dyn StorageCredentialStore>,
}

impl StorageProviderCredentials {
    pub(crate) fn new(credentials: Arc<dyn StorageCredentialStore>) -> Self {
        Self { credentials }
    }
}

impl domain::CredentialStore for StorageProviderCredentials {
    fn get(&self, id: domain::CredentialId) -> domain::CredentialFuture<'_, domain::SecretValue> {
        let credentials = Arc::clone(&self.credentials);
        Box::pin(async move {
            let storage_id = storage_credential_id(&id)?;
            let result = tokio::task::spawn_blocking(move || credentials.get(&storage_id))
                .await
                .map_err(|_| domain::CredentialError::Unavailable {
                    operation: "join the Provider credential read worker",
                })?;
            let secret = result.map_err(|error| map_storage_credential_error(error, &id))?;
            domain::SecretValue::new(secret.expose_secret().to_string())
        })
    }

    fn set(
        &self,
        id: domain::CredentialId,
        value: domain::SecretValue,
    ) -> domain::CredentialFuture<'_, ()> {
        let credentials = Arc::clone(&self.credentials);
        Box::pin(async move {
            let storage_id = storage_credential_id(&id)?;
            let secret = StorageSecretValue::new(value.expose_secret().to_string())
                .map_err(|error| map_storage_credential_error(error, &id))?;
            tokio::task::spawn_blocking(move || credentials.set(&storage_id, &secret))
                .await
                .map_err(|_| domain::CredentialError::Unavailable {
                    operation: "join the Provider credential write worker",
                })?
                .map_err(|error| map_storage_credential_error(error, &id))
        })
    }

    fn delete(&self, id: domain::CredentialId) -> domain::CredentialFuture<'_, ()> {
        let credentials = Arc::clone(&self.credentials);
        Box::pin(async move {
            let storage_id = storage_credential_id(&id)?;
            tokio::task::spawn_blocking(move || credentials.delete(&storage_id))
                .await
                .map_err(|_| domain::CredentialError::Unavailable {
                    operation: "join the Provider credential delete worker",
                })?
                .map_err(|error| map_storage_credential_error(error, &id))
        })
    }
}

fn storage_credential_id(
    id: &domain::CredentialId,
) -> Result<StorageCredentialId, domain::CredentialError> {
    StorageCredentialId::new(CredentialKind::ProviderApiKey, id.provider_id())
        .map_err(|_| domain::CredentialError::InvalidIdentifier)
}

fn map_storage_credential_error(
    error: StorageCredentialError,
    id: &domain::CredentialId,
) -> domain::CredentialError {
    match error {
        StorageCredentialError::InvalidIdentifier => domain::CredentialError::InvalidIdentifier,
        StorageCredentialError::EmptySecret => domain::CredentialError::EmptySecret,
        StorageCredentialError::NotFound { .. } => {
            domain::CredentialError::NotFound { id: id.clone() }
        }
        StorageCredentialError::AccessDenied { operation } => {
            domain::CredentialError::AccessDenied { operation }
        }
        StorageCredentialError::Unavailable { operation } => {
            domain::CredentialError::Unavailable { operation }
        }
        StorageCredentialError::Corrupt { .. } => {
            domain::CredentialError::Corrupt { id: id.clone() }
        }
        StorageCredentialError::SecretTooLarge { platform_limit } => {
            domain::CredentialError::SecretTooLarge { platform_limit }
        }
    }
}

pub(crate) fn provider_form_from_wire(
    data: wire::ProviderFormData,
) -> Result<domain::ProviderFormData, AppError> {
    let api_key = if data.api_key.is_empty() {
        None
    } else {
        Some(
            domain::SecretValue::new(data.api_key)
                .map_err(|_| AppError::validation("Provider API key is invalid"))?,
        )
    };
    Ok(domain::ProviderFormData {
        name: data.name,
        base_url: data.base_url,
        api_format: data.api_format.map(api_format_from_wire),
        api_key,
        models: data.models.into_iter().map(model_from_wire).collect(),
        thinking: thinking_from_wire(data.thinking),
    })
}

pub(crate) fn provider_info_to_wire(info: domain::ProviderInfo) -> wire::ProviderInfo {
    wire::ProviderInfo {
        id: info.id,
        name: info.name,
        base_url: info.base_url,
        api_format: info.api_format.map(api_format_to_wire),
        api_key_configured: info.api_key_configured,
        models: info.models.into_iter().map(model_to_wire).collect(),
        thinking: thinking_to_wire(info.thinking),
        enabled: info.enabled,
        created_at: info.created_at,
    }
}

pub(crate) fn connection_to_wire(
    result: domain::ConnectionTestResult,
) -> wire::ConnectionTestResult {
    wire::ConnectionTestResult {
        success: result.success,
        message: result.message,
        models: result.models,
    }
}

fn api_format_from_wire(value: wire::ApiFormat) -> domain::ApiFormat {
    match value {
        wire::ApiFormat::Openai => domain::ApiFormat::Openai,
        wire::ApiFormat::Anthropic => domain::ApiFormat::Anthropic,
        wire::ApiFormat::Gemini => domain::ApiFormat::Gemini,
    }
}

fn api_format_to_wire(value: domain::ApiFormat) -> wire::ApiFormat {
    match value {
        domain::ApiFormat::Openai => wire::ApiFormat::Openai,
        domain::ApiFormat::Anthropic => wire::ApiFormat::Anthropic,
        domain::ApiFormat::Gemini => wire::ApiFormat::Gemini,
    }
}

fn thinking_mode_from_wire(value: wire::ThinkingMode) -> domain::ThinkingMode {
    match value {
        wire::ThinkingMode::Auto => domain::ThinkingMode::Auto,
        wire::ThinkingMode::None => domain::ThinkingMode::None,
        wire::ThinkingMode::Openai => domain::ThinkingMode::Openai,
        wire::ThinkingMode::Deepseek => domain::ThinkingMode::Deepseek,
        wire::ThinkingMode::Qwen => domain::ThinkingMode::Qwen,
        wire::ThinkingMode::Anthropic => domain::ThinkingMode::Anthropic,
        wire::ThinkingMode::Gemini => domain::ThinkingMode::Gemini,
        wire::ThinkingMode::Grok => domain::ThinkingMode::Grok,
        wire::ThinkingMode::Openrouter => domain::ThinkingMode::Openrouter,
    }
}

fn thinking_mode_to_wire(value: domain::ThinkingMode) -> wire::ThinkingMode {
    match value {
        domain::ThinkingMode::Auto => wire::ThinkingMode::Auto,
        domain::ThinkingMode::None => wire::ThinkingMode::None,
        domain::ThinkingMode::Openai => wire::ThinkingMode::Openai,
        domain::ThinkingMode::Deepseek => wire::ThinkingMode::Deepseek,
        domain::ThinkingMode::Qwen => wire::ThinkingMode::Qwen,
        domain::ThinkingMode::Anthropic => wire::ThinkingMode::Anthropic,
        domain::ThinkingMode::Gemini => wire::ThinkingMode::Gemini,
        domain::ThinkingMode::Grok => wire::ThinkingMode::Grok,
        domain::ThinkingMode::Openrouter => wire::ThinkingMode::Openrouter,
    }
}

fn thinking_effort_from_wire(value: wire::ThinkingEffort) -> domain::ThinkingEffort {
    match value {
        wire::ThinkingEffort::Auto => domain::ThinkingEffort::Auto,
        wire::ThinkingEffort::None => domain::ThinkingEffort::None,
        wire::ThinkingEffort::Minimal => domain::ThinkingEffort::Minimal,
        wire::ThinkingEffort::Low => domain::ThinkingEffort::Low,
        wire::ThinkingEffort::Medium => domain::ThinkingEffort::Medium,
        wire::ThinkingEffort::High => domain::ThinkingEffort::High,
        wire::ThinkingEffort::Xhigh => domain::ThinkingEffort::Xhigh,
        wire::ThinkingEffort::Max => domain::ThinkingEffort::Max,
        wire::ThinkingEffort::Custom => domain::ThinkingEffort::Custom,
    }
}

fn thinking_effort_to_wire(value: domain::ThinkingEffort) -> wire::ThinkingEffort {
    match value {
        domain::ThinkingEffort::Auto => wire::ThinkingEffort::Auto,
        domain::ThinkingEffort::None => wire::ThinkingEffort::None,
        domain::ThinkingEffort::Minimal => wire::ThinkingEffort::Minimal,
        domain::ThinkingEffort::Low => wire::ThinkingEffort::Low,
        domain::ThinkingEffort::Medium => wire::ThinkingEffort::Medium,
        domain::ThinkingEffort::High => wire::ThinkingEffort::High,
        domain::ThinkingEffort::Xhigh => wire::ThinkingEffort::Xhigh,
        domain::ThinkingEffort::Max => wire::ThinkingEffort::Max,
        domain::ThinkingEffort::Custom => wire::ThinkingEffort::Custom,
    }
}

fn thinking_from_wire(value: wire::ThinkingConfig) -> domain::ThinkingConfig {
    domain::ThinkingConfig {
        enabled: value.enabled,
        mode: thinking_mode_from_wire(value.mode),
        effort: value.effort.map(thinking_effort_from_wire),
        budget_tokens: value.budget_tokens,
    }
}

fn thinking_to_wire(value: domain::ThinkingConfig) -> wire::ThinkingConfig {
    wire::ThinkingConfig {
        enabled: value.enabled,
        mode: thinking_mode_to_wire(value.mode),
        effort: value.effort.map(thinking_effort_to_wire),
        budget_tokens: value.budget_tokens,
    }
}

fn model_from_wire(value: wire::ModelConfig) -> domain::ModelConfig {
    domain::ModelConfig {
        id: value.id,
        name: value.name,
        max_context_tokens: value.max_context_tokens,
        max_input_tokens: value.max_input_tokens,
        max_output_tokens: value.max_output_tokens,
        reasoning_counts_against_context: value.reasoning_counts_against_context,
        supports_vision: value.supports_vision,
        api_format: value.api_format.map(api_format_from_wire),
        thinking_mode: value.thinking_mode.map(thinking_mode_from_wire),
        thinking_effort: value.thinking_effort.map(thinking_effort_from_wire),
        thinking_budget_tokens: value.thinking_budget_tokens,
    }
}

fn model_to_wire(value: domain::ModelConfig) -> wire::ModelConfig {
    wire::ModelConfig {
        id: value.id,
        name: value.name,
        max_context_tokens: value.max_context_tokens,
        max_input_tokens: value.max_input_tokens,
        max_output_tokens: value.max_output_tokens,
        reasoning_counts_against_context: value.reasoning_counts_against_context,
        supports_vision: value.supports_vision,
        api_format: value.api_format.map(api_format_to_wire),
        thinking_mode: value.thinking_mode.map(thinking_mode_to_wire),
        thinking_effort: value.thinking_effort.map(thinking_effort_to_wire),
        thinking_budget_tokens: value.thinking_budget_tokens,
    }
}

pub(crate) fn chat_message_from_wire(
    value: codez_contracts::chat::ChatMessage,
) -> domain::ChatMessage {
    domain::ChatMessage {
        role: match value.role {
            codez_contracts::chat::Role::System => domain::Role::System,
            codez_contracts::chat::Role::User => domain::Role::User,
            codez_contracts::chat::Role::Assistant => domain::Role::Assistant,
            codez_contracts::chat::Role::Tool => domain::Role::Tool,
        },
        content: value.content,
        tool_calls: value.tool_calls.map(|calls| {
            calls
                .into_iter()
                .map(|call| domain::ToolCall {
                    id: call.id,
                    r#type: call.r#type,
                    function: domain::ToolCallFunction {
                        name: call.function.name,
                        arguments: call.function.arguments,
                    },
                    thought_signature: call.thought_signature,
                })
                .collect()
        }),
        tool_call_id: value.tool_call_id,
        name: value.name,
    }
}

pub(crate) fn usage_to_wire(value: domain::ProviderTokenUsage) -> wire::ProviderTokenUsage {
    wire::ProviderTokenUsage {
        input_tokens: value.input_tokens,
        output_tokens: value.output_tokens,
        reasoning_tokens: value.reasoning_tokens,
        total_tokens: value.total_tokens,
    }
}

pub(crate) fn stop_reason_to_wire(
    value: domain::AgentStopReason,
) -> codez_contracts::chat::AgentStopReason {
    match value {
        domain::AgentStopReason::Stop => codez_contracts::chat::AgentStopReason::Stop,
        domain::AgentStopReason::Length => codez_contracts::chat::AgentStopReason::Length,
        domain::AgentStopReason::ToolCalls => codez_contracts::chat::AgentStopReason::ToolCalls,
        domain::AgentStopReason::ContentFilter => {
            codez_contracts::chat::AgentStopReason::ContentFilter
        }
        domain::AgentStopReason::Error => codez_contracts::chat::AgentStopReason::Error,
        domain::AgentStopReason::Unknown => codez_contracts::chat::AgentStopReason::Unknown,
    }
}

#[cfg(test)]
#[path = "provider_boundary_tests.rs"]
mod tests;
