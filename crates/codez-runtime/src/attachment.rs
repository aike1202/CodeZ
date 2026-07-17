use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::Arc,
    time::SystemTime,
};

use serde::{Deserialize, Serialize};
use tokio::fs;
use tokio::sync::Mutex;
use uuid::Uuid;

use codez_core::{
    AppError, AppPaths, AttachmentPreviewBytes, ComposerImageAttachment, DraftImageAttachment,
    SessionImageAttachment,
};

const DRAFT_TTL_SECS: u64 = 24 * 60 * 60;
const MAX_ATTACHMENT_METADATA_BYTES: u64 = 64 * 1024;

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

/// Verified session image content resolved for a single outbound Provider request.
pub struct ResolvedSessionImage {
    pub attachment: SessionImageAttachment,
    pub bytes: Vec<u8>,
}

pub struct ImageCodec;

impl ImageCodec {
    pub fn inspect(
        bytes: &[u8],
        _declared_mime_type: Option<&str>,
    ) -> Result<DecodedImage, AppError> {
        let format = image::guess_format(bytes)
            .map_err(|e| AppError::validation(format!("Invalid image format: {}", e)))?;
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
        let img = image::load_from_memory(&image.bytes).map_err(|e| {
            AppError::internal(format!("Failed to parse image for thumbnail: {}", e))
        })?;
        let thumb = img.thumbnail(256, 256);
        let mut bytes: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut bytes);
        thumb
            .write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| AppError::internal(format!("Failed to generate thumbnail: {}", e)))?;
        Ok(bytes)
    }

    pub fn optimize(image: &DecodedImage, max_bytes: usize) -> Result<DecodedImage, AppError> {
        let img = image::load_from_memory(&image.bytes).map_err(|e| {
            AppError::internal(format!("Failed to parse image for optimization: {}", e))
        })?;

        let mut bytes: Vec<u8> = Vec::new();
        let mut cursor = std::io::Cursor::new(&mut bytes);
        img.write_to(&mut cursor, image::ImageFormat::Jpeg)
            .map_err(|e| AppError::internal(format!("Failed to optimize image: {}", e)))?;

        if bytes.len() > max_bytes {
            let smaller = img.resize(
                img.width() / 2,
                img.height() / 2,
                image::imageops::FilterType::Triangle,
            );
            let mut bytes2: Vec<u8> = Vec::new();
            let mut cursor2 = std::io::Cursor::new(&mut bytes2);
            smaller
                .write_to(&mut cursor2, image::ImageFormat::Jpeg)
                .map_err(|e| AppError::internal(format!("Failed to resize image: {}", e)))?;
            bytes = bytes2;
        }

        Ok(DecodedImage {
            bytes,
            mime_type: "image/jpeg".to_string(),
            width: img.width(),
            height: img.height(),
        })
    }
}

pub struct AttachmentService {
    root_path: PathBuf,
    promotion_lock: Mutex<()>,
}

impl AttachmentService {
    #[must_use]
    pub fn new(app_paths: Arc<AppPaths>) -> Self {
        Self {
            root_path: app_paths.data_directory().join("attachments"),
            promotion_lock: Mutex::new(()),
        }
    }

    fn assert_identifier(value: &str, label: &str) -> Result<(), AppError> {
        if value.is_empty()
            || value.len() > 256
            || !value
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
        {
            return Err(AppError::validation(format!(
                "Invalid {} identifier",
                label
            )));
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
        let Some(rest) = storage_key.strip_prefix("attachment:") else {
            return Err(AppError::validation("Invalid attachment storage key"));
        };
        let relative = Path::new(rest);
        if relative.as_os_str().is_empty()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err(AppError::validation("Invalid attachment storage key"));
        }
        let resolved = self.root_path.join(relative);
        self.assert_contained(&resolved)?;
        Ok(resolved)
    }

    fn path_for(&self, storage_key: &str, variant: &str) -> Result<PathBuf, AppError> {
        let mut components = Path::new(variant).components();
        if !matches!(components.next(), Some(Component::Normal(_))) || components.next().is_some() {
            return Err(AppError::validation("Invalid attachment variant"));
        }
        let resolved = self.directory_for(storage_key)?.join(variant);
        self.assert_contained(&resolved)?;
        Ok(resolved)
    }

    fn expected_session_storage_key(session_id: &str, attachment_id: &str) -> String {
        format!("attachment:sessions/{session_id}/{attachment_id}")
    }

    fn validate_session_image_reference(
        session_id: &str,
        attachment: &SessionImageAttachment,
    ) -> Result<String, AppError> {
        Self::assert_identifier(session_id, "session")?;
        Self::assert_identifier(&attachment.id, "attachment")?;
        let expected_storage_key = Self::expected_session_storage_key(session_id, &attachment.id);
        if attachment.session_id != session_id
            || attachment.scope != "session"
            || attachment.kind != "image"
            || attachment.storage_key != expected_storage_key
        {
            return Err(AppError::validation(
                "Attachment does not belong to this session",
            ));
        }
        Ok(expected_storage_key)
    }

    async fn assert_path_has_no_symlink_component(&self, target: &Path) -> Result<(), AppError> {
        let relative = target
            .strip_prefix(&self.root_path)
            .map_err(|_| AppError::validation("Invalid attachment storage key"))?;
        let mut current = self.root_path.clone();
        for component in relative.components() {
            let Component::Normal(component) = component else {
                return Err(AppError::validation("Invalid attachment storage key"));
            };
            current.push(component);
            match fs::symlink_metadata(&current).await {
                Ok(metadata) if metadata.file_type().is_symlink() => {
                    return Err(AppError::validation("Attachment storage is invalid"));
                }
                Ok(_) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) => {
                    return Err(AppError::storage(
                        "Attachment storage could not be inspected",
                        error.to_string(),
                        true,
                    ));
                }
            }
        }
        Ok(())
    }

    async fn read_bounded_regular_file(
        &self,
        path: &Path,
        max_bytes: u64,
        label: &'static str,
    ) -> Result<Vec<u8>, AppError> {
        self.assert_path_has_no_symlink_component(path).await?;
        let metadata = fs::symlink_metadata(path).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::not_found(format!("Attachment {label} was not found"))
            } else {
                AppError::storage(
                    "Attachment storage could not be inspected",
                    error.to_string(),
                    true,
                )
            }
        })?;
        if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
            return Err(AppError::validation("Attachment storage is invalid"));
        }
        if metadata.len() == 0 || metadata.len() > max_bytes {
            return Err(AppError::validation(format!(
                "Attachment {label} exceeds the allowed size"
            )));
        }
        let bytes = fs::read(path).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                AppError::not_found(format!("Attachment {label} was not found"))
            } else {
                AppError::storage(
                    "Attachment storage could not be read",
                    error.to_string(),
                    true,
                )
            }
        })?;
        if u64::try_from(bytes.len()).ok() != Some(metadata.len()) {
            return Err(AppError::validation(
                "Attachment storage changed while being read",
            ));
        }
        Ok(bytes)
    }

    /// Resolves an original image from the owning session for an outbound Provider request.
    ///
    /// The caller-supplied attachment is treated only as an identity reference. MIME type,
    /// byte length, and contents come from the verified metadata and payload stored under the
    /// matching session directory.
    pub async fn read_session_image(
        &self,
        session_id: &str,
        attachment: &SessionImageAttachment,
        max_bytes: u64,
    ) -> Result<ResolvedSessionImage, AppError> {
        if max_bytes == 0 {
            return Err(AppError::validation(
                "Attachment image limit must be positive",
            ));
        }
        let storage_key = Self::validate_session_image_reference(session_id, attachment)?;
        let metadata_path = self.path_for(&storage_key, "meta.json")?;
        let metadata_bytes = self
            .read_bounded_regular_file(&metadata_path, MAX_ATTACHMENT_METADATA_BYTES, "metadata")
            .await?;
        let metadata: AttachmentMetadata = serde_json::from_slice(&metadata_bytes)
            .map_err(|_| AppError::validation("Attachment metadata is invalid"))?;
        let ComposerImageAttachment::Session(stored) = metadata.attachment else {
            return Err(AppError::validation("Attachment metadata is invalid"));
        };
        let stored_storage_key = Self::validate_session_image_reference(session_id, &stored)?;
        if stored_storage_key != storage_key
            || !matches!(
                stored.mime_type.as_str(),
                "image/jpeg" | "image/png" | "image/webp"
            )
        {
            return Err(AppError::unsupported(
                "The stored attachment image format is not supported",
            ));
        }
        if stored.size_bytes == 0 || stored.size_bytes > max_bytes {
            return Err(AppError::validation(
                "Attachment image exceeds the Provider size limit",
            ));
        }
        let original_path = self.path_for(&storage_key, "original")?;
        let bytes = self
            .read_bounded_regular_file(&original_path, stored.size_bytes, "image")
            .await?;
        if u64::try_from(bytes.len()).ok() != Some(stored.size_bytes) {
            return Err(AppError::validation(
                "Attachment image size does not match metadata",
            ));
        }
        Ok(ResolvedSessionImage {
            attachment: stored,
            bytes,
        })
    }

    pub async fn import_draft(
        &self,
        name: &str,
        declared_mime_type: Option<&str>,
        bytes: &[u8],
    ) -> Result<DraftImageAttachment, AppError> {
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
            name: Path::new(name)
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .to_string(),
            mime_type: decoded.mime_type,
            width: decoded.width,
            height: decoded.height,
            size_bytes: decoded.bytes.len() as u64,
            storage_key: storage_key.clone(),
        };

        self.write_attachment(
            &ComposerImageAttachment::Draft(attachment.clone()),
            &decoded.bytes,
            &thumbnail,
        )
        .await?;
        Ok(attachment)
    }

    async fn write_attachment(
        &self,
        attachment: &ComposerImageAttachment,
        original: &[u8],
        thumbnail: &[u8],
    ) -> Result<(), AppError> {
        let storage_key = match attachment {
            ComposerImageAttachment::Session(s) => &s.storage_key,
            ComposerImageAttachment::Draft(d) => &d.storage_key,
        };
        let final_dir = self.directory_for(storage_key)?;
        let temp_dir = final_dir.with_extension(format!("tmp-{}", Uuid::new_v4()));

        fs::create_dir_all(&temp_dir)
            .await
            .map_err(|e| AppError::internal(format!("Failed to create temp dir: {}", e)))?;

        let meta = AttachmentMetadata {
            attachment: attachment.clone(),
            created_at: SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        };
        let meta_json = serde_json::to_vec(&meta).map_err(|source| {
            AppError::internal(format!("Failed to serialize attachment metadata: {source}"))
        })?;

        let res = async {
            fs::write(temp_dir.join("original"), original).await?;
            fs::write(temp_dir.join("thumbnail"), thumbnail).await?;
            fs::write(temp_dir.join("meta.json"), meta_json).await?;
            Ok::<_, std::io::Error>(())
        }
        .await;

        if res.is_err() {
            let _ = fs::remove_dir_all(&temp_dir).await;
            return Err(AppError::internal("Failed to write attachment files"));
        }

        if let Some(parent) = final_dir.parent() {
            let _ = fs::create_dir_all(parent).await;
        }

        if let Err(error) = fs::rename(&temp_dir, &final_dir).await {
            let _ = fs::remove_dir_all(&temp_dir).await;
            return Err(AppError::internal(format!(
                "Failed to rename attachment dir: {error}"
            )));
        }

        Ok(())
    }

    pub async fn promote_drafts(
        &self,
        session_id: &str,
        attachments: Vec<ComposerImageAttachment>,
    ) -> Result<Vec<SessionImageAttachment>, AppError> {
        let _promotion_guard = self.promotion_lock.lock().await;
        Self::assert_identifier(session_id, "session")?;
        let mut created = Vec::new();
        let mut promoted = Vec::new();

        for attachment in attachments {
            match attachment {
                ComposerImageAttachment::Session(s) => {
                    if s.session_id != session_id {
                        self.rollback_created_promotions(session_id, &created).await;
                        return Err(AppError::validation(
                            "Attachment does not belong to this session",
                        ));
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
                        self.rollback_created_promotions(session_id, &created).await;
                        return Err(AppError::internal(format!(
                            "Failed to promote attachment: {}",
                            e
                        )));
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
                    let mut created_at = SystemTime::now()
                        .duration_since(SystemTime::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64;
                    if let Ok(existing_meta_str) = fs::read_to_string(&meta_path).await {
                        if let Ok(existing_meta) =
                            serde_json::from_str::<AttachmentMetadata>(&existing_meta_str)
                        {
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

    async fn rollback_created_promotions(&self, session_id: &str, attachment_ids: &[String]) {
        if let Err(error) = self
            .rollback_promotion_locked(session_id, attachment_ids)
            .await
        {
            tracing::warn!(error = %error, "attachment promotion cleanup failed");
        }
    }

    async fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
        fs::create_dir_all(dst).await?;
        let mut entries = fs::read_dir(src).await?;
        while let Ok(Some(entry)) = entries.next_entry().await {
            let ty = entry.file_type().await?;
            if ty.is_dir() {
                Box::pin(Self::copy_dir_recursive(
                    &entry.path(),
                    &dst.join(entry.file_name()),
                ))
                .await?;
            } else {
                fs::copy(entry.path(), dst.join(entry.file_name())).await?;
            }
        }
        Ok(())
    }

    /// Removes copies created by draft promotion while retaining their draft sources.
    ///
    /// The session and attachment identifiers are validated before any filesystem changes.
    /// Existing copies move to a private staging directory before deletion, so a failed move
    /// cannot leave a partially visible rollback in the session attachment namespace.
    pub async fn rollback_promotion(
        &self,
        session_id: &str,
        attachment_ids: &[String],
    ) -> Result<(), AppError> {
        let _promotion_guard = self.promotion_lock.lock().await;
        self.rollback_promotion_locked(session_id, attachment_ids)
            .await
    }

    async fn rollback_promotion_locked(
        &self,
        session_id: &str,
        attachment_ids: &[String],
    ) -> Result<(), AppError> {
        Self::assert_identifier(session_id, "session")?;

        let mut seen = HashSet::with_capacity(attachment_ids.len());
        let mut targets = Vec::with_capacity(attachment_ids.len());
        for attachment_id in attachment_ids {
            Self::assert_identifier(attachment_id, "attachment")?;
            if seen.insert(attachment_id.as_str()) {
                let directory = self.directory_for(&format!(
                    "attachment:sessions/{}/{}",
                    session_id, attachment_id
                ))?;
                targets.push((attachment_id.as_str(), directory));
            }
        }

        let mut existing_targets = Vec::with_capacity(targets.len());
        for (attachment_id, directory) in targets {
            let exists = fs::try_exists(&directory).await.map_err(|error| {
                AppError::storage(
                    "Attachment promotion rollback could not be completed",
                    format!("check promoted attachment {attachment_id}: {error}"),
                    true,
                )
            })?;
            if exists {
                existing_targets.push((attachment_id, directory));
            }
        }

        if existing_targets.is_empty() {
            return Ok(());
        }

        let staging_directory = self
            .root_path
            .join(".promotion-rollbacks")
            .join(Uuid::new_v4().to_string());
        self.assert_contained(&staging_directory)?;
        fs::create_dir_all(&staging_directory)
            .await
            .map_err(|error| {
                AppError::storage(
                    "Attachment promotion rollback could not be completed",
                    format!("create rollback staging directory: {error}"),
                    true,
                )
            })?;

        let mut moved = Vec::with_capacity(existing_targets.len());
        for (attachment_id, source) in existing_targets {
            let staged = staging_directory.join(attachment_id);
            if let Err(error) = fs::rename(&source, &staged).await {
                let restore_error = Self::restore_staged_promotions(&moved).await.err();
                let _ = fs::remove_dir_all(&staging_directory).await;
                let diagnostic = match restore_error {
                    Some(restore_error) => format!(
                        "stage promoted attachment {attachment_id}: {error}; restore staged attachments: {restore_error}"
                    ),
                    None => format!("stage promoted attachment {attachment_id}: {error}"),
                };
                return Err(AppError::storage(
                    "Attachment promotion rollback could not be completed",
                    diagnostic,
                    true,
                ));
            }
            moved.push((source, staged));
        }

        if let Err(error) = fs::remove_dir_all(&staging_directory).await {
            tracing::warn!(
                error = %error,
                "attachment promotion rollback completed but staging cleanup failed"
            );
        }
        Ok(())
    }

    async fn restore_staged_promotions(moved: &[(PathBuf, PathBuf)]) -> Result<(), std::io::Error> {
        for (source, staged) in moved.iter().rev() {
            fs::rename(staged, source).await?;
        }
        Ok(())
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

    pub async fn read_preview(
        &self,
        attachment: &ComposerImageAttachment,
        variant: &str,
    ) -> Result<AttachmentPreviewBytes, AppError> {
        if !matches!(variant, "original" | "thumbnail") {
            return Err(AppError::validation("Invalid attachment preview variant"));
        }
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
        let _promotion_guard = self.promotion_lock.lock().await;
        Self::assert_identifier(session_id, "session")?;
        let target = self.root_path.join("sessions").join(session_id);
        self.assert_contained(&target)?;
        self.assert_path_has_no_symlink_component(&target).await?;
        match fs::symlink_metadata(&target).await {
            Ok(metadata) if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() => {
                Err(AppError::validation(
                    "Session attachment storage is invalid",
                ))
            }
            Ok(_) => fs::remove_dir_all(&target).await.map_err(|error| {
                AppError::storage(
                    "Session attachments could not be deleted",
                    format!("remove {}: {error}", target.display()),
                    false,
                )
            }),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(AppError::storage(
                "Session attachment storage could not be inspected",
                format!("inspect {}: {error}", target.display()),
                false,
            )),
        }
    }

    pub async fn cleanup_orphans(
        &self,
        live_session_ids: &HashSet<String>,
        now_millis: u64,
    ) -> Result<(), AppError> {
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
                                    if let Ok(meta) =
                                        serde_json::from_str::<AttachmentMetadata>(&meta_str)
                                    {
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

#[cfg(test)]
mod tests {
    use std::{
        path::{Path, PathBuf},
        sync::Arc,
    };

    use codez_core::{AppErrorKind, AppPaths, ComposerImageAttachment, SessionImageAttachment};
    use tokio::fs;

    use super::{AttachmentMetadata, AttachmentService};

    fn attachment_service(root: &Path) -> AttachmentService {
        let paths = AppPaths::new(
            root.join("data"),
            root.join("cache"),
            root.join("logs"),
            root.join("resources"),
            root.join("temp"),
            root.join("home"),
        )
        .expect("absolute fixture paths must be valid");
        AttachmentService::new(Arc::new(paths))
    }

    fn attachment_directory(
        root: &Path,
        scope: &str,
        owner_id: &str,
        attachment_id: &str,
    ) -> PathBuf {
        root.join("data")
            .join("attachments")
            .join(scope)
            .join(owner_id)
            .join(attachment_id)
    }

    async fn write_attachment_copy(path: &Path) {
        fs::create_dir_all(path)
            .await
            .expect("fixture attachment directory must be created");
        fs::write(path.join("original"), [1_u8, 2, 3])
            .await
            .expect("fixture attachment source must be written");
    }

    fn session_attachment(
        session_id: &str,
        attachment_id: &str,
        mime_type: &str,
        size_bytes: u64,
    ) -> SessionImageAttachment {
        SessionImageAttachment {
            id: attachment_id.to_string(),
            kind: "image".to_string(),
            name: "fixture-image".to_string(),
            mime_type: mime_type.to_string(),
            width: 1,
            height: 1,
            size_bytes,
            storage_key: format!("attachment:sessions/{session_id}/{attachment_id}"),
            scope: "session".to_string(),
            session_id: session_id.to_string(),
        }
    }

    async fn write_session_attachment(
        root: &Path,
        attachment: &SessionImageAttachment,
        bytes: &[u8],
    ) {
        let path = attachment_directory(root, "sessions", &attachment.session_id, &attachment.id);
        fs::create_dir_all(&path)
            .await
            .expect("fixture session attachment directory must be created");
        fs::write(path.join("original"), bytes)
            .await
            .expect("fixture image must be written");
        let metadata = AttachmentMetadata {
            attachment: ComposerImageAttachment::Session(attachment.clone()),
            created_at: 0,
        };
        fs::write(
            path.join("meta.json"),
            serde_json::to_vec(&metadata).expect("fixture metadata must serialize"),
        )
        .await
        .expect("fixture metadata must be written");
    }

    #[test]
    fn directory_for_rejects_parent_traversal_in_a_storage_key() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());

        let error = service
            .directory_for("attachment:drafts/draft-1/../../outside")
            .expect_err("attachment storage must not escape through a parent component");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn path_for_rejects_a_multicomponent_variant() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());

        let error = service
            .path_for("attachment:drafts/draft-1/image-1", "../original")
            .expect_err("attachment variants must be direct child names");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn rollback_promotion_removes_the_session_copy_and_keeps_the_draft() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());
        let draft = attachment_directory(directory.path(), "drafts", "draft-1", "image-1");
        let promoted = attachment_directory(directory.path(), "sessions", "session-1", "image-1");
        write_attachment_copy(&draft).await;
        write_attachment_copy(&promoted).await;

        service
            .rollback_promotion("session-1", &["image-1".to_string()])
            .await
            .expect("valid promoted attachment must roll back");

        assert!(
            fs::try_exists(&draft)
                .await
                .expect("draft path must be readable")
        );
        assert!(
            !fs::try_exists(&promoted)
                .await
                .expect("session path must be readable")
        );
    }

    #[tokio::test]
    async fn rollback_promotion_treats_missing_or_already_removed_copies_as_success() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());
        let promoted = attachment_directory(directory.path(), "sessions", "session-1", "image-1");
        write_attachment_copy(&promoted).await;

        service
            .rollback_promotion(
                "session-1",
                &[
                    "missing".to_string(),
                    "image-1".to_string(),
                    "image-1".to_string(),
                ],
            )
            .await
            .expect("missing copies and duplicate ids must be idempotent");
        service
            .rollback_promotion("session-1", &["image-1".to_string()])
            .await
            .expect("a repeated rollback must be idempotent");

        assert!(
            !fs::try_exists(&promoted)
                .await
                .expect("session path must be readable")
        );
    }

    #[tokio::test]
    async fn rollback_promotion_rejects_invalid_identifiers_before_removing_copies() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());
        let promoted = attachment_directory(directory.path(), "sessions", "session-1", "image-1");
        write_attachment_copy(&promoted).await;

        let traversal_error = service
            .rollback_promotion("session-1", &["../image-1".to_string()])
            .await
            .expect_err("traversal input must be rejected");
        let empty_session_error = service
            .rollback_promotion("", &["image-1".to_string()])
            .await
            .expect_err("empty session input must be rejected");

        assert_eq!(traversal_error.kind(), AppErrorKind::Validation);
        assert_eq!(empty_session_error.kind(), AppErrorKind::Validation);
        assert!(
            fs::try_exists(&promoted)
                .await
                .expect("session path must be readable")
        );
    }

    #[tokio::test]
    async fn rollback_promotion_cannot_remove_an_attachment_from_another_session() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());
        let first = attachment_directory(directory.path(), "sessions", "session-1", "image-1");
        let second = attachment_directory(directory.path(), "sessions", "session-2", "image-1");
        write_attachment_copy(&first).await;
        write_attachment_copy(&second).await;

        service
            .rollback_promotion("session-2", &["image-1".to_string()])
            .await
            .expect("session-scoped rollback must succeed");

        assert!(
            fs::try_exists(&first)
                .await
                .expect("other session path must be readable")
        );
        assert!(
            !fs::try_exists(&second)
                .await
                .expect("target session path must be readable")
        );
    }

    #[tokio::test]
    async fn read_session_image_uses_verified_stored_metadata() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());
        let stored = session_attachment("session-1", "image-1", "image/png", 3);
        write_session_attachment(directory.path(), &stored, &[1, 2, 3]).await;
        let mut requested = stored.clone();
        requested.mime_type = "image/jpeg".to_string();
        requested.name = "untrusted-name.jpg".to_string();

        let image = service
            .read_session_image("session-1", &requested, 8)
            .await
            .expect("session-owned image must resolve");

        assert_eq!(image.attachment.mime_type, "image/png");
        assert_eq!(image.bytes, vec![1, 2, 3]);
    }

    #[tokio::test]
    async fn read_session_image_rejects_cross_session_references() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());
        let stored = session_attachment("session-2", "image-1", "image/png", 3);
        write_session_attachment(directory.path(), &stored, &[1, 2, 3]).await;

        let error = match service.read_session_image("session-1", &stored, 8).await {
            Ok(_) => panic!("another session's image must not resolve"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[tokio::test]
    async fn read_session_image_rejects_images_over_the_provider_limit() {
        let directory = tempfile::tempdir().expect("temporary fixture directory must exist");
        let service = attachment_service(directory.path());
        let stored = session_attachment("session-1", "image-1", "image/png", 3);
        write_session_attachment(directory.path(), &stored, &[1, 2, 3]).await;

        let error = match service.read_session_image("session-1", &stored, 2).await {
            Ok(_) => panic!("images exceeding the Provider limit must fail closed"),
            Err(error) => error,
        };

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }
}
