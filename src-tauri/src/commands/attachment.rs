use codez_contracts::{
    AttachmentPreviewBytes, CommandError, ComposerImageAttachment, DraftImageAttachment,
    SessionImageAttachment,
};
use tauri::{State, command};

use crate::{
    attachment_boundary::{composer_from_wire, draft_to_wire, preview_to_wire, session_to_wire},
    error::command_result,
    state::AppState,
};

#[command(async)]
pub async fn attachment_import_draft(
    state: State<'_, AppState>,
    name: String,
    declared_mime_type: Option<String>,
    bytes: Vec<u8>,
) -> Result<DraftImageAttachment, CommandError> {
    let result = state
        .attachment
        .import_draft(&name, declared_mime_type.as_deref(), &bytes)
        .await
        .map(draft_to_wire);
    command_result(&state.errors, result)
}

#[command(async)]
pub async fn attachment_promote_drafts(
    state: State<'_, AppState>,
    session_id: String,
    attachments: Vec<ComposerImageAttachment>,
) -> Result<Vec<SessionImageAttachment>, CommandError> {
    let result = async {
        let attachments = attachments
            .into_iter()
            .map(composer_from_wire)
            .collect::<Result<Vec<_>, _>>()?;
        state
            .attachment
            .promote_drafts(&session_id, attachments)
            .await
    }
    .await
    .map(|attachments| attachments.into_iter().map(session_to_wire).collect());
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
    let result = async {
        let attachment = composer_from_wire(attachment)?;
        state.attachment.read_preview(&attachment, &variant).await
    }
    .await
    .map(preview_to_wire);
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
