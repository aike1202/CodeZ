use std::{
    fs, io,
    path::{Path, PathBuf},
};

use codez_core::{AppError, SessionId};
use serde_json::Value;

use crate::AtomicFileStore;

const SESSIONS_DIRECTORY: &str = "sessions";
const SESSION_FILE_SUFFIX: &str = ".json";

/// Atomic repository for session documents stored below the application data root.
#[derive(Debug)]
pub struct SessionStore {
    directory: PathBuf,
    files: AtomicFileStore,
}

impl SessionStore {
    #[must_use]
    pub fn new(data_directory: PathBuf, files: AtomicFileStore) -> Self {
        Self {
            directory: data_directory.join(SESSIONS_DIRECTORY),
            files,
        }
    }

    /// Loads every valid session document in deterministic descending-ID order.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the repository directory is unsafe, a session
    /// document is corrupt, or a stored document does not match its file name.
    pub async fn list(&self) -> Result<Vec<Value>, AppError> {
        let entries = discover_session_files(self.directory.clone()).await?;
        let mut sessions = Vec::with_capacity(entries.len());
        for entry in entries {
            let Some(session) = self
                .files
                .read_json::<Value>(&entry.path)
                .await
                .map_err(AppError::from)?
            else {
                continue;
            };
            validate_stored_session(&session, &entry.id, &entry.path)?;
            sessions.push(session);
        }
        Ok(sessions)
    }

    /// Loads one session document without consulting legacy Electron storage.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the repository directory or document is unsafe,
    /// corrupt, or inconsistent with `session_id`.
    pub async fn get(&self, session_id: &SessionId) -> Result<Option<Value>, AppError> {
        inspect_session_directory(self.directory.clone()).await?;
        let path = self.path_for(session_id);
        let session = self
            .files
            .read_json::<Value>(&path)
            .await
            .map_err(AppError::from)?;
        if let Some(value) = session.as_ref() {
            validate_stored_session(value, session_id, &path)?;
        }
        Ok(session)
    }

    /// Atomically creates or replaces one session document.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the payload ID is absent or inconsistent, the
    /// repository directory is unsafe, or the atomic write fails.
    pub async fn save(&self, session_id: &SessionId, session: &Value) -> Result<(), AppError> {
        validate_input_session(session, session_id)?;
        inspect_session_directory(self.directory.clone()).await?;
        self.files
            .write_json(&self.path_for(session_id), session)
            .await
            .map_err(Into::into)
    }

    /// Removes one session document without following filesystem links.
    ///
    /// Returns whether a document was removed.
    ///
    /// # Errors
    ///
    /// Returns [`AppError`] when the repository directory or target is unsafe,
    /// or the removal cannot be persisted.
    pub async fn delete(&self, session_id: &SessionId) -> Result<bool, AppError> {
        inspect_session_directory(self.directory.clone()).await?;
        self.files
            .remove_file(&self.path_for(session_id))
            .await
            .map_err(Into::into)
    }

    fn path_for(&self, session_id: &SessionId) -> PathBuf {
        self.directory
            .join(format!("{}{SESSION_FILE_SUFFIX}", session_id.as_str()))
    }
}

#[derive(Debug)]
struct SessionFile {
    id: SessionId,
    path: PathBuf,
}

async fn discover_session_files(directory: PathBuf) -> Result<Vec<SessionFile>, AppError> {
    let error_path = directory.clone();
    tokio::task::spawn_blocking(move || discover_session_files_blocking(&directory))
        .await
        .map_err(|source| repository_error("join session discovery worker", &error_path, source))?
        .map_err(|source| repository_error("list session directory", &error_path, source))
}

async fn inspect_session_directory(directory: PathBuf) -> Result<(), AppError> {
    let error_path = directory.clone();
    tokio::task::spawn_blocking(move || inspect_session_directory_blocking(&directory))
        .await
        .map_err(|source| repository_error("join session directory worker", &error_path, source))?
        .map(|_| ())
        .map_err(|source| repository_error("inspect session directory", &error_path, source))
}

fn discover_session_files_blocking(directory: &Path) -> io::Result<Vec<SessionFile>> {
    if !inspect_session_directory_blocking(directory)? {
        return Ok(Vec::new());
    }
    let mut sessions = Vec::new();
    for entry in fs::read_dir(directory)? {
        let entry = entry?;
        let file_name = entry.file_name();
        let Some(file_name) = file_name.to_str() else {
            continue;
        };
        let Some(raw_id) = file_name.strip_suffix(SESSION_FILE_SUFFIX) else {
            continue;
        };
        let Ok(id) = SessionId::parse(raw_id) else {
            continue;
        };
        let file_type = entry.file_type()?;
        if file_type.is_symlink() || !file_type.is_file() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "session entry is not a regular file",
            ));
        }
        sessions.push(SessionFile {
            id,
            path: entry.path(),
        });
    }
    sessions.sort_unstable_by(|left, right| right.id.as_str().cmp(left.id.as_str()));
    Ok(sessions)
}

fn inspect_session_directory_blocking(directory: &Path) -> io::Result<bool> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "session repository is not a regular directory",
            ))
        }
        Ok(_) => Ok(true),
        Err(source) if source.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(source) => Err(source),
    }
}

fn validate_input_session(session: &Value, expected: &SessionId) -> Result<(), AppError> {
    let raw_id = session
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| AppError::validation("Session ID is required"))?;
    let parsed =
        SessionId::parse(raw_id).map_err(|_| AppError::validation("Session ID is invalid"))?;
    if &parsed != expected {
        return Err(AppError::validation(
            "Session ID does not match the requested session",
        ));
    }
    Ok(())
}

fn validate_stored_session(
    session: &Value,
    expected: &SessionId,
    path: &Path,
) -> Result<(), AppError> {
    let matches_file_name = session
        .get("id")
        .and_then(Value::as_str)
        .and_then(|value| SessionId::parse(value).ok())
        .is_some_and(|stored| &stored == expected);
    if matches_file_name {
        Ok(())
    } else {
        Err(repository_error(
            "validate stored session ID",
            path,
            "document ID differs from its repository path",
        ))
    }
}

fn repository_error(
    operation: &'static str,
    path: &Path,
    source: impl std::fmt::Display,
) -> AppError {
    AppError::storage(
        "Session data could not be loaded or persisted",
        format!("{operation} at {}: {source}", path.display()),
        false,
    )
}

#[cfg(test)]
mod tests {
    use std::{path::Path, sync::Arc};

    use codez_core::SessionId;
    use serde_json::{Value, json};

    use super::SessionStore;
    use crate::{AtomicFileStore, AtomicWriteFaultInjector, AtomicWriteStage, InjectedWriteFault};

    struct FailBeforeCommit;

    impl AtomicWriteFaultInjector for FailBeforeCommit {
        fn check(&self, stage: AtomicWriteStage, _target: &Path) -> Result<(), InjectedWriteFault> {
            if stage == AtomicWriteStage::BeforeCommit {
                Err(InjectedWriteFault::at(stage))
            } else {
                Ok(())
            }
        }
    }

    fn session_id(value: &str) -> SessionId {
        SessionId::parse(value).expect("fixture session ID must be safe")
    }

    fn session(value: &str, summary: &str) -> Value {
        json!({ "id": value, "summary": summary, "messages": [] })
    }

    #[tokio::test]
    async fn save_places_session_directly_below_the_application_data_root() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let store = SessionStore::new(directory.path().to_path_buf(), AtomicFileStore::default());

        store
            .save(&session_id("session-1"), &session("session-1", "First"))
            .await
            .expect("session must persist");

        assert!(
            directory.path().join("sessions/session-1.json").is_file()
                && !directory.path().join("user-data").exists()
        );
    }

    #[tokio::test]
    async fn get_and_list_return_persisted_sessions() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let store = SessionStore::new(directory.path().to_path_buf(), AtomicFileStore::default());
        store
            .save(&session_id("session-1"), &session("session-1", "First"))
            .await
            .expect("first session must persist");
        store
            .save(&session_id("session-2"), &session("session-2", "Second"))
            .await
            .expect("second session must persist");

        let loaded = store
            .get(&session_id("session-1"))
            .await
            .expect("session must load");
        let listed = store.list().await.expect("sessions must list");

        assert_eq!(
            (
                loaded.and_then(|value| value["summary"].as_str().map(str::to_owned)),
                listed
            ),
            (
                Some("First".to_string()),
                vec![
                    session("session-2", "Second"),
                    session("session-1", "First")
                ]
            )
        );
    }

    #[tokio::test]
    async fn delete_removes_only_the_requested_session() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let store = SessionStore::new(directory.path().to_path_buf(), AtomicFileStore::default());
        store
            .save(&session_id("session-1"), &session("session-1", "First"))
            .await
            .expect("first session must persist");
        store
            .save(&session_id("session-2"), &session("session-2", "Second"))
            .await
            .expect("second session must persist");

        store
            .delete(&session_id("session-1"))
            .await
            .expect("session deletion must persist");

        assert_eq!(
            store.list().await.expect("remaining session must list"),
            vec![session("session-2", "Second")]
        );
    }

    #[tokio::test]
    async fn failed_atomic_save_preserves_the_previous_session_document() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let baseline =
            SessionStore::new(directory.path().to_path_buf(), AtomicFileStore::default());
        let id = session_id("session-1");
        baseline
            .save(&id, &session("session-1", "Before"))
            .await
            .expect("baseline session must persist");
        let failing_files =
            AtomicFileStore::with_fault_injector(1024 * 1024, Arc::new(FailBeforeCommit))
                .expect("fault-injected store must be valid");
        let failing = SessionStore::new(directory.path().to_path_buf(), failing_files);

        let result = failing.save(&id, &session("session-1", "After")).await;
        let loaded = baseline
            .get(&id)
            .await
            .expect("baseline session must remain readable");

        assert!(
            result.is_err()
                && loaded.as_ref().and_then(|value| value["summary"].as_str()) == Some("Before")
        );
    }
}
