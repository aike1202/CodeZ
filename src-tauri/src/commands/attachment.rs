use codez_contracts::{
    AttachmentPreviewBytes, CommandError, ComposerImageAttachment, DraftImageAttachment,
    SessionImageAttachment,
};
use codez_core::{AppError, ComposerImageAttachment as DomainComposerImageAttachment, SessionId};
use codez_runtime::session_maintenance::{SessionActivityLease, SessionMaintenanceCoordinator};
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
        let activity = begin_session_activity(&state.session_maintenance, &session_id)?;
        let attachments = attachments
            .into_iter()
            .map(composer_from_wire)
            .collect::<Result<Vec<_>, _>>()?;
        state
            .attachment
            .promote_drafts(activity.session_id().as_str(), attachments)
            .await
    }
    .await
    .map(|attachments| attachments.into_iter().map(session_to_wire).collect());
    command_result(&state.errors, result)
}

#[command(async)]
pub async fn attachment_rollback_promotion(
    state: State<'_, AppState>,
    session_id: String,
    attachment_ids: Vec<String>,
) -> Result<(), CommandError> {
    let result = async {
        let activity = begin_session_activity(&state.session_maintenance, &session_id)?;
        state
            .attachment
            .rollback_promotion(activity.session_id().as_str(), &attachment_ids)
            .await
    }
    .await;
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
        let _activity = begin_preview_activity(&state.session_maintenance, &attachment)?;
        state.attachment.read_preview(&attachment, &variant).await
    }
    .await
    .map(preview_to_wire);
    command_result(&state.errors, result)
}

fn parse_session_id(value: &str) -> Result<SessionId, AppError> {
    SessionId::parse(value).map_err(|error| AppError::validation(error.to_string()))
}

fn begin_session_activity(
    coordinator: &SessionMaintenanceCoordinator,
    session_id: &str,
) -> Result<SessionActivityLease, AppError> {
    coordinator
        .try_begin_activity(parse_session_id(session_id)?)
        .map_err(AppError::from)
}

fn begin_preview_activity(
    coordinator: &SessionMaintenanceCoordinator,
    attachment: &DomainComposerImageAttachment,
) -> Result<Option<SessionActivityLease>, AppError> {
    match attachment {
        DomainComposerImageAttachment::Session(attachment) => {
            begin_session_activity(coordinator, &attachment.session_id).map(Some)
        }
        DomainComposerImageAttachment::Draft(_) => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use codez_core::{
        AppErrorKind, ComposerImageAttachment, DraftImageAttachment, SessionId,
        SessionImageAttachment,
    };
    use codez_runtime::session_maintenance::{
        SessionMaintenanceCoordinator, SessionMaintenanceError,
    };

    use super::{begin_preview_activity, begin_session_activity};

    fn session_id() -> SessionId {
        SessionId::parse("session-1").expect("fixture session ID must parse")
    }

    fn session_attachment(session_id: &str) -> ComposerImageAttachment {
        ComposerImageAttachment::Session(SessionImageAttachment {
            id: "image-1".to_string(),
            kind: "image".to_string(),
            name: "fixture.png".to_string(),
            mime_type: "image/png".to_string(),
            width: 1,
            height: 1,
            size_bytes: 1,
            storage_key: format!("attachment:sessions/{session_id}/image-1"),
            scope: "session".to_string(),
            session_id: session_id.to_string(),
        })
    }

    fn draft_attachment() -> ComposerImageAttachment {
        ComposerImageAttachment::Draft(DraftImageAttachment {
            id: "image-1".to_string(),
            kind: "image".to_string(),
            name: "fixture.png".to_string(),
            mime_type: "image/png".to_string(),
            width: 1,
            height: 1,
            size_bytes: 1,
            storage_key: "attachment:drafts/draft-1/image-1".to_string(),
            scope: "draft".to_string(),
            draft_id: "draft-1".to_string(),
        })
    }

    #[test]
    fn shared_attachment_activity_should_block_session_maintenance_until_drop() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let activity =
            begin_session_activity(&coordinator, "session-1").expect("fixture activity must begin");

        let blocked = coordinator
            .try_begin_maintenance(session_id())
            .expect_err("shared attachment activity must block maintenance");
        assert_eq!(blocked, SessionMaintenanceError::MaintenanceBlocked);

        drop(activity);
        assert!(coordinator.try_begin_maintenance(session_id()).is_ok());
    }

    #[test]
    fn session_preview_should_hold_shared_activity() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let activity = begin_preview_activity(&coordinator, &session_attachment("session-1"))
            .expect("session preview activity must begin")
            .expect("session preview must acquire an activity lease");

        assert_eq!(activity.session_id().as_str(), "session-1");
    }

    #[test]
    fn draft_preview_should_not_acquire_session_activity() {
        let coordinator = SessionMaintenanceCoordinator::new();

        let activity = begin_preview_activity(&coordinator, &draft_attachment())
            .expect("draft preview does not require session coordination");

        assert!(activity.is_none());
    }

    #[test]
    fn session_preview_should_reject_an_unportable_session_id() {
        let coordinator = SessionMaintenanceCoordinator::new();

        let error = begin_preview_activity(&coordinator, &session_attachment("CON"))
            .expect_err("reserved session IDs must not become filesystem authority");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn shared_attachment_activity_should_reject_a_recovery_block() {
        let coordinator = SessionMaintenanceCoordinator::new();
        let maintenance = coordinator
            .try_begin_maintenance(session_id())
            .expect("fixture maintenance must begin");
        coordinator
            .mark_recovery_required(maintenance.session_id())
            .expect("fixture recovery marker must be recorded");
        drop(maintenance);

        let error = begin_session_activity(&coordinator, "session-1")
            .expect_err("recovery must block attachment activity");

        assert_eq!(
            (error.kind(), error.retryable()),
            (AppErrorKind::RunActive, true)
        );
    }
}
