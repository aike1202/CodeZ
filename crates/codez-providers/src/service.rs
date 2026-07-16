use std::sync::Arc;

use chrono::Utc;
use codez_core::provider::{
    ApiFormat, ConnectionTestResult, ModelConfig, ProviderConfig, ProviderFormData, ProviderInfo,
    ProviderRepository, ProvidersFile, ThinkingConfig,
};
use codez_core::provider::{CredentialError, CredentialId, CredentialStore, SecretValue};
use codez_core::{AppError, redact_sensitive_text};
use tokio::sync::RwLock;

// These safety limits govern new create/update payloads. Migrated metadata is
// loaded under its structural invariants so legacy installations remain usable.
const MAX_PROVIDERS: usize = 20;
const MAX_PROVIDER_NAME_BYTES: usize = 256;
const MAX_BASE_URL_BYTES: usize = 2_048;
const MAX_MODEL_ID_BYTES: usize = 512;
const MAX_MODEL_NAME_BYTES: usize = 512;

pub struct ProviderService {
    repository: Arc<dyn ProviderRepository>,
    credentials: Arc<dyn CredentialStore>,
    cache: RwLock<ProvidersFile>,
}

/// Provider and model metadata paired with a short-lived credential for an
/// in-process chat request.
///
/// This type intentionally implements neither `Debug`, `Clone`, nor
/// `Serialize`, so the resolved secret cannot enter logs or IPC payloads
/// through derived implementations.
pub struct ResolvedProviderChatConfig {
    pub provider_id: String,
    pub base_url: String,
    pub api_format: ApiFormat,
    pub model: ModelConfig,
    pub thinking: ThinkingConfig,
    pub api_key: SecretValue,
}

impl ProviderService {
    pub async fn new(
        repository: Arc<dyn ProviderRepository>,
        credentials: Arc<dyn CredentialStore>,
    ) -> Result<Self, AppError> {
        let service = Self {
            repository,
            credentials,
            cache: RwLock::new(ProvidersFile {
                providers: Vec::new(),
                active_provider_id: None,
            }),
        };
        service.load().await?;
        Ok(service)
    }

    pub async fn load(&self) -> Result<(), AppError> {
        let file_data = self.repository.load().await?;

        if let Some(mut data) = file_data {
            for p in &mut data.providers {
                for m in &mut p.models {
                    if m.max_context_tokens == 0 {
                        m.max_context_tokens = 8192;
                    }
                }
            }
            validate_providers_file(&data)?;
            let mut cache = self.cache.write().await;
            *cache = data;
        }
        Ok(())
    }

    async fn save(&self, data: &ProvidersFile) -> Result<(), AppError> {
        validate_providers_file(data)?;
        self.repository.save(data.clone()).await
    }

    async fn get_credential(&self, id: CredentialId) -> Result<SecretValue, CredentialError> {
        self.credentials.get(id).await
    }

    async fn set_credential(
        &self,
        id: CredentialId,
        secret: SecretValue,
    ) -> Result<(), CredentialError> {
        self.credentials.set(id, secret).await
    }

    async fn delete_credential(&self, id: CredentialId) -> Result<(), CredentialError> {
        self.credentials.delete(id).await
    }

    async fn restore_credential(
        &self,
        id: CredentialId,
        previous: Option<SecretValue>,
    ) -> Result<(), CredentialError> {
        match previous {
            Some(secret) => self.set_credential(id, secret).await,
            None => match self.delete_credential(id).await {
                Ok(()) | Err(CredentialError::NotFound { .. }) => Ok(()),
                Err(error) => Err(error),
            },
        }
    }

    pub async fn get_all(&self) -> Result<Vec<ProviderInfo>, AppError> {
        let providers = self.cache.read().await.providers.clone();
        let mut infos = Vec::with_capacity(providers.len());
        for provider in providers {
            let api_key_configured = self.credential_is_configured(&provider).await?;
            infos.push(provider_info(&provider, api_key_configured));
        }
        Ok(infos)
    }

    async fn credential_is_configured(&self, provider: &ProviderConfig) -> Result<bool, AppError> {
        let Some(credential_id) = credential_id_for_provider(provider)? else {
            return Ok(false);
        };
        match self.get_credential(credential_id).await {
            Ok(_secret) => Ok(true),
            Err(CredentialError::NotFound { .. }) => Ok(false),
            Err(error) => Err(credential_app_error(
                "inspect provider API key availability",
                error,
            )),
        }
    }

    pub async fn create(&self, mut data: ProviderFormData) -> Result<ProviderInfo, AppError> {
        normalize_and_validate_provider_form(&mut data)?;

        let mut cache = self.cache.write().await;
        if cache.providers.len() >= MAX_PROVIDERS {
            return Err(AppError::validation(format!(
                "At most {MAX_PROVIDERS} Providers can be configured"
            )));
        }

        let id = generated_id("pv");

        let now = Utc::now().to_rfc3339();
        let credential_id = if let Some(secret) = data.api_key {
            let credential_id = CredentialId::new(&id)
                .map_err(|_| AppError::validation("Provider ID is invalid"))?;
            self.set_credential(credential_id.clone(), secret)
                .await
                .map_err(|error| credential_app_error("store provider API key", error))?;
            Some(credential_id)
        } else {
            None
        };

        let config = ProviderConfig {
            id: id.clone(),
            name: data.name,
            base_url: data.base_url,
            api_format: data.api_format,
            credential_id: credential_id.as_ref().map(CredentialId::account_name),
            models: data.models,
            thinking: data.thinking,
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        let mut next = cache.clone();
        next.providers.push(config.clone());
        if next.active_provider_id.is_none() {
            next.active_provider_id = Some(config.id.clone());
        }
        if let Err(save_error) = self.save(&next).await {
            if let Some(credential_id) = credential_id
                && let Err(rollback_error) = self.restore_credential(credential_id, None).await
            {
                return Err(provider_transaction_error(
                    "create provider",
                    &save_error,
                    &rollback_error,
                ));
            }
            return Err(save_error);
        }
        *cache = next;

        Ok(provider_info(&config, config.credential_id.is_some()))
    }

    pub async fn update(
        &self,
        id: &str,
        mut data: ProviderFormData,
    ) -> Result<ProviderInfo, AppError> {
        let mut cache = self.cache.write().await;
        let p_idx = cache
            .providers
            .iter()
            .position(|p| p.id == id)
            .ok_or_else(|| AppError::not_found("Provider not found"))?;
        normalize_and_validate_provider_form(&mut data)?;
        let previous_config = cache.providers[p_idx].clone();
        let mut next = cache.clone();
        let p = &mut next.providers[p_idx];
        p.name = data.name;
        p.base_url = data.base_url;
        p.api_format = data.api_format;
        p.thinking = data.thinking;
        p.updated_at = Utc::now().to_rfc3339();
        p.models = data.models;

        let credential_replacement = if let Some(secret) = data.api_key {
            let previous_credential_id = credential_id_for_provider(&previous_config)?;
            let credential_id = match previous_credential_id.as_ref() {
                Some(credential_id) => credential_id.clone(),
                None => CredentialId::new(&previous_config.id)
                    .map_err(|_| AppError::validation("Provider ID is invalid"))?,
            };
            let previous_secret = match previous_credential_id {
                Some(previous_credential_id) => {
                    match self.get_credential(previous_credential_id).await {
                        Ok(secret) => Some(secret),
                        Err(CredentialError::NotFound { .. }) => None,
                        Err(error) => {
                            return Err(credential_app_error(
                                "read the previous provider API key",
                                error,
                            ));
                        }
                    }
                }
                None => None,
            };
            self.set_credential(credential_id.clone(), secret)
                .await
                .map_err(|error| credential_app_error("replace provider API key", error))?;
            p.credential_id = Some(credential_id.account_name());
            Some((credential_id, previous_secret))
        } else {
            None
        };

        let info = provider_info(p, p.credential_id.is_some());
        if let Err(save_error) = self.save(&next).await {
            if let Some((credential_id, previous_secret)) = credential_replacement {
                if let Err(rollback_error) = self
                    .restore_credential(credential_id, previous_secret)
                    .await
                {
                    return Err(provider_transaction_error(
                        "update provider",
                        &save_error,
                        &rollback_error,
                    ));
                }
            }
            return Err(save_error);
        }
        *cache = next;
        Ok(info)
    }

    pub async fn delete(&self, id: &str) -> Result<(), AppError> {
        let mut cache = self.cache.write().await;
        let index = cache
            .providers
            .iter()
            .position(|provider| provider.id == id)
            .ok_or_else(|| AppError::not_found("Provider not found"))?;
        let mut next = cache.clone();
        let removed = next.providers.remove(index);
        if next.active_provider_id.as_deref() == Some(id) {
            next.active_provider_id = next.providers.first().map(|provider| provider.id.clone());
        }
        let credential_id = credential_id_for_provider(&removed)?;
        let previous_secret = match credential_id.as_ref() {
            Some(credential_id) => match self.get_credential(credential_id.clone()).await {
                Ok(secret) => Some(secret),
                Err(CredentialError::NotFound { .. }) => None,
                Err(error) => {
                    return Err(credential_app_error(
                        "read provider API key before deletion",
                        error,
                    ));
                }
            },
            None => None,
        };
        self.save(&next).await?;

        if let Some(credential_id) = credential_id {
            match self.delete_credential(credential_id.clone()).await {
                Ok(()) | Err(CredentialError::NotFound { .. }) => {}
                Err(credential_error) => {
                    if let Some(previous_secret) = previous_secret
                        && let Err(rollback_error) = self
                            .restore_credential(credential_id, Some(previous_secret))
                            .await
                    {
                        *cache = next;
                        return Err(AppError::storage(
                            "Provider deletion could not be rolled back safely",
                            format!(
                                "credential deletion failed: {credential_error}; credential rollback failed: {rollback_error}"
                            ),
                            false,
                        ));
                    }
                    if let Err(rollback_error) = self.save(&cache).await {
                        *cache = next;
                        return Err(AppError::storage(
                            "Provider deletion could not be completed",
                            format!(
                                "credential deletion failed: {credential_error}; provider rollback failed: {rollback_error}"
                            ),
                            false,
                        ));
                    }
                    return Err(credential_app_error(
                        "delete provider API key",
                        credential_error,
                    ));
                }
            }
        }
        *cache = next;
        Ok(())
    }

    pub async fn set_active(&self, id: &str) -> Result<(), AppError> {
        let mut cache = self.cache.write().await;
        if !cache.providers.iter().any(|p| p.id == id) {
            return Err(AppError::not_found("Provider not found"));
        }
        let mut next = cache.clone();
        next.active_provider_id = Some(id.to_string());
        self.save(&next).await?;
        *cache = next;
        Ok(())
    }

    pub async fn test_connection(&self, id: &str) -> Result<ConnectionTestResult, AppError> {
        let config = {
            let cache = self.cache.read().await;
            cache
                .providers
                .iter()
                .find(|provider| provider.id == id)
                .cloned()
                .ok_or_else(|| AppError::not_found("Provider not found"))?
        };
        let Some(credential_id) = credential_id_for_provider(&config)? else {
            return Ok(ConnectionTestResult {
                success: false,
                message: "未配置 API Key，请先配置".to_string(),
                models: None,
            });
        };
        let api_key = match self.get_credential(credential_id).await {
            Ok(secret) => secret,
            Err(_) => {
                return Ok(ConnectionTestResult {
                    success: false,
                    message: "无法读取 API Key，请重新配置".to_string(),
                    models: None,
                });
            }
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| AppError::internal(e.to_string()))?;

        let url = format!("{}/models", config.base_url.trim_end_matches('/'));
        let resp = client
            .get(&url)
            .bearer_auth(api_key.expose_secret())
            .header("Content-Type", "application/json")
            .send()
            .await;

        match resp {
            Ok(r) => {
                if r.status().is_client_error() || r.status().is_server_error() {
                    return Ok(ConnectionTestResult {
                        success: false,
                        message: format!("鉴权失败 ({})", r.status()),
                        models: None,
                    });
                }

                #[derive(serde::Deserialize)]
                struct ModelResp {
                    data: Option<Vec<ModelItem>>,
                }
                #[derive(serde::Deserialize)]
                struct ModelItem {
                    id: String,
                }

                if let Ok(json) = r.json::<ModelResp>().await {
                    let models: Vec<String> = json
                        .data
                        .unwrap_or_default()
                        .into_iter()
                        .map(|m| m.id)
                        .take(30)
                        .collect();
                    Ok(ConnectionTestResult {
                        success: true,
                        message: format!("连接成功，发现 {} 个可用模型", models.len()),
                        models: Some(models),
                    })
                } else {
                    Ok(ConnectionTestResult {
                        success: false,
                        message: "无法解析模型列表".into(),
                        models: None,
                    })
                }
            }
            Err(error) => Ok(ConnectionTestResult {
                success: false,
                message: format!("网络错误: {}", redact_sensitive_text(&error.to_string())),
                models: None,
            }),
        }
    }

    /// Resolves one enabled Provider and model with its API key for an
    /// in-process chat request.
    ///
    /// The returned value has no serialization, debug, or clone implementation.
    /// Callers should move it directly into the provider adapter and let the
    /// contained [`SecretValue`] clear itself on drop.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the Provider/model is absent or disabled, the
    /// persisted credential identity is absent or invalid, or the
    /// operating-system credential cannot be read.
    pub async fn resolve_chat_config(
        &self,
        provider_id: Option<&str>,
        model_id: Option<&str>,
    ) -> Result<ResolvedProviderChatConfig, AppError> {
        let (provider, model, credential_id) = {
            let cache = self.cache.read().await;
            let resolved_provider_id = provider_id
                .or(cache.active_provider_id.as_deref())
                .ok_or_else(|| AppError::not_found("No active Provider is configured"))?;
            let provider = cache
                .providers
                .iter()
                .find(|provider| provider.id == resolved_provider_id)
                .cloned()
                .ok_or_else(|| AppError::not_found("Provider not found"))?;
            if !provider.enabled {
                return Err(AppError::conflict("Provider is disabled"));
            }
            let credential_id = credential_id_for_provider(&provider)?
                .ok_or_else(|| AppError::conflict("Provider API key is not configured"))?;
            let model = match model_id {
                Some(model_id) => provider
                    .models
                    .iter()
                    .find(|model| model.id == model_id || model.name == model_id),
                None => provider.models.first(),
            }
            .cloned()
            .ok_or_else(|| AppError::not_found("Provider model not found"))?;
            (provider, model, credential_id)
        };

        let api_key = self
            .get_credential(credential_id)
            .await
            .map_err(|error| credential_app_error("read provider API key", error))?;
        let api_format = model
            .api_format
            .or(provider.api_format)
            .unwrap_or(ApiFormat::Openai);
        let thinking = merge_model_thinking(&provider.thinking, &model);

        Ok(ResolvedProviderChatConfig {
            provider_id: provider.id,
            base_url: provider.base_url,
            api_format,
            model,
            thinking,
            api_key,
        })
    }
}

fn generated_id(prefix: &str) -> String {
    format!("{prefix}_{}", uuid::Uuid::now_v7().simple())
}

fn normalize_and_validate_provider_form(data: &mut ProviderFormData) -> Result<(), AppError> {
    data.name = data.name.trim().to_string();
    let base_url = data.base_url.trim();
    data.base_url = base_url.strip_suffix('/').unwrap_or(base_url).to_string();

    validate_required_text(&data.name, "Provider name", MAX_PROVIDER_NAME_BYTES)?;
    validate_required_text(&data.base_url, "Provider Base URL", MAX_BASE_URL_BYTES)?;
    if data.models.is_empty() {
        return Err(AppError::validation(
            "At least one model configuration is required",
        ));
    }

    validate_thinking_budget(data.thinking.budget_tokens, "Provider thinking budget")?;
    for model in &mut data.models {
        if model.id.trim().is_empty() || model.id.starts_with("temp_") {
            model.id = generated_id("m");
        }
        validate_model(model)?;
    }

    let mut model_ids = std::collections::HashSet::with_capacity(data.models.len());
    for model in &data.models {
        if !model_ids.insert(model.id.as_str()) {
            return Err(AppError::validation(
                "Model identifiers must be unique within a Provider",
            ));
        }
    }
    Ok(())
}

fn validate_required_text(
    value: &str,
    field: &'static str,
    max_bytes: usize,
) -> Result<(), AppError> {
    if value.trim().is_empty() {
        return Err(AppError::validation(format!("{field} is required")));
    }
    if value.len() > max_bytes {
        return Err(AppError::validation(format!(
            "{field} exceeds the {max_bytes}-byte safety limit"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(AppError::validation(format!(
            "{field} cannot contain control characters"
        )));
    }
    Ok(())
}

fn validate_model(model: &ModelConfig) -> Result<(), AppError> {
    validate_required_text(&model.id, "Model identifier", MAX_MODEL_ID_BYTES)?;
    validate_required_text(&model.name, "Model name", MAX_MODEL_NAME_BYTES)?;

    if model.max_context_tokens == 0 {
        return Err(AppError::validation(
            "Model maxContextTokens must be a positive token count",
        ));
    }
    if let Some(max_input_tokens) = model.max_input_tokens {
        if max_input_tokens == 0 {
            return Err(AppError::validation(
                "Model maxInputTokens must be a positive token count or left empty",
            ));
        }
        if max_input_tokens > model.max_context_tokens {
            return Err(AppError::validation(
                "Model maxInputTokens cannot exceed maxContextTokens",
            ));
        }
    }

    let max_output_tokens = match model.max_output_tokens {
        Some(0) => {
            return Err(AppError::validation(
                "Model maxOutputTokens must be a positive token count or left empty",
            ));
        }
        Some(tokens) => tokens,
        None => default_max_output_tokens(model.max_context_tokens),
    };
    if max_output_tokens >= model.max_context_tokens {
        return Err(AppError::validation(
            "Model maxOutputTokens must be smaller than maxContextTokens",
        ));
    }

    validate_thinking_budget(model.thinking_budget_tokens, "Model thinking token budget")
}

fn default_max_output_tokens(context_window_tokens: u32) -> u32 {
    let window = context_window_tokens.max(2);
    let proportional = (window / 5).clamp(1_024, 8_192);
    proportional.min((window / 2).max(1))
}

fn validate_thinking_budget(
    budget_tokens: Option<u32>,
    field: &'static str,
) -> Result<(), AppError> {
    if budget_tokens == Some(0) {
        return Err(AppError::validation(format!(
            "{field} must be a positive token count or left empty"
        )));
    }
    Ok(())
}

fn validate_providers_file(data: &ProvidersFile) -> Result<(), AppError> {
    let mut provider_ids = std::collections::HashSet::with_capacity(data.providers.len());
    for provider in &data.providers {
        if !provider_ids.insert(provider.id.as_str()) {
            return Err(invalid_provider_configuration(
                &provider.id,
                "duplicate Provider identifier",
            ));
        }
        let _credential_id = credential_id_for_provider(provider)?;
    }
    if let Some(active_provider_id) = data.active_provider_id.as_deref()
        && !provider_ids.contains(active_provider_id)
    {
        return Err(invalid_provider_configuration(
            active_provider_id,
            "active Provider does not exist",
        ));
    }
    Ok(())
}

fn credential_id_for_provider(config: &ProviderConfig) -> Result<Option<CredentialId>, AppError> {
    let Some(credential_id) = config.credential_id.as_deref() else {
        return Ok(None);
    };
    let credential_id = CredentialId::parse(credential_id)
        .map_err(|_| invalid_provider_configuration(&config.id, "invalid credential identifier"))?;
    if credential_id.provider_id() != config.id.as_str() {
        return Err(invalid_provider_configuration(
            &config.id,
            "credential namespace or key does not match Provider",
        ));
    }
    Ok(Some(credential_id))
}

fn merge_model_thinking(defaults: &ThinkingConfig, model: &ModelConfig) -> ThinkingConfig {
    let mut thinking = defaults.clone();
    if let Some(mode) = model.thinking_mode {
        thinking.mode = mode;
    }
    if let Some(effort) = model.thinking_effort {
        thinking.effort = Some(effort);
    }
    if let Some(budget_tokens) = model.thinking_budget_tokens {
        thinking.budget_tokens = Some(budget_tokens);
    }
    thinking
}

fn provider_info(config: &ProviderConfig, api_key_configured: bool) -> ProviderInfo {
    ProviderInfo {
        id: config.id.clone(),
        name: config.name.clone(),
        base_url: config.base_url.clone(),
        api_format: config.api_format,
        api_key_configured,
        models: config.models.clone(),
        thinking: config.thinking.clone(),
        enabled: config.enabled,
        created_at: config.created_at.clone(),
    }
}

fn invalid_provider_configuration(provider_id: &str, reason: &'static str) -> AppError {
    AppError::storage(
        "Provider configuration is invalid",
        format!("Provider `{provider_id}`: {reason}"),
        false,
    )
}

fn credential_app_error(operation: &'static str, error: CredentialError) -> AppError {
    let retryable = matches!(error, CredentialError::Unavailable { .. });
    AppError::storage(
        "Provider credential operation failed",
        format!("{operation}: {error}"),
        retryable,
    )
}

fn provider_transaction_error(
    operation: &'static str,
    persistence_error: &AppError,
    rollback_error: &CredentialError,
) -> AppError {
    AppError::storage(
        "Provider changes could not be committed safely",
        format!(
            "{operation} persistence failed: {persistence_error}; credential rollback failed: {rollback_error}"
        ),
        false,
    )
}

#[cfg(test)]
mod tests {
    use std::{
        collections::HashMap,
        sync::{
            Arc, Mutex,
            atomic::{AtomicBool, AtomicUsize, Ordering},
        },
    };

    use codez_core::provider::{
        ApiFormat, CredentialError, CredentialFuture, CredentialId, CredentialStore, ModelConfig,
        ProviderFormData, ProviderInfo, ProviderRepository, ProvidersFile, SecretValue,
        ThinkingConfig, ThinkingMode,
    };
    use codez_core::{AppError, AppErrorKind, PortFuture};

    use super::{
        MAX_BASE_URL_BYTES, MAX_MODEL_ID_BYTES, MAX_MODEL_NAME_BYTES, MAX_PROVIDER_NAME_BYTES,
        MAX_PROVIDERS, ProviderService, generated_id, normalize_and_validate_provider_form,
    };

    const ORIGINAL_SECRET: &str = "sk-provider-secret-that-must-not-cross-ipc";
    const REPLACEMENT_SECRET: &str = "sk-provider-replacement-secret";

    #[derive(Default)]
    struct MemoryProviderRepository {
        data: Mutex<Option<ProvidersFile>>,
        fail_saves: AtomicBool,
        save_attempts: AtomicUsize,
    }

    impl MemoryProviderRepository {
        fn snapshot(&self) -> ProvidersFile {
            self.data
                .lock()
                .expect("Provider repository fixture lock must remain available")
                .clone()
                .unwrap_or(ProvidersFile {
                    providers: Vec::new(),
                    active_provider_id: None,
                })
        }
    }

    impl ProviderRepository for MemoryProviderRepository {
        fn load(&self) -> PortFuture<'_, Option<ProvidersFile>> {
            Box::pin(async move {
                self.data.lock().map(|data| data.clone()).map_err(|_| {
                    AppError::storage(
                        "Provider fixture repository is unavailable",
                        "read Provider fixture repository",
                        true,
                    )
                })
            })
        }

        fn save(&self, data: ProvidersFile) -> PortFuture<'_, ()> {
            Box::pin(async move {
                self.save_attempts.fetch_add(1, Ordering::SeqCst);
                if self.fail_saves.load(Ordering::SeqCst) {
                    return Err(AppError::storage(
                        "Provider fixture write failed",
                        "injected Provider fixture write failure",
                        false,
                    ));
                }
                *self.data.lock().map_err(|_| {
                    AppError::storage(
                        "Provider fixture repository is unavailable",
                        "write Provider fixture repository",
                        true,
                    )
                })? = Some(data);
                Ok(())
            })
        }
    }

    #[derive(Default)]
    struct MemoryCredentialStore {
        values: Mutex<HashMap<CredentialId, String>>,
        reads: AtomicUsize,
        writes: AtomicUsize,
        deletes: AtomicUsize,
        fail_deletes_after_removal: AtomicBool,
    }

    impl CredentialStore for MemoryCredentialStore {
        fn get(&self, id: CredentialId) -> CredentialFuture<'_, SecretValue> {
            Box::pin(async move {
                self.reads.fetch_add(1, Ordering::SeqCst);
                let value = self
                    .values
                    .lock()
                    .map_err(|_| CredentialError::Unavailable {
                        operation: "read a provider test credential",
                    })?
                    .get(&id)
                    .cloned()
                    .ok_or_else(|| CredentialError::NotFound { id: id.clone() })?;
                SecretValue::new(value)
            })
        }

        fn set(&self, id: CredentialId, value: SecretValue) -> CredentialFuture<'_, ()> {
            Box::pin(async move {
                self.writes.fetch_add(1, Ordering::SeqCst);
                self.values
                    .lock()
                    .map_err(|_| CredentialError::Unavailable {
                        operation: "write a provider test credential",
                    })?
                    .insert(id, value.expose_secret().to_string());
                Ok(())
            })
        }

        fn delete(&self, id: CredentialId) -> CredentialFuture<'_, ()> {
            Box::pin(async move {
                self.deletes.fetch_add(1, Ordering::SeqCst);
                let removed = self
                    .values
                    .lock()
                    .map_err(|_| CredentialError::Unavailable {
                        operation: "delete a provider test credential",
                    })?
                    .remove(&id);
                if removed.is_none() {
                    return Err(CredentialError::NotFound { id });
                }
                if self.fail_deletes_after_removal.load(Ordering::SeqCst) {
                    return Err(CredentialError::Unavailable {
                        operation: "finish a provider test credential deletion",
                    });
                }
                Ok(())
            })
        }
    }

    struct ProviderFixture {
        repository: Arc<MemoryProviderRepository>,
        credentials: Arc<MemoryCredentialStore>,
        service: ProviderService,
    }

    impl ProviderFixture {
        async fn new() -> Self {
            let repository = Arc::new(MemoryProviderRepository::default());
            let credentials = Arc::new(MemoryCredentialStore::default());
            let service = ProviderService::new(repository.clone(), credentials.clone())
                .await
                .expect("provider fixture service must initialize");
            Self {
                repository,
                credentials,
                service,
            }
        }
    }

    fn provider_form(api_key: &str) -> ProviderFormData {
        ProviderFormData {
            name: "Fixture Provider".to_string(),
            base_url: "https://provider.invalid/v1".to_string(),
            api_format: Some(ApiFormat::Openai),
            api_key: (!api_key.is_empty()).then(|| {
                SecretValue::new(api_key).expect("non-empty Provider fixture key must be valid")
            }),
            models: vec![ModelConfig {
                id: "fixture-model".to_string(),
                name: "fixture-model".to_string(),
                max_context_tokens: 8_192,
                max_input_tokens: None,
                max_output_tokens: None,
                reasoning_counts_against_context: None,
                supports_vision: None,
                api_format: None,
                thinking_mode: None,
                thinking_effort: None,
                thinking_budget_tokens: None,
            }],
            thinking: ThinkingConfig {
                enabled: true,
                mode: ThinkingMode::Auto,
                effort: None,
                budget_tokens: None,
            },
        }
    }

    fn provider_file(provider_id: &str, credential_id: Option<&str>) -> ProvidersFile {
        let form = provider_form("");
        ProvidersFile {
            providers: vec![codez_core::provider::ProviderConfig {
                id: provider_id.to_string(),
                name: form.name,
                base_url: form.base_url,
                api_format: form.api_format,
                credential_id: credential_id.map(str::to_string),
                models: form.models,
                thinking: form.thinking,
                enabled: true,
                created_at: "2026-07-16T00:00:00Z".to_string(),
                updated_at: "2026-07-16T00:00:00Z".to_string(),
            }],
            active_provider_id: Some(provider_id.to_string()),
        }
    }

    fn validation_kind<T>(result: Result<T, AppError>) -> AppErrorKind {
        result.err().expect("the fixture must be rejected").kind()
    }

    #[tokio::test]
    async fn create_should_normalize_provider_name_and_base_url_like_electron() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form("");
        form.name = "  Fixture Provider  ".to_string();
        form.base_url = "  https://provider.invalid/v1/  ".to_string();

        let info = fixture
            .service
            .create(form)
            .await
            .expect("normalized Provider input must remain valid");

        assert_eq!(
            (info.name.as_str(), info.base_url.as_str()),
            ("Fixture Provider", "https://provider.invalid/v1")
        );
    }

    #[tokio::test]
    async fn create_should_accept_text_fields_at_their_safety_boundaries() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form("");
        form.name = "n".repeat(MAX_PROVIDER_NAME_BYTES);
        form.base_url = "u".repeat(MAX_BASE_URL_BYTES);
        form.models[0].id = "i".repeat(MAX_MODEL_ID_BYTES);
        form.models[0].name = "m".repeat(MAX_MODEL_NAME_BYTES);

        let result = fixture.service.create(form).await;

        assert!(result.is_ok(), "boundary-sized fields must remain writable");
    }

    #[test]
    fn provider_form_validation_should_reject_text_fields_above_safety_limits() {
        let provider_name = {
            let mut form = provider_form("");
            form.name = "n".repeat(MAX_PROVIDER_NAME_BYTES + 1);
            normalize_and_validate_provider_form(&mut form)
        };
        let base_url = {
            let mut form = provider_form("");
            form.base_url = "u".repeat(MAX_BASE_URL_BYTES + 1);
            normalize_and_validate_provider_form(&mut form)
        };
        let model_id = {
            let mut form = provider_form("");
            form.models[0].id = "i".repeat(MAX_MODEL_ID_BYTES + 1);
            normalize_and_validate_provider_form(&mut form)
        };
        let model_name = {
            let mut form = provider_form("");
            form.models[0].name = "m".repeat(MAX_MODEL_NAME_BYTES + 1);
            normalize_and_validate_provider_form(&mut form)
        };

        assert_eq!(
            [provider_name, base_url, model_id, model_name].map(validation_kind),
            [AppErrorKind::Validation; 4]
        );
    }

    #[test]
    fn provider_form_validation_should_reject_embedded_control_characters() {
        let provider_name = {
            let mut form = provider_form("");
            form.name = "Provider\0name".to_string();
            normalize_and_validate_provider_form(&mut form)
        };
        let base_url = {
            let mut form = provider_form("");
            form.base_url = "https://provider.invalid/\nmodels".to_string();
            normalize_and_validate_provider_form(&mut form)
        };
        let model_id = {
            let mut form = provider_form("");
            form.models[0].id = "model\tid".to_string();
            normalize_and_validate_provider_form(&mut form)
        };
        let model_name = {
            let mut form = provider_form("");
            form.models[0].name = "model\rname".to_string();
            normalize_and_validate_provider_form(&mut form)
        };

        assert_eq!(
            [provider_name, base_url, model_id, model_name].map(validation_kind),
            [AppErrorKind::Validation; 4]
        );
    }

    #[tokio::test]
    async fn create_should_validate_required_name_before_any_side_effect() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form(ORIGINAL_SECRET);
        form.name = "   ".to_string();

        let result = fixture.service.create(form).await;

        assert_eq!(
            (
                validation_kind(result),
                fixture.credentials.writes.load(Ordering::SeqCst),
                fixture.repository.save_attempts.load(Ordering::SeqCst),
                fixture.repository.snapshot().providers.len(),
            ),
            (AppErrorKind::Validation, 0, 0, 0)
        );
    }

    #[tokio::test]
    async fn create_should_require_a_non_empty_base_url() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form("");
        form.base_url = " / ".to_string();

        let result = fixture.service.create(form).await;

        assert_eq!(validation_kind(result), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn create_should_require_at_least_one_model() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form("");
        form.models.clear();

        let result = fixture.service.create(form).await;

        assert_eq!(validation_kind(result), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn create_should_require_every_model_name() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form("");
        form.models[0].name = "  ".to_string();

        let result = fixture.service.create(form).await;

        assert_eq!(validation_kind(result), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn create_should_generate_unique_ids_for_empty_and_temporary_model_ids() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form("");
        let mut temporary = form.models[0].clone();
        form.models[0].id.clear();
        temporary.id = "temp_second-model".to_string();
        form.models.push(temporary);

        let info = fixture
            .service
            .create(form)
            .await
            .expect("placeholder model identifiers must be replaced");

        assert!(
            info.models.iter().all(|model| model.id.starts_with("m_"))
                && info.models[0].id != info.models[1].id
        );
    }

    #[tokio::test]
    async fn create_should_reject_duplicate_model_ids() {
        let fixture = ProviderFixture::new().await;
        let mut form = provider_form("");
        let duplicate = form.models[0].clone();
        form.models.push(duplicate);

        let result = fixture.service.create(form).await;

        assert_eq!(validation_kind(result), AppErrorKind::Validation);
    }

    #[test]
    fn provider_form_validation_should_reject_invalid_model_token_limits() {
        let missing_context = {
            let mut form = provider_form("");
            form.models[0].max_context_tokens = 0;
            normalize_and_validate_provider_form(&mut form)
        };
        let automatic_output_cannot_fit = {
            let mut form = provider_form("");
            form.models[0].max_context_tokens = 1;
            normalize_and_validate_provider_form(&mut form)
        };
        let empty_input_limit = {
            let mut form = provider_form("");
            form.models[0].max_input_tokens = Some(0);
            normalize_and_validate_provider_form(&mut form)
        };
        let oversized_input = {
            let mut form = provider_form("");
            form.models[0].max_input_tokens = Some(8_193);
            normalize_and_validate_provider_form(&mut form)
        };
        let empty_output_limit = {
            let mut form = provider_form("");
            form.models[0].max_output_tokens = Some(0);
            normalize_and_validate_provider_form(&mut form)
        };
        let oversized_output = {
            let mut form = provider_form("");
            form.models[0].max_output_tokens = Some(8_192);
            normalize_and_validate_provider_form(&mut form)
        };

        assert_eq!(
            [
                missing_context,
                automatic_output_cannot_fit,
                empty_input_limit,
                oversized_input,
                empty_output_limit,
                oversized_output,
            ]
            .map(validation_kind),
            [AppErrorKind::Validation; 6]
        );
    }

    #[test]
    fn provider_form_validation_should_reject_zero_thinking_budgets() {
        let provider_budget = {
            let mut form = provider_form("");
            form.thinking.budget_tokens = Some(0);
            normalize_and_validate_provider_form(&mut form)
        };
        let model_budget = {
            let mut form = provider_form("");
            form.models[0].thinking_budget_tokens = Some(0);
            normalize_and_validate_provider_form(&mut form)
        };

        assert_eq!(
            [provider_budget, model_budget].map(validation_kind),
            [AppErrorKind::Validation; 2]
        );
    }

    #[tokio::test]
    async fn create_should_reject_a_twenty_first_provider_before_writing_its_credential() {
        let fixture = ProviderFixture::new().await;
        for index in 0..MAX_PROVIDERS {
            let mut form = provider_form("");
            form.name = format!("Provider {index}");
            fixture
                .service
                .create(form)
                .await
                .expect("the first twenty Providers must remain supported");
        }

        let result = fixture.service.create(provider_form(ORIGINAL_SECRET)).await;

        assert_eq!(
            (
                validation_kind(result),
                fixture.repository.snapshot().providers.len(),
                fixture.credentials.writes.load(Ordering::SeqCst),
                fixture.repository.save_attempts.load(Ordering::SeqCst),
            ),
            (AppErrorKind::Validation, MAX_PROVIDERS, 0, MAX_PROVIDERS)
        );
    }

    #[tokio::test]
    async fn update_should_validate_before_replacing_credentials_or_metadata() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("baseline Provider creation must succeed");
        let persisted_before = fixture.repository.snapshot();
        let mut replacement = provider_form(REPLACEMENT_SECRET);
        let duplicate = replacement.models[0].clone();
        replacement.models.push(duplicate);

        let result = fixture.service.update(&created.id, replacement).await;

        assert_eq!(
            (
                validation_kind(result),
                fixture.credentials.reads.load(Ordering::SeqCst),
                fixture.credentials.writes.load(Ordering::SeqCst),
                fixture.repository.save_attempts.load(Ordering::SeqCst),
                fixture.repository.snapshot() == persisted_before,
            ),
            (AppErrorKind::Validation, 0, 1, 1, true)
        );
    }

    #[tokio::test]
    async fn load_should_allow_legacy_data_that_exceeds_new_write_safety_limits() {
        let mut data = provider_file("provider-1", None);
        data.providers[0].name = "n".repeat(MAX_PROVIDER_NAME_BYTES + 1);
        data.providers[0].base_url = "u".repeat(MAX_BASE_URL_BYTES + 1);
        data.providers[0].models[0].id = "i".repeat(MAX_MODEL_ID_BYTES + 1);
        data.providers[0].models[0].name = "m".repeat(MAX_MODEL_NAME_BYTES + 1);
        data.providers[0].thinking.budget_tokens = Some(0);
        data.providers[0].models[0].max_input_tokens = Some(0);
        let repository = Arc::new(MemoryProviderRepository {
            data: Mutex::new(Some(data)),
            fail_saves: AtomicBool::new(false),
            save_attempts: AtomicUsize::new(0),
        });

        let result = ProviderService::new(
            repository.clone(),
            Arc::new(MemoryCredentialStore::default()),
        )
        .await;

        assert_eq!(
            (
                result.is_ok(),
                repository.save_attempts.load(Ordering::SeqCst)
            ),
            (true, 0)
        );
    }

    #[test]
    fn generated_ids_should_retain_the_complete_uuid() {
        let provider_id = generated_id("pv");
        let model_id = generated_id("m");
        let provider_suffix = provider_id
            .strip_prefix("pv_")
            .expect("Provider ID must retain its namespace");
        let model_suffix = model_id
            .strip_prefix("m_")
            .expect("model ID must retain its namespace");

        assert_eq!(
            (
                provider_suffix.len(),
                uuid::Uuid::parse_str(provider_suffix).is_ok(),
                model_suffix.len(),
                uuid::Uuid::parse_str(model_suffix).is_ok(),
            ),
            (32, true, 32, true)
        );
    }

    fn assert_serialized_info_is_redacted(info: &ProviderInfo, secret: &str) {
        let serialized = serde_json::to_string(info).expect("provider info must serialize");

        assert!(!serialized.contains(secret));
        assert!(!serialized.contains("\"apiKey\":"));
        assert!(serialized.contains("\"apiKeyConfigured\":true"));
    }

    #[tokio::test]
    async fn create_should_return_a_redacted_provider_info_when_api_key_is_supplied() {
        let fixture = ProviderFixture::new().await;

        let info = fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("provider creation must succeed");

        assert_serialized_info_is_redacted(&info, ORIGINAL_SECRET);
    }

    #[tokio::test]
    async fn create_should_persist_an_unconfigured_provider_when_api_key_is_empty() {
        let fixture = ProviderFixture::new().await;

        let info = fixture
            .service
            .create(provider_form(""))
            .await
            .expect("an unconfigured Provider must remain editable");
        let persisted = fixture.repository.snapshot();

        assert_eq!(
            (
                info.api_key_configured,
                persisted.providers[0].credential_id.is_some(),
                fixture.credentials.writes.load(Ordering::SeqCst),
            ),
            (false, false, 0)
        );
    }

    #[tokio::test]
    async fn create_should_persist_only_a_credential_reference() {
        let fixture = ProviderFixture::new().await;
        fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("provider creation must succeed");

        let persisted = fixture.repository.snapshot();
        let bytes = serde_json::to_vec(&persisted).expect("Provider metadata must serialize");
        let provider = persisted
            .providers
            .first()
            .expect("created Provider metadata must be persisted");

        assert!(
            provider
                .credential_id
                .as_deref()
                .is_some_and(|value| value.starts_with("provider-api-key:pv_"))
                && !String::from_utf8_lossy(&bytes).contains(ORIGINAL_SECRET)
        );
    }

    #[tokio::test]
    async fn resolve_chat_config_should_use_the_active_provider_model_and_secret() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("provider creation must succeed");

        let resolved = fixture
            .service
            .resolve_chat_config(None, Some("fixture-model"))
            .await
            .expect("active Provider chat configuration must resolve");

        assert_eq!(
            (
                resolved.provider_id.as_str(),
                resolved.base_url.as_str(),
                resolved.api_format,
                resolved.model.name.as_str(),
                resolved.thinking.mode,
                resolved.api_key.expose_secret(),
            ),
            (
                created.id.as_str(),
                "https://provider.invalid/v1",
                ApiFormat::Openai,
                "fixture-model",
                ThinkingMode::Auto,
                ORIGINAL_SECRET,
            )
        );
    }

    #[tokio::test]
    async fn load_should_reject_a_provider_credential_from_another_namespace() {
        let repository = Arc::new(MemoryProviderRepository {
            data: Mutex::new(Some(provider_file(
                "provider-1",
                Some("mcp-secret:provider-1"),
            ))),
            fail_saves: AtomicBool::new(false),
            save_attempts: AtomicUsize::new(0),
        });
        let result =
            ProviderService::new(repository, Arc::new(MemoryCredentialStore::default())).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn load_should_reject_a_provider_credential_for_a_different_provider() {
        let repository = Arc::new(MemoryProviderRepository {
            data: Mutex::new(Some(provider_file(
                "provider-1",
                Some("provider-api-key:provider-2"),
            ))),
            fail_saves: AtomicBool::new(false),
            save_attempts: AtomicUsize::new(0),
        });
        let result =
            ProviderService::new(repository, Arc::new(MemoryCredentialStore::default())).await;

        assert!(result.is_err());
    }

    #[tokio::test]
    async fn get_all_should_not_serialize_a_stored_api_key() {
        let fixture = ProviderFixture::new().await;
        fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("provider creation must succeed");

        let infos = fixture
            .service
            .get_all()
            .await
            .expect("provider listing must succeed");

        assert_serialized_info_is_redacted(
            infos.first().expect("created provider must be listed"),
            ORIGINAL_SECRET,
        );
    }

    #[tokio::test]
    async fn get_all_should_report_an_unconfigured_provider_without_reading_credentials() {
        let fixture = ProviderFixture::new().await;
        fixture
            .service
            .create(provider_form(""))
            .await
            .expect("unconfigured Provider creation must succeed");

        let info = fixture
            .service
            .get_all()
            .await
            .expect("Provider listing must succeed")
            .into_iter()
            .next()
            .expect("created Provider must be listed");

        assert_eq!(
            (
                info.api_key_configured,
                fixture.credentials.reads.load(Ordering::SeqCst),
            ),
            (false, 0)
        );
    }

    #[tokio::test]
    async fn get_all_should_not_report_a_missing_keyring_entry_as_configured() {
        let repository = Arc::new(MemoryProviderRepository {
            data: Mutex::new(Some(provider_file(
                "provider-1",
                Some("provider-api-key:provider-1"),
            ))),
            fail_saves: AtomicBool::new(false),
            save_attempts: AtomicUsize::new(0),
        });
        let credentials = Arc::new(MemoryCredentialStore::default());
        let service = ProviderService::new(repository, credentials.clone())
            .await
            .expect("Provider metadata with a valid credential reference must load");

        let info = service
            .get_all()
            .await
            .expect("a missing keyring entry is a valid unconfigured state")
            .into_iter()
            .next()
            .expect("fixture Provider must be listed");

        assert_eq!(
            (
                info.api_key_configured,
                credentials.reads.load(Ordering::SeqCst),
            ),
            (false, 1)
        );
    }

    #[tokio::test]
    async fn update_should_preserve_the_configured_state_when_api_key_is_empty() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("provider creation must succeed");

        let info = fixture
            .service
            .update(&created.id, provider_form(""))
            .await
            .expect("provider update must succeed");

        assert_serialized_info_is_redacted(&info, ORIGINAL_SECRET);
    }

    #[tokio::test]
    async fn update_should_preserve_the_unconfigured_state_when_api_key_is_empty() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(""))
            .await
            .expect("unconfigured Provider creation must succeed");

        let info = fixture
            .service
            .update(&created.id, provider_form(""))
            .await
            .expect("metadata-only update must succeed");

        assert_eq!(
            (
                info.api_key_configured,
                fixture.credentials.writes.load(Ordering::SeqCst),
            ),
            (false, 0)
        );
    }

    #[tokio::test]
    async fn update_should_configure_a_previously_unconfigured_provider() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(""))
            .await
            .expect("unconfigured Provider creation must succeed");

        let info = fixture
            .service
            .update(&created.id, provider_form(ORIGINAL_SECRET))
            .await
            .expect("supplying the first API key must succeed");

        assert_eq!(
            (
                info.api_key_configured,
                fixture.credentials.reads.load(Ordering::SeqCst),
                fixture.credentials.writes.load(Ordering::SeqCst),
            ),
            (true, 0, 1)
        );
    }

    #[tokio::test]
    async fn delete_should_remove_an_unconfigured_provider_without_touching_credentials() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(""))
            .await
            .expect("unconfigured Provider creation must succeed");

        fixture
            .service
            .delete(&created.id)
            .await
            .expect("unconfigured Provider deletion must succeed");

        assert_eq!(
            (
                fixture
                    .service
                    .get_all()
                    .await
                    .expect("Provider cache must remain readable")
                    .len(),
                fixture.credentials.deletes.load(Ordering::SeqCst),
            ),
            (0, 0)
        );
    }

    #[tokio::test]
    async fn delete_should_remove_configured_provider_metadata_and_credential() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("configured Provider creation must succeed");

        fixture
            .service
            .delete(&created.id)
            .await
            .expect("configured Provider deletion must succeed");

        assert_eq!(
            (
                fixture.repository.snapshot().providers.len(),
                fixture
                    .credentials
                    .values
                    .lock()
                    .expect("credential fixture lock must remain available")
                    .len(),
                fixture.credentials.deletes.load(Ordering::SeqCst),
            ),
            (0, 0, 1)
        );
    }

    #[tokio::test]
    async fn failed_delete_should_restore_the_credential_before_restoring_provider_metadata() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("configured Provider creation must succeed");
        fixture
            .credentials
            .fail_deletes_after_removal
            .store(true, Ordering::SeqCst);

        let result = fixture.service.delete(&created.id).await;
        let current = fixture
            .service
            .get_all()
            .await
            .expect("Provider cache must remain readable");
        let credential_id = CredentialId::new(&created.id)
            .expect("generated Provider ID must remain credential-safe");
        let secret = fixture
            .credentials
            .get(credential_id)
            .await
            .expect("failed deletion must restore the previous credential");

        assert_eq!(
            (
                result.is_err(),
                current.len(),
                current.first().map(|provider| provider.id.as_str()),
                secret.expose_secret(),
            ),
            (true, 1, Some(created.id.as_str()), ORIGINAL_SECRET)
        );
    }

    #[tokio::test]
    async fn test_connection_should_report_an_unconfigured_provider_without_network_or_keychain() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(""))
            .await
            .expect("unconfigured Provider creation must succeed");

        let result = fixture
            .service
            .test_connection(&created.id)
            .await
            .expect("unconfigured connection test must return a domain result");

        assert_eq!(
            (
                result.success,
                result.models,
                fixture.credentials.reads.load(Ordering::SeqCst),
            ),
            (false, None, 0)
        );
    }

    #[tokio::test]
    async fn resolve_chat_config_should_return_a_conflict_when_api_key_is_not_configured() {
        let fixture = ProviderFixture::new().await;
        let created = fixture
            .service
            .create(provider_form(""))
            .await
            .expect("unconfigured Provider creation must succeed");

        let error = fixture
            .service
            .resolve_chat_config(Some(&created.id), None)
            .await
            .err()
            .expect("chat resolution must not invent an API key");

        assert_eq!(error.kind(), AppErrorKind::Conflict);
    }

    #[tokio::test]
    async fn failed_create_rolls_back_the_credential_and_unpublished_cache_entry() {
        let repository = Arc::new(MemoryProviderRepository::default());
        let credentials = Arc::new(MemoryCredentialStore::default());
        let service = ProviderService::new(repository.clone(), credentials.clone())
            .await
            .expect("provider service must initialize");
        repository.fail_saves.store(true, Ordering::SeqCst);

        let result = service.create(provider_form(ORIGINAL_SECRET)).await;

        assert!(result.is_err());
        assert!(
            service
                .get_all()
                .await
                .expect("cache remains readable")
                .is_empty()
        );
        assert!(
            credentials
                .values
                .lock()
                .expect("credential fixture lock is available")
                .is_empty()
        );
    }

    #[tokio::test]
    async fn failed_update_restores_the_previous_credential_and_cache_state() {
        let repository = Arc::new(MemoryProviderRepository::default());
        let credentials = Arc::new(MemoryCredentialStore::default());
        let service = ProviderService::new(repository.clone(), credentials.clone())
            .await
            .expect("provider service must initialize");
        let created = service
            .create(provider_form(ORIGINAL_SECRET))
            .await
            .expect("baseline provider must persist");
        repository.fail_saves.store(true, Ordering::SeqCst);
        let mut replacement = provider_form(REPLACEMENT_SECRET);
        replacement.name = "Replacement name".to_string();

        let result = service.update(&created.id, replacement).await;
        let current = service
            .get_all()
            .await
            .expect("cache remains readable")
            .into_iter()
            .next()
            .expect("baseline provider remains cached");
        let credential_id =
            CredentialId::new(&created.id).expect("generated provider ID is credential-safe");
        let secret = credentials
            .get(credential_id)
            .await
            .expect("previous credential must be restored");

        assert!(result.is_err());
        assert_eq!(current.name, "Fixture Provider");
        assert_eq!(secret.expose_secret(), ORIGINAL_SECRET);
    }

    #[tokio::test]
    async fn failed_first_credential_update_removes_the_new_secret_and_preserves_unconfigured_state()
     {
        let repository = Arc::new(MemoryProviderRepository::default());
        let credentials = Arc::new(MemoryCredentialStore::default());
        let service = ProviderService::new(repository.clone(), credentials.clone())
            .await
            .expect("provider service must initialize");
        let created = service
            .create(provider_form(""))
            .await
            .expect("unconfigured baseline provider must persist");
        repository.fail_saves.store(true, Ordering::SeqCst);

        let result = service
            .update(&created.id, provider_form(ORIGINAL_SECRET))
            .await;
        let current = service
            .get_all()
            .await
            .expect("cache remains readable")
            .into_iter()
            .next()
            .expect("baseline provider remains cached");

        assert_eq!(
            (
                result.is_err(),
                current.api_key_configured,
                credentials
                    .values
                    .lock()
                    .expect("credential fixture lock is available")
                    .len(),
            ),
            (true, false, 0)
        );
    }
}
