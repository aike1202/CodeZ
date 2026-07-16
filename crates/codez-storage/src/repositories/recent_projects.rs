use std::path::PathBuf;

use codez_core::{AppError, RecentProject, RecentProjectRepository, WorkspaceRoot};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::{AtomicFileStore, SchemaFamily, StorageError, VersionedDocument};

const RECENT_PROJECTS_FILE: &str = "recent-projects.json";
const MAX_RECENT_PROJECTS: usize = 10;

/// Versioned atomic repository for recently opened workspaces.
pub struct RecentProjectsStore {
    path: PathBuf,
    files: AtomicFileStore,
    mutations: Mutex<()>,
}

impl std::fmt::Debug for RecentProjectsStore {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("RecentProjectsStore")
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl RecentProjectsStore {
    #[must_use]
    pub fn new(data_directory: PathBuf, files: AtomicFileStore) -> Self {
        Self {
            path: data_directory.join(RECENT_PROJECTS_FILE),
            files,
            mutations: Mutex::new(()),
        }
    }

    async fn load(&self) -> Result<Vec<RecentProject>, AppError> {
        let document = match self
            .files
            .read_json::<VersionedDocument<RecentProjectsPayload>>(&self.path)
            .await
        {
            Ok(document) => document,
            Err(StorageError::CorruptJson { .. }) => return Ok(Vec::new()),
            Err(error) => return Err(error.into()),
        };
        let Some(document) = document else {
            return Ok(Vec::new());
        };
        document
            .validate_for(SchemaFamily::RecentProjects)
            .map_err(|source| repository_error("validate recent-project schema", source))?;
        document
            .into_payload()
            .projects
            .into_iter()
            .map(RecentProjectRecord::into_domain)
            .collect()
    }

    async fn save(&self, projects: &[RecentProject]) -> Result<(), AppError> {
        let payload = RecentProjectsPayload {
            projects: projects.iter().map(RecentProjectRecord::from).collect(),
        };
        self.files
            .write_json(
                &self.path,
                &VersionedDocument::new(SchemaFamily::RecentProjects, payload),
            )
            .await
            .map_err(Into::into)
    }
}

impl RecentProjectRepository for RecentProjectsStore {
    fn list(&self) -> codez_core::PortFuture<'_, Vec<RecentProject>> {
        Box::pin(async move { self.load().await })
    }

    fn upsert(&self, project: RecentProject) -> codez_core::PortFuture<'_, ()> {
        Box::pin(async move {
            let _guard = self.mutations.lock().await;
            let mut projects = self.load().await?;
            let root_key = project.root().identity_key();
            let project_id = project.id().to_string();
            projects.retain(|existing| {
                existing.root().identity_key() != root_key && existing.id() != project_id.as_str()
            });
            projects.insert(0, project);
            projects.truncate(MAX_RECENT_PROJECTS);
            self.save(&projects).await
        })
    }

    fn remove<'a>(&'a self, id: &'a str) -> codez_core::PortFuture<'a, ()> {
        Box::pin(async move {
            let _guard = self.mutations.lock().await;
            let mut projects = self.load().await?;
            projects.retain(|project| project.id() != id);
            self.save(&projects).await
        })
    }

    fn rename<'a>(&'a self, id: &'a str, new_name: &'a str) -> codez_core::PortFuture<'a, ()> {
        Box::pin(async move {
            let _guard = self.mutations.lock().await;
            let mut projects = self.load().await?;
            if let Some(project) = projects.iter_mut().find(|project| project.id() == id) {
                project
                    .rename(new_name.to_string())
                    .map_err(|source| AppError::validation(source.to_string()))?;
                self.save(&projects).await?;
            }
            Ok(())
        })
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentProjectsPayload {
    projects: Vec<RecentProjectRecord>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecentProjectRecord {
    id: String,
    root_path: PathBuf,
    name: String,
    project_type: String,
    opened_at: String,
}

impl From<&RecentProject> for RecentProjectRecord {
    fn from(project: &RecentProject) -> Self {
        Self {
            id: project.id().to_string(),
            root_path: project.root().as_path().to_path_buf(),
            name: project.name().to_string(),
            project_type: project.project_type().to_string(),
            opened_at: project.opened_at().to_string(),
        }
    }
}

impl RecentProjectRecord {
    fn into_domain(self) -> Result<RecentProject, AppError> {
        let root = WorkspaceRoot::from_canonical(self.root_path)
            .map_err(|source| invalid_record("workspace root", source))?;
        RecentProject::new(self.id, root, self.name, self.project_type, self.opened_at)
            .map_err(|source| invalid_record("bounded fields", source))
    }
}

fn repository_error(operation: &'static str, source: impl std::fmt::Display) -> AppError {
    AppError::storage(
        "Recent projects could not be loaded",
        format!("{operation}: {source}"),
        false,
    )
}

fn invalid_record(field: &'static str, source: impl std::fmt::Display) -> AppError {
    repository_error(
        "validate recent-project record",
        format!("{field}: {source}"),
    )
}

#[cfg(test)]
mod tests {
    use std::{fs, sync::Arc};

    use codez_core::{RecentProject, RecentProjectRepository, WorkspaceRoot};

    use super::RecentProjectsStore;
    use crate::AtomicFileStore;

    #[tokio::test]
    async fn repository_versions_deduplicates_and_bounds_recent_projects() {
        let directory = tempfile::tempdir().expect("temporary data root must be available");
        let store = Arc::new(RecentProjectsStore::new(
            directory.path().to_path_buf(),
            AtomicFileStore::default(),
        ));
        for index in 0..12 {
            let workspace = directory.path().join(format!("workspace-{index}"));
            fs::create_dir(&workspace).expect("fixture workspace must be created");
            let root = WorkspaceRoot::from_canonical(
                fs::canonicalize(workspace).expect("fixture workspace must canonicalize"),
            )
            .expect("fixture canonical root must be valid");
            store
                .upsert(
                    RecentProject::new(
                        format!("project-{index}"),
                        root,
                        format!("Project {index}"),
                        "rust".to_string(),
                        "2026-07-16T00:00:00Z".to_string(),
                    )
                    .expect("fixture recent project must be valid"),
                )
                .await
                .expect("fixture project must persist");
        }
        let reopened_root = WorkspaceRoot::from_canonical(
            fs::canonicalize(directory.path().join("workspace-11"))
                .expect("reopened workspace must canonicalize"),
        )
        .expect("reopened canonical root must be valid");
        store
            .upsert(
                RecentProject::new(
                    "project-reopened".to_string(),
                    reopened_root,
                    "Reopened".to_string(),
                    "rust".to_string(),
                    "2026-07-16T01:00:00Z".to_string(),
                )
                .expect("reopened recent project must be valid"),
            )
            .await
            .expect("same-root project must replace its prior record");
        let projects = store.list().await.expect("recent projects must load");
        store
            .rename("project-reopened", "Renamed")
            .await
            .expect("recent project rename must persist");
        let document: serde_json::Value = serde_json::from_slice(
            &fs::read(directory.path().join("recent-projects.json"))
                .expect("versioned recent-project file must exist"),
        )
        .expect("recent-project file must be JSON");

        assert_eq!(projects.len(), 10);
        assert_eq!(projects[0].id(), "project-reopened");
        assert!(projects.iter().all(|project| project.id() != "project-11"));
        assert_eq!(document["schema"], "recent-projects");
        assert_eq!(document["schemaVersion"], 1);
        assert_eq!(
            store.list().await.expect("renamed projects must load")[0].name(),
            "Renamed"
        );
    }
}
