use std::sync::Arc;
use std::path::PathBuf;
use chrono::Utc;
use codez_contracts::provider::{
    ProviderConfig, ProviderInfo, ProviderFormData, ConnectionTestResult, ProvidersFile,
    ChatProviderErrorCode,
};
use codez_core::AppError;
use codez_storage::AtomicFileStore;
use codez_storage::credentials::{CredentialStore, CredentialId, CredentialKind, SecretValue};
use tokio::sync::RwLock;

pub struct ProviderService {
    store: Arc<AtomicFileStore>,
    credentials: Arc<dyn CredentialStore>,
    providers_path: PathBuf,
    cache: RwLock<ProvidersFile>,
}

impl ProviderService {
    pub async fn new(
        store: Arc<AtomicFileStore>,
        credentials: Arc<dyn CredentialStore>,
        providers_path: PathBuf,
    ) -> Result<Self, AppError> {
        let service = Self {
            store,
            credentials,
            providers_path,
            cache: RwLock::new(ProvidersFile {
                providers: Vec::new(),
                active_provider_id: None,
            }),
        };
        service.load().await?;
        Ok(service)
    }

    pub async fn load(&self) -> Result<(), AppError> {
        let file_data = self.store
            .read_json::<ProvidersFile>(&self.providers_path)
            .await
            .map_err(AppError::from)?;
        
        if let Some(mut data) = file_data {
            for p in &mut data.providers {
                for m in &mut p.models {
                    if m.max_context_tokens == 0 {
                        m.max_context_tokens = 8192;
                    }
                }
            }
            let mut cache = self.cache.write().await;
            *cache = data;
        }
        Ok(())
    }

    async fn save(&self, data: &ProvidersFile) -> Result<(), AppError> {
        self.store
            .write_json(&self.providers_path, data)
            .await
            .map_err(AppError::from)
    }

    pub async fn get_all(&self) -> Result<Vec<ProviderInfo>, AppError> {
        let cache = self.cache.read().await;
        let mut infos = Vec::new();
        for p in &cache.providers {
            let api_key = if p.encryption == "safeStorage" {
                let id = CredentialId::new(CredentialKind::ProviderApiKey, &p.id)
                    .map_err(|_| AppError::internal("Invalid credential ID"))?;
                if let Ok(secret) = self.credentials.get(&id) {
                    secret.expose_secret().to_string()
                } else {
                    String::new()
                }
            } else {
                String::new()
            };

            infos.push(ProviderInfo {
                id: p.id.clone(),
                name: p.name.clone(),
                base_url: p.base_url.clone(),
                api_format: p.api_format,
                api_key,
                models: p.models.clone(),
                thinking: p.thinking.clone(),
                enabled: p.enabled,
                created_at: p.created_at.clone(),
            });
        }
        Ok(infos)
    }

    pub async fn create(&self, data: ProviderFormData) -> Result<ProviderInfo, AppError> {
        let id = format!("pv_{}", uuid::Uuid::now_v7().to_string().replace("-", "").chars().take(12).collect::<String>());
        
        let now = Utc::now().to_rfc3339();
        let api_key_ref = id.clone();
        
        if !data.api_key.is_empty() {
            let cred_id = CredentialId::new(CredentialKind::ProviderApiKey, &id)
                .map_err(|_| AppError::internal("Invalid credential ID"))?;
            let secret = SecretValue::new(data.api_key.clone())
                .map_err(|e| AppError::internal(format!("Invalid API Key: {:?}", e)))?;
            self.credentials.set(&cred_id, &secret)
                .map_err(|e| AppError::internal(format!("Failed to save credential: {:?}", e)))?;
        }

        let mut config = ProviderConfig {
            id: id.clone(),
            name: data.name.clone(),
            base_url: data.base_url.clone(),
            api_format: data.api_format,
            api_key_ref,
            encryption: "safeStorage".to_string(),
            models: data.models.clone(),
            thinking: data.thinking.clone(),
            enabled: true,
            created_at: now.clone(),
            updated_at: now.clone(),
        };

        for model in &mut config.models {
            if model.id.is_empty() || model.id.starts_with("temp_") {
                model.id = format!("m_{}", uuid::Uuid::now_v7().to_string().replace("-", "").chars().take(8).collect::<String>());
            }
        }

        let mut cache = self.cache.write().await;
        cache.providers.push(config.clone());
        self.save(&*cache).await?;

        Ok(ProviderInfo {
            id: config.id,
            name: config.name,
            base_url: config.base_url,
            api_format: config.api_format,
            api_key: data.api_key,
            models: config.models,
            thinking: config.thinking,
            enabled: config.enabled,
            created_at: config.created_at,
        })
    }

    pub async fn update(&self, id: &str, data: ProviderFormData) -> Result<ProviderInfo, AppError> {
        let mut cache = self.cache.write().await;
        let p_idx = cache.providers.iter().position(|p| p.id == id)
            .ok_or_else(|| AppError::not_found("Provider not found"))?;

        let p = &mut cache.providers[p_idx];
        p.name = data.name.clone();
        p.base_url = data.base_url.clone();
        p.api_format = data.api_format;
        p.thinking = data.thinking.clone();
        p.updated_at = Utc::now().to_rfc3339();

        let mut next_models = data.models.clone();
        for model in &mut next_models {
            if model.id.is_empty() || model.id.starts_with("temp_") {
                model.id = format!("m_{}", uuid::Uuid::now_v7().to_string().replace("-", "").chars().take(8).collect::<String>());
            }
        }
        p.models = next_models;

        if !data.api_key.is_empty() {
            let cred_id = CredentialId::new(CredentialKind::ProviderApiKey, id)
                .map_err(|_| AppError::internal("Invalid credential ID"))?;
            let secret = SecretValue::new(data.api_key.clone())
                .map_err(|e| AppError::internal(format!("Invalid API Key: {:?}", e)))?;
            self.credentials.set(&cred_id, &secret)
                .map_err(|e| AppError::internal(format!("Failed to save credential: {:?}", e)))?;
            p.encryption = "safeStorage".to_string();
            p.api_key_ref = id.to_string();
        }

        let info = ProviderInfo {
            id: p.id.clone(),
            name: p.name.clone(),
            base_url: p.base_url.clone(),
            api_format: p.api_format,
            api_key: String::new(),
            models: p.models.clone(),
            thinking: p.thinking.clone(),
            enabled: p.enabled,
            created_at: p.created_at.clone(),
        };

        self.save(&*cache).await?;
        Ok(info)
    }

    pub async fn delete(&self, id: &str) -> Result<(), AppError> {
        let mut cache = self.cache.write().await;
        cache.providers.retain(|p| p.id != id);
        
        if let Ok(cred_id) = CredentialId::new(CredentialKind::ProviderApiKey, id) {
            let _ = self.credentials.delete(&cred_id);
        }

        self.save(&*cache).await?;
        Ok(())
    }

    pub async fn set_active(&self, id: &str) -> Result<(), AppError> {
        let mut cache = self.cache.write().await;
        if !cache.providers.iter().any(|p| p.id == id) {
            return Err(AppError::not_found("Provider not found"));
        }
        cache.active_provider_id = Some(id.to_string());
        self.save(&*cache).await?;
        Ok(())
    }

    pub async fn test_connection(&self, id: &str) -> Result<ConnectionTestResult, AppError> {
        let cache = self.cache.read().await;
        let config = cache.providers.iter().find(|p| p.id == id)
            .ok_or_else(|| AppError::not_found("Provider not found"))?;

        let api_key = if config.encryption == "safeStorage" {
            let cred_id = CredentialId::new(CredentialKind::ProviderApiKey, id)
                .map_err(|_| AppError::internal("Invalid credential ID"))?;
            if let Ok(secret) = self.credentials.get(&cred_id) {
                secret.expose_secret().to_string()
            } else {
                return Ok(ConnectionTestResult {
                    success: false,
                    message: "Failed to read API Key".into(),
                    models: None,
                });
            }
        } else {
            String::new()
        };

        let client = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|e| AppError::internal(e.to_string()))?;

        let url = format!("{}/models", config.base_url);
        let resp = client.get(&url)
            .header("Authorization", format!("Bearer {}", api_key))
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
                struct ModelResp { data: Option<Vec<ModelItem>> }
                #[derive(serde::Deserialize)]
                struct ModelItem { id: String }

                if let Ok(json) = r.json::<ModelResp>().await {
                    let models: Vec<String> = json.data.unwrap_or_default().into_iter().map(|m| m.id).take(30).collect();
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
            },
            Err(e) => {
                Ok(ConnectionTestResult {
                    success: false,
                    message: format!("网络错误: {}", e),
                    models: None,
                })
            }
        }
    }
}
