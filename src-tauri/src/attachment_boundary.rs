use codez_contracts::{
    AttachmentPreviewBytes as WireAttachmentPreviewBytes,
    ComposerImageAttachment as WireComposerImageAttachment,
    DraftImageAttachment as WireDraftImageAttachment,
    SessionImageAttachment as WireSessionImageAttachment,
};
use codez_core::{
    AppError, AttachmentPreviewBytes, ComposerImageAttachment, DraftImageAttachment,
    SessionImageAttachment,
};

pub(crate) fn session_from_wire(
    attachment: WireSessionImageAttachment,
) -> Result<SessionImageAttachment, AppError> {
    let WireSessionImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        session_id,
    } = attachment;
    validate_identifier(&id, "attachment")?;
    validate_identifier(&session_id, "session")?;
    validate_wire_fields(
        &kind,
        &scope,
        "session",
        &storage_key,
        &format!("attachment:sessions/{session_id}/{id}"),
    )?;
    Ok(SessionImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        session_id,
    })
}

pub(crate) fn session_to_wire(attachment: SessionImageAttachment) -> WireSessionImageAttachment {
    let SessionImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        session_id,
    } = attachment;
    WireSessionImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        session_id,
    }
}

pub(crate) fn draft_from_wire(
    attachment: WireDraftImageAttachment,
) -> Result<DraftImageAttachment, AppError> {
    let WireDraftImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        draft_id,
    } = attachment;
    validate_identifier(&id, "attachment")?;
    validate_identifier(&draft_id, "draft")?;
    validate_wire_fields(
        &kind,
        &scope,
        "draft",
        &storage_key,
        &format!("attachment:drafts/{draft_id}/{id}"),
    )?;
    Ok(DraftImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        draft_id,
    })
}

pub(crate) fn draft_to_wire(attachment: DraftImageAttachment) -> WireDraftImageAttachment {
    let DraftImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        draft_id,
    } = attachment;
    WireDraftImageAttachment {
        id,
        kind,
        name,
        mime_type,
        width,
        height,
        size_bytes,
        storage_key,
        scope,
        draft_id,
    }
}

pub(crate) fn composer_from_wire(
    attachment: WireComposerImageAttachment,
) -> Result<ComposerImageAttachment, AppError> {
    match attachment {
        WireComposerImageAttachment::Session(attachment) => {
            session_from_wire(attachment).map(ComposerImageAttachment::Session)
        }
        WireComposerImageAttachment::Draft(attachment) => {
            draft_from_wire(attachment).map(ComposerImageAttachment::Draft)
        }
    }
}

pub(crate) fn composer_to_wire(attachment: ComposerImageAttachment) -> WireComposerImageAttachment {
    match attachment {
        ComposerImageAttachment::Session(attachment) => {
            WireComposerImageAttachment::Session(session_to_wire(attachment))
        }
        ComposerImageAttachment::Draft(attachment) => {
            WireComposerImageAttachment::Draft(draft_to_wire(attachment))
        }
    }
}

pub(crate) fn preview_to_wire(preview: AttachmentPreviewBytes) -> WireAttachmentPreviewBytes {
    let AttachmentPreviewBytes { mime_type, bytes } = preview;
    WireAttachmentPreviewBytes { mime_type, bytes }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), AppError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        return Err(AppError::validation(format!(
            "The {label} identifier is invalid"
        )));
    }
    Ok(())
}

fn validate_wire_fields(
    kind: &str,
    scope: &str,
    expected_scope: &str,
    storage_key: &str,
    expected_storage_key: &str,
) -> Result<(), AppError> {
    if kind != "image" || scope != expected_scope || storage_key != expected_storage_key {
        return Err(AppError::validation(
            "The attachment identity does not match its storage scope",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use codez_contracts::{
        ComposerImageAttachment as WireComposerImageAttachment,
        DraftImageAttachment as WireDraftImageAttachment,
        SessionImageAttachment as WireSessionImageAttachment,
    };

    use codez_core::{AppErrorKind, AttachmentPreviewBytes};

    use super::{composer_from_wire, composer_to_wire, preview_to_wire};

    #[test]
    fn composer_session_conversion_preserves_every_wire_field() {
        let source = WireComposerImageAttachment::Session(WireSessionImageAttachment {
            id: "image-1".to_string(),
            kind: "image".to_string(),
            name: "photo.png".to_string(),
            mime_type: "image/png".to_string(),
            width: 640,
            height: 480,
            size_bytes: 4096,
            storage_key: "attachment:sessions/session-1/image-1".to_string(),
            scope: "session".to_string(),
            session_id: "session-1".to_string(),
        });

        let restored = composer_to_wire(
            composer_from_wire(source.clone()).expect("valid session attachment must convert"),
        );

        assert_eq!(restored, source);
    }

    #[test]
    fn composer_draft_conversion_preserves_every_wire_field() {
        let source = WireComposerImageAttachment::Draft(WireDraftImageAttachment {
            id: "image-2".to_string(),
            kind: "image".to_string(),
            name: "draft.webp".to_string(),
            mime_type: "image/webp".to_string(),
            width: 320,
            height: 240,
            size_bytes: 2048,
            storage_key: "attachment:drafts/draft-1/image-2".to_string(),
            scope: "draft".to_string(),
            draft_id: "draft-1".to_string(),
        });

        let restored = composer_to_wire(
            composer_from_wire(source.clone()).expect("valid draft attachment must convert"),
        );

        assert_eq!(restored, source);
    }

    #[test]
    fn preview_conversion_preserves_mime_type_and_bytes() {
        let source = AttachmentPreviewBytes {
            mime_type: "image/jpeg".to_string(),
            bytes: vec![1, 2, 3, 4],
        };

        let restored = preview_to_wire(source);

        assert_eq!(
            (restored.mime_type, restored.bytes),
            ("image/jpeg".to_string(), vec![1, 2, 3, 4])
        );
    }

    #[test]
    fn composer_conversion_rejects_a_scope_storage_key_mismatch() {
        let source = WireComposerImageAttachment::Session(WireSessionImageAttachment {
            id: "image-1".to_string(),
            kind: "image".to_string(),
            name: "photo.png".to_string(),
            mime_type: "image/png".to_string(),
            width: 640,
            height: 480,
            size_bytes: 4096,
            storage_key: "attachment:drafts/draft-1/image-1".to_string(),
            scope: "session".to_string(),
            session_id: "session-1".to_string(),
        });

        let error = composer_from_wire(source)
            .expect_err("a session attachment must use its canonical session storage key");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }
}
