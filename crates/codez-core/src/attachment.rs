use serde::{Deserialize, Serialize};

/// Image attachment owned by a persisted session.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionImageAttachment {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub storage_key: String,
    pub scope: String,
    pub session_id: String,
}

/// Image attachment retained in temporary draft storage.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftImageAttachment {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub mime_type: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub storage_key: String,
    pub scope: String,
    pub draft_id: String,
}

/// Attachment accepted by composer and context workflows before draft promotion.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum ComposerImageAttachment {
    Session(SessionImageAttachment),
    Draft(DraftImageAttachment),
}

/// Raw bytes and media type returned for an attachment preview.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AttachmentPreviewBytes {
    pub mime_type: String,
    pub bytes: Vec<u8>,
}
