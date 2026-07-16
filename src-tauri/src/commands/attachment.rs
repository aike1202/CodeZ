use tauri::{command, State};
use codez_contracts::{CommandError, ComposerImageAttachment, DraftImageAttachment, SessionImageAttachment, AttachmentPreviewBytes};
use crate::{state::AppState, error::command_result};

#[command(async)]
pub async fn attachment_import_draft(
    state: State<'_, AppState>,
    name: String,
    declared_mime_type: Option<String>,
    bytes: Vec<u8>,
) -> Result<DraftImageAttachment, CommandError> {
    let result = state.attachment.import_draft(&name, declared_mime_type.as_deref(), &bytes).await;
    command_result(&state.errors, result)
}

#[command(async)]
pub async fn attachment_promote_drafts(
    state: State<'_, AppState>,
    session_id: String,
    attachments: Vec<ComposerImageAttachment>,
) -> Result<Vec<SessionImageAttachment>, CommandError> {
    let result = state.attachment.promote_drafts(&session_id, attachments).await;
    command_result(&state.errors, result)
}

#[command(async)]
pub async fn attachment_discard_drafts(
    state: State<'_, AppState>,
    draft_ids: Vec<String>,
) -> Result<(), CommandError> {
    let result = state.attachment.discard_drafts(&draft_ids).await;
    command_result(&state.errors, result)
}

#[command(async)]
pub async fn attachment_read_preview(
    state: State<'_, AppState>,
    attachment: ComposerImageAttachment,
    variant: String,
) -> Result<AttachmentPreviewBytes, CommandError> {
    let result = state.attachment.read_preview(&attachment, &variant).await;
    command_result(&state.errors, result)
}

#[command(async)]
pub async fn attachment_delete_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), CommandError> {
    let result = state.attachment.delete_session(&session_id).await;
    command_result(&state.errors, result)
}
