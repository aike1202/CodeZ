use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};
use tokio::fs;
use serde::{Serialize, Deserialize};

use codez_contracts::{AttachmentPreviewBytes, ComposerImageAttachment, DraftImageAttachment, SessionImageAttachment};
use codez_core::{AppError, AppPaths};
use uuid::Uuid;

const DRAFT_TTL_SECS: u64 = 24 * 60 * 60;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AttachmentMetadata {
    attachment: ComposerImageAttachment,
    created_at: u64,
}

pub struct DecodedImage {
    pub bytes: Vec<u8>,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
}

pub struct ImageCodec;

impl ImageCodec {
    pub fn inspect(bytes: &[u8], _declared_mime_type: Option<&str>) -> Result<DecodedImage, AppError> {
        let format = image::guess_format(bytes).map_err(|e| AppError::validation(format!("Invalid image format: {}", e)))?;
        let img = image::load_from_memory_with_format(bytes, format)
            .map_err(|e| AppError::validation(format!("Failed to load image: {}", e)))?;

        let mime_type = match format {
            image::ImageFormat::Jpeg => "image/jpeg",
            image::ImageFormat::Png => "image/png",
            image::ImageFormat::WebP => "image/webp",
            _ => "image/png", // fallback
        };

        Ok(DecodedImage {
            bytes: bytes.to_vec(),
            mime_type: mime_type.to_string(),
            width: img.width(),
            height: img.height(),
        })
    }

    pub fn thumbnail(image: &DecodedImage) -> Result<Vec<u8>, AppError> {
        let img = image::load_from_memory(&image.bytes)
            .map_err(|e| AppError::internal(format!("Failed to parse image for thumbnail: {}", e)))?;
        let thumb = img.thumbnail(256, 256);
        let mut bytes: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut bytes);
        thumb.write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| AppError::internal(format!("Failed to generate thumbnail: {}", e)))?;
        Ok(bytes)
    }

    pub fn optimize(image: &DecodedImage, max_bytes: usize) -> Result<DecodedImage, AppError> {
        let img = image::load_from_memory(&image.bytes)
            .map_err(|e| AppError::internal(format!("Failed to parse image for optimization: {}", e)))?;
        
        let mut bytes: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut bytes);
        img.write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| AppError::internal(format!("Failed to optimize image: {}", e)))?;
        
        if bytes.len() > max_bytes {
            let smaller = img.resize(img.width() / 2, img.height() / 2, image::imageops::FilterType::Triangle);
            let mut bytes2: Vec<u8> = Vec::new();
            let mut cursor2 = std::io::Cursor::new(&mut bytes2);
            smaller.write_to(&mut cursor2, image::ImageFormat::Jpeg)
                .map_err(|e| AppError::internal(format!("Failed to resize image: {}", e)))?;
            bytes = bytes2;
        }

        Ok(DecodedImage {
            bytes: bytes.clone(),
            mime_type: "image/jpeg".to_string(),
            width: img.width(),
            height: img.height(),
        })
    }
}

pub struct AttachmentService {
    root_path: PathBuf,
}

impl AttachmentService {
    #[must_use]
    pub fn new(app_paths: Arc<AppPaths>) -> Self {
        Self {
            root_path: app_paths.data_directory().join("attachments"),
        }
    }

    fn assert_identifier(value: &str, label: &str) -> Result<(), AppError> {
        if !value.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Err(AppError::validation(format!("Invalid {} identifier", label)));
        }
        Ok(())
    }

    fn assert_contained(&self, target: &Path) -> Result<(), AppError> {
        if !target.starts_with(&self.root_path) {
            return Err(AppError::validation("Invalid attachment storage key"));
        }
        Ok(())
    }

    fn directory_for(&self, storage_key: &str) -> Result<PathBuf, AppError> {
        if let Some(rest) = storage_key.strip_prefix("attachment:") {
            let resolved = self.root_path.join(rest);
            self.assert_contained(&resolved)?;
            Ok(resolved)
        } else {
            Err(AppError::validation("Invalid attachment storage key"))
        }
    }

    fn path_for(&self, storage_key: &str, variant: &str) -> Result<PathBuf, AppError> {
        let resolved = self.directory_for(storage_key)?.join(variant);
        self.assert_contained(&resolved)?;
        Ok(resolved)
    }

    pub async fn import_draft(&self, name: &str, declared_mime_type: Option<&str>, bytes: &[u8]) -> Result<DraftImageAttachment, AppError> {
        if name.trim().is_empty() {
            return Err(AppError::validation("Image name is required"));
        }
        if bytes.is_empty() {
            return Err(AppError::validation("Image bytes are empty"));
        }

        let decoded = ImageCodec::inspect(bytes, declared_mime_type)?;
        let thumbnail = ImageCodec::thumbnail(&decoded)?;

        let id = Uuid::new_v4().to_string();
        let draft_id = Uuid::new_v4().to_string();
        let storage_key = format!("attachment:drafts/{}/{}", draft_id, id);

        let attachment = DraftImageAttachment {
            id: id.clone(),
            draft_id,
            scope: "draft".to_string(),
            kind: "image".to_string(),
            name: Path::new(name).file_name().unwrap_or_default().to_string_lossy().to_string(),
            mime_type: decoded.mime_type,
            width: decoded.width,
            height: decoded.height,
            size_bytes: decoded.bytes.len() as u64,
            storage_key: storage_key.clone(),
        };

        self.write_attachment(&ComposerImageAttachment::Draft(attachment.clone()), &decoded.bytes, &thumbnail).await?;
        Ok(attachment)
    }

    async fn write_attachment(&self, attachment: &ComposerImageAttachment, original: &[u8], thumbnail: &[u8]) -> Result<(), AppError> {
        let storage_key = match attachment {
            ComposerImageAttachment::Session(s) => &s.storage_key,
            ComposerImageAttachment::Draft(d) => &d.storage_key,
        };
        let final_dir = self.directory_for(storage_key)?;
        let temp_dir = final_dir.with_extension(format!("tmp-{}", Uuid::new_v4()));

        fs::create_dir_all(&temp_dir).await.map_err(|e| AppError::internal(format!("Failed to create temp dir: {}", e)))?;

        let meta = AttachmentMetadata {
            attachment: attachment.clone(),
            created_at: SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64,
        };

        let res = async {
            fs::write(temp_dir.join("original"), original).await?;
            fs::write(temp_dir.join("thumbnail"), thumbnail).await?;
            let meta_json = serde_json::to_string(&meta).unwrap();
            fs::write(temp_dir.join("meta.json"), meta_json).await?;
            Ok::<_, std::io::Error>(())
        }.await;

        if res.is_err() {
            let _ = fs::remove_dir_all(&temp_dir).await;
            return Err(AppError::internal("Failed to write attachment files"));
        }

        if let Some(parent) = final_dir.parent() {
            let _ = fs::create_dir_all(parent).await;
        }

        fs::rename(&temp_dir, &final_dir).await.map_err(|e| {
            let _ = fs::remove_dir_all(&temp_dir);
            AppError::internal(format!("Failed to rename attachment dir: {}", e))
        })?;

        Ok(())
    }

    pub async fn promote_drafts(&self, session_id: &str, attachments: Vec<ComposerImageAttachment>) -> Result<Vec<SessionImageAttachment>, AppError> {
        Self::assert_identifier(session_id, "session")?;
        let mut created = Vec::new();
        let mut promoted = Vec::new();

        for attachment in attachments {
            match attachment {
                ComposerImageAttachment::Session(s) => {
                    if s.session_id != session_id {
                        self.rollback_promotion(session_id, &created).await;
                        return Err(AppError::validation("Attachment does not belong to this session"));
                    }
                    promoted.push(s);
                }
                ComposerImageAttachment::Draft(d) => {
                    let destination_key = format!("attachment:sessions/{}/{}", session_id, d.id);
                    let source_dir = self.directory_for(&d.storage_key)?;
                    let destination_dir = self.directory_for(&destination_key)?;

                    if let Some(parent) = destination_dir.parent() {
                        let _ = fs::create_dir_all(parent).await;
                    }

                    if let Err(e) = Self::copy_dir_recursive(&source_dir, &destination_dir).await {
                        self.rollback_promotion(session_id, &created).await;
                        return Err(AppError::internal(format!("Failed to promote attachment: {}", e)));
                    }

                    created.push(d.id.clone());

                    let stored = SessionImageAttachment {
                        id: d.id,
                        kind: d.kind,
                        name: d.name,
                        mime_type: d.mime_type,
                        width: d.width,
                        height: d.height,
                        size_bytes: d.size_bytes,
                        scope: "session".to_string(),
                        session_id: session_id.to_string(),
                        storage_key: destination_key.clone(),
                    };

                    let meta_path = self.path_for(&destination_key, "meta.json")?;
                    let mut created_at = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_millis() as u64;
                    if let Ok(existing_meta_str) = fs::read_to_string(&meta_path).await {
                        if let Ok(existing_meta) = serde_json::from_str::<AttachmentMetadata>(&existing_meta_str) {
                            created_at = existing_meta.created_at;
                        }
                    }
                    let meta = AttachmentMetadata {
                        attachment: ComposerImageAttachment::Session(stored.clone()),
                        created_at,
                    };
                    if let Ok(meta_json) = serde_json::to_string(&meta) {
                        let _ = fs::write(meta_path, meta_json).await;
                    }

                    promoted.push(stored);
                }
            }
        }
        Ok(promoted)
    }

    async fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dst).await?;
        let mut entries = fs::read_dir(src).await?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let ty = entry.file_type().await?;
            if ty.is_dir() {
                Box::pin(Self::copy_dir_recursive(&entry.path(), &dst.join(entry.file_name()))).await?;
            } else {
                fs::copy(entry.path(), dst.join(entry.file_name())).await?;
            }
        }
        Ok(())
    }

    pub async fn rollback_promotion(&self, session_id: &str, attachment_ids: &[String]) {
        if Self::assert_identifier(session_id, "session").is_err() {
            return;
        }
        for id in attachment_ids {
            if Self::assert_identifier(id, "attachment").is_ok() {
                if let Ok(dir) = self.directory_for(&format!("attachment:sessions/{}/{}", session_id, id)) {
                    let _ = fs::remove_dir_all(dir).await;
                }
            }
        }
    }

    pub async fn discard_drafts(&self, draft_ids: &[String]) -> Result<(), AppError> {
        for draft_id in draft_ids {
            Self::assert_identifier(draft_id, "draft")?;
            let target = self.root_path.join("drafts").join(draft_id);
            self.assert_contained(&target)?;
            let _ = fs::remove_dir_all(target).await;
        }
        Ok(())
    }

    pub async fn read_preview(&self, attachment: &ComposerImageAttachment, variant: &str) -> Result<AttachmentPreviewBytes, AppError> {
        let (storage_key, mime_type) = match attachment {
            ComposerImageAttachment::Session(s) => (&s.storage_key, &s.mime_type),
            ComposerImageAttachment::Draft(d) => (&d.storage_key, &d.mime_type),
        };
        let path = self.path_for(storage_key, variant)?;
        let bytes = fs::read(&path).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::validation("Attachment not found")
            } else {
                AppError::internal(format!("Failed to read preview: {}", e))
            }
        })?;

        let res_mime_type = if variant == "thumbnail" {
            "image/jpeg".to_string()
        } else {
            mime_type.clone()
        };

        Ok(AttachmentPreviewBytes {
            mime_type: res_mime_type,
            bytes,
        })
    }

    pub async fn delete_session(&self, session_id: &str) -> Result<(), AppError> {
        Self::assert_identifier(session_id, "session")?;
        let target = self.root_path.join("sessions").join(session_id);
        self.assert_contained(&target)?;
        let _ = fs::remove_dir_all(target).await;
        Ok(())
    }

    pub async fn cleanup_orphans(&self, live_session_ids: &HashSet<String>, now_millis: u64) -> Result<(), AppError> {
        let session_root = self.root_path.join("sessions");
        if let Ok(mut entries) = fs::read_dir(&session_root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(ty) = entry.file_type().await {
                    if ty.is_dir() {
                        let name = entry.file_name().to_string_lossy().to_string();
                        if !live_session_ids.contains(&name) {
                            let _ = fs::remove_dir_all(entry.path()).await;
                        }
                    }
                }
            }
        }

        let draft_root = self.root_path.join("drafts");
        if let Ok(mut entries) = fs::read_dir(&draft_root).await {
            while let Ok(Some(entry)) = entries.next_entry().await {
                if let Ok(ty) = entry.file_type().await {
                    if ty.is_dir() {
                        let draft_dir = entry.path();
                        let mut created_at = 0;
                        if let Ok(mut att_entries) = fs::read_dir(&draft_dir).await {
                            if let Ok(Some(att_entry)) = att_entries.next_entry().await {
                                let meta_path = att_entry.path().join("meta.json");
                                if let Ok(meta_str) = fs::read_to_string(&meta_path).await {
                                    if let Ok(meta) = serde_json::from_str::<AttachmentMetadata>(&meta_str) {
                                        created_at = meta.created_at;
                                    }
                                }
                            }
                        }
                        if now_millis.saturating_sub(created_at) > DRAFT_TTL_SECS * 1000 {
                            let _ = fs::remove_dir_all(draft_dir).await;
                        }
                    }
                }
            }
        }

        Ok(())
    }
}
