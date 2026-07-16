use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_contracts::{
    CommandError, FileContent, FileTreeNode, FileTreeNodeType, ProjectInfo, WorkspaceInfo,
    WorkspacePathItem,
};
use codez_core::{AppError, FileSystem, RecentProject, RecentProjectRepository};
use codez_platform::NativeFileSystem;
use codez_runtime::{FileTreeNode as RuntimeFileTreeNode, WorkspaceEntryKind, WorkspaceService};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::{error::command_result, state::AppState};

#[tauri::command]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_open_directory")
)]
pub async fn workspace_open_directory(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Option<String>, CommandError> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = command_result(
        &state.errors,
        selected
            .into_path()
            .map_err(|_| AppError::validation("Selected directory is not a local path")),
    )?;
    let filesystem = command_result(
        &state.errors,
        NativeFileSystem::open(path).await.map_err(AppError::from),
    )?;

    Ok(Some(
        filesystem.root().as_path().to_string_lossy().into_owned(),
    ))
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_scan_file_tree")
)]
pub async fn workspace_scan_file_tree(
    root_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<FileTreeNode>, CommandError> {
    let result = async {
        let service = workspace_service(&root_path).await?;
        service
            .scan_file_tree()
            .await
            .map(|nodes| nodes.into_iter().map(file_tree_contract).collect())
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_get_all_paths")
)]
pub async fn workspace_get_all_paths(
    root_path: String,
    state: State<'_, AppState>,
) -> Result<Vec<WorkspacePathItem>, CommandError> {
    let result = async {
        let service = workspace_service(&root_path).await?;
        service.all_paths().await.map(|paths| {
            paths
                .into_iter()
                .map(|path| WorkspacePathItem {
                    name: path.name,
                    path: path.path,
                    is_dir: path.is_directory,
                })
                .collect()
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_read_file")
)]
pub async fn workspace_read_file(
    file_path: String,
    root_path: String,
    state: State<'_, AppState>,
) -> Result<FileContent, CommandError> {
    let result = async {
        let service = workspace_service(&root_path).await?;
        service
            .read_preview(Path::new(&file_path))
            .await
            .map(|preview| FileContent {
                path: preview.path,
                content: preview.content,
                truncated: preview.truncated,
                total_lines: preview.total_lines,
            })
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_detect_project")
)]
pub async fn workspace_detect_project(
    root_path: String,
    state: State<'_, AppState>,
) -> Result<ProjectInfo, CommandError> {
    let result = async {
        let service = workspace_service(&root_path).await?;
        service.detect_project().await.map(|project| ProjectInfo {
            project_type: project.project_type,
            framework: project.framework,
            package_manager: project.package_manager,
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_get_recent_projects")
)]
pub async fn workspace_get_recent_projects(
    state: State<'_, AppState>,
) -> Result<Vec<WorkspaceInfo>, CommandError> {
    let result = state.recent_projects.list().await.map(|projects| {
        projects
            .into_iter()
            .map(|project| WorkspaceInfo {
                id: project.id().to_string(),
                root_path: project.root().as_path().to_string_lossy().into_owned(),
                name: project.name().to_string(),
                project_type: project.project_type().to_string(),
                opened_at: project.opened_at().to_string(),
            })
            .collect()
    });
    command_result(&state.errors, result)
}

#[tauri::command]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_add_recent_project")
)]
pub async fn workspace_add_recent_project(
    project: WorkspaceInfo,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    let result = async {
        let filesystem = NativeFileSystem::open(PathBuf::from(&project.root_path))
            .await
            .map_err(AppError::from)?;
        let project = RecentProject::new(
            project.id,
            filesystem.root().clone(),
            project.name,
            project.project_type,
            project.opened_at,
        )
        .map_err(|source| AppError::validation(source.to_string()))?;
        state.recent_projects.upsert(project).await
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_remove_recent_project")
)]
pub async fn workspace_remove_recent_project(
    id: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    command_result(&state.errors, state.recent_projects.remove(&id).await)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_rename_recent_project")
)]
pub async fn workspace_rename_recent_project(
    id: String,
    new_name: String,
    state: State<'_, AppState>,
) -> Result<(), CommandError> {
    command_result(
        &state.errors,
        state.recent_projects.rename(&id, &new_name).await,
    )
}

async fn workspace_service(root_path: &str) -> Result<WorkspaceService, AppError> {
    if root_path.len() > 32_768 {
        return Err(AppError::validation("Workspace path is too long"));
    }
    let filesystem = NativeFileSystem::open(PathBuf::from(root_path))
        .await
        .map_err(AppError::from)?;
    let filesystem: Arc<dyn FileSystem> = Arc::new(filesystem);
    Ok(WorkspaceService::new(filesystem))
}

fn file_tree_contract(node: RuntimeFileTreeNode) -> FileTreeNode {
    let is_directory = node.kind == WorkspaceEntryKind::Directory;
    FileTreeNode {
        name: node.name,
        path: node.path,
        kind: if is_directory {
            FileTreeNodeType::Directory
        } else {
            FileTreeNodeType::File
        },
        children: is_directory.then(|| node.children.into_iter().map(file_tree_contract).collect()),
        size: node.size,
        extension: node.extension,
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, path::Path, sync::Arc};

    use codez_core::FileSystem;
    use codez_platform::NativeFileSystem;
    use codez_runtime::{WorkspaceEntryKind, WorkspaceService};

    #[tokio::test]
    async fn native_workspace_service_recurses_ignores_and_detects_specific_projects() {
        let directory = tempfile::tempdir().expect("temporary workspace must be available");
        fs::create_dir_all(directory.path().join("src/nested"))
            .expect("nested source fixture must be created");
        fs::create_dir(directory.path().join("node_modules"))
            .expect("ignored fixture must be created");
        fs::write(directory.path().join("package.json"), "{}")
            .expect("package fixture must be written");
        fs::write(directory.path().join("vite.config.ts"), "export default {}")
            .expect("Vite fixture must be written");
        fs::write(
            directory.path().join("pnpm-lock.yaml"),
            "lockfileVersion: 9",
        )
        .expect("package-manager fixture must be written");
        fs::write(
            directory.path().join("src/nested/app.ts"),
            "export const value = 1\n",
        )
        .expect("source fixture must be written");
        fs::write(directory.path().join("src/invalid.txt"), [0xff, 0xfe])
            .expect("invalid UTF-8 fixture must be written");
        let native = NativeFileSystem::open(directory.path().to_path_buf())
            .await
            .expect("fixture workspace must open");
        let filesystem: Arc<dyn FileSystem> = Arc::new(native);
        let service = WorkspaceService::new(filesystem);

        let tree = service
            .scan_file_tree()
            .await
            .expect("recursive workspace tree must load");
        let project = service
            .detect_project()
            .await
            .expect("project type must be detected");
        let preview = service
            .read_preview(Path::new("src/nested/app.ts"))
            .await
            .expect("workspace file preview must load");
        let invalid_preview = service
            .read_preview(Path::new("src/invalid.txt"))
            .await
            .expect("unsupported encoding must produce a bounded preview result");

        assert!(tree.iter().all(|node| node.name != "node_modules"));
        let src = tree
            .iter()
            .find(|node| node.name == "src")
            .expect("source directory must be present");
        assert_eq!(src.kind, WorkspaceEntryKind::Directory);
        assert!(
            src.children[0]
                .children
                .iter()
                .any(|node| node.name == "app.ts")
        );
        assert_eq!(project.framework.as_deref(), Some("vite"));
        assert_eq!(project.package_manager.as_deref(), Some("pnpm"));
        assert!(preview.content.contains("export const value"));
        assert!(invalid_preview.content.contains("unsupported encoding"));
    }
}
