use std::{
    path::{Path, PathBuf},
    sync::Arc,
};

use codez_contracts::{
    CommandError, EditorInfo, FileContent, FileTreeNode, FileTreeNodeType,
    GlobResult as GlobContract, GrepResult as GrepContract, ProjectInfo,
    ProjectSnapshotResult, WorkspaceInfo, WorkspacePathItem,
};
use codez_core::{AppError, FileSystem, RecentProject, RecentProjectRepository};
use codez_platform::NativeFileSystem;
use codez_runtime::{
    FileTreeNode as RuntimeFileTreeNode, GrepOptions, GrepOutputMode,
    ProjectAnalysisService, SnapshotOptions, WorkspaceEntryKind, WorkspaceService,
};
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

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_glob")
)]
pub async fn workspace_glob(
    root_path: String,
    pattern: String,
    path: Option<String>,
    head_limit: Option<usize>,
    state: State<'_, AppState>,
) -> Result<GlobContract, CommandError> {
    let result = async {
        let filesystem = open_filesystem(&root_path).await?;
        let search = create_search_service(&state)?;
        let result = search
            .glob_files(filesystem.as_ref(), &pattern, path.as_deref(), head_limit)
            .await?;
        Ok(GlobContract {
            paths: result.paths,
            truncated: result.truncated,
            total: result.total,
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_grep")
)]
pub async fn workspace_grep(
    root_path: String,
    pattern: String,
    path: Option<String>,
    output_mode: Option<String>,
    glob_filter: Option<String>,
    type_filter: Option<String>,
    case_insensitive: Option<bool>,
    multiline: Option<bool>,
    context_after: Option<u32>,
    context_before: Option<u32>,
    context_around: Option<u32>,
    line_numbers: Option<bool>,
    only_matching: Option<bool>,
    head_limit: Option<usize>,
    offset: Option<usize>,
    state: State<'_, AppState>,
) -> Result<GrepContract, CommandError> {
    let result = async {
        let search = create_search_service(&state)?;
        let mode = match output_mode.as_deref() {
            Some("content") => GrepOutputMode::Content,
            Some("count") => GrepOutputMode::Count,
            _ => GrepOutputMode::FilesWithMatches,
        };
        let options = GrepOptions {
            output_mode: mode,
            glob_filter,
            type_filter,
            case_insensitive: case_insensitive.unwrap_or(false),
            multiline: multiline.unwrap_or(false),
            context_after,
            context_before,
            context_around,
            line_numbers: line_numbers.unwrap_or(false),
            only_matching: only_matching.unwrap_or(false),
            head_limit,
            offset,
        };
        let ws_root = PathBuf::from(&root_path);
        let cancellation = codez_core::CancellationToken::new();
        let result = search
            .grep(&ws_root, &pattern, path.as_deref(), &options, cancellation)
            .await?;
        Ok(GrepContract {
            lines: result.lines,
            truncated: result.truncated,
        })
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_open_in_explorer")
)]
pub async fn workspace_open_in_explorer(
    root_path: String,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let result = async {
        let path = PathBuf::from(&root_path);
        if !path.is_absolute() {
            return Err(AppError::validation("Path must be absolute"));
        }
        opener::open(&path)
            .map(|()| true)
            .map_err(|source| AppError::external(
                "Failed to open path in file explorer",
                source.to_string(),
                false,
            ))
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_open_in_editor")
)]
pub async fn workspace_open_in_editor(
    root_path: String,
    editor_id: String,
    exe_path: Option<String>,
    state: State<'_, AppState>,
) -> Result<bool, CommandError> {
    let result = async {
        let command = if let Some(exe) = &exe_path {
            format!("\"{exe}\" \"{root_path}\"")
        } else {
            let cmd = editor_command_name(&editor_id);
            format!("{cmd} \"{root_path}\"")
        };

        let output = tokio::process::Command::new(shell_program())
            .args(shell_args(&command))
            .output()
            .await
            .map_err(|source| AppError::external(
                "Failed to open editor",
                source.to_string(),
                false,
            ))?;

        Ok(output.status.success())
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_detect_installed_editors")
)]
pub async fn workspace_detect_installed_editors(
    state: State<'_, AppState>,
) -> Result<Vec<EditorInfo>, CommandError> {
    let result = async {
        let editors = detect_editors().await;
        Ok(editors)
    }
    .await;
    command_result(&state.errors, result)
}

#[tauri::command(rename_all = "camelCase")]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_get_project_snapshot")
)]
pub async fn workspace_get_project_snapshot(
    root_path: String,
    dir_paths: Option<Vec<String>>,
    max_depth: Option<usize>,
    include_files: Option<bool>,
    state: State<'_, AppState>,
) -> Result<ProjectSnapshotResult, CommandError> {
    let result = async {
        let filesystem = open_filesystem(&root_path).await?;
        let options = SnapshotOptions {
            dir_paths,
            max_depth,
            include_files: include_files.unwrap_or(true),
        };
        let snapshot = ProjectAnalysisService::get_snapshot(filesystem.as_ref(), &options).await?;
        Ok(ProjectSnapshotResult {
            root_name: snapshot.root_name,
            project_type: snapshot.project_type,
            package_manager: snapshot.package_manager,
            scripts: snapshot.scripts,
            dependencies: snapshot.dependencies,
            dev_dependencies: snapshot.dev_dependencies,
            config_files: snapshot.config_files,
            entrypoints: snapshot.entrypoints,
            tree: snapshot.tree,
            docs_tree: snapshot.docs_tree,
        })
    }
    .await;
    command_result(&state.errors, result)
}

async fn open_filesystem(root_path: &str) -> Result<Arc<dyn FileSystem>, AppError> {
    if root_path.len() > 32_768 {
        return Err(AppError::validation("Workspace path is too long"));
    }
    let filesystem = NativeFileSystem::open(PathBuf::from(root_path))
        .await
        .map_err(AppError::from)?;
    Ok(Arc::new(filesystem))
}

async fn workspace_service(root_path: &str) -> Result<WorkspaceService, AppError> {
    let filesystem = open_filesystem(root_path).await?;
    Ok(WorkspaceService::new(filesystem))
}

fn create_search_service(
    state: &AppState,
) -> Result<codez_runtime::SearchService, AppError> {
    let rg_path = state.resources.ripgrep_executable();
    // ProcessRunner is not yet injected in AppState; use a stub that returns an error.
    // Phase 3.3 will add a real NativeProcessRunner to AppState.
    // For now, grep will return a validation error; glob works without it.
    codez_runtime::SearchService::new(rg_path, Arc::new(StubProcessRunner))
}

/// Stub process runner until Phase 3.3 provides NativeProcessRunner.
struct StubProcessRunner;

impl codez_core::ProcessRunner for StubProcessRunner {
    fn run<'a>(
        &'a self,
        _request: codez_core::ProcessRequest,
        _cancellation: codez_core::CancellationToken,
    ) -> codez_core::PortFuture<'a, codez_core::ProcessOutput> {
        Box::pin(async {
            Err(AppError::validation(
                "Process execution is not yet available (Phase 3.3)",
            ))
        })
    }
}

fn editor_command_name(editor_id: &str) -> &str {
    match editor_id {
        "VSCode" => "code",
        "Cursor" => "cursor",
        "IntelliJ IDEA" => "idea",
        "PyCharm" => "pycharm",
        "WebStorm" => "webstorm",
        "CLion" => "CLion",
        "Sublime Text" => "subl",
        "Android Studio" => "studio",
        "HBuilderX" => "hbuilderx",
        "Eclipse" => "eclipse",
        _ => "code",
    }
}

fn shell_program() -> &'static str {
    if cfg!(windows) { "cmd" } else { "sh" }
}

fn shell_args(command: &str) -> Vec<String> {
    if cfg!(windows) {
        vec!["/C".to_string(), command.to_string()]
    } else {
        vec!["-c".to_string(), command.to_string()]
    }
}

async fn detect_editors() -> Vec<EditorInfo> {
    let definitions = [
        ("VSCode", "code"),
        ("Cursor", "cursor"),
        ("IntelliJ IDEA", "idea"),
        ("PyCharm", "pycharm"),
        ("WebStorm", "webstorm"),
        ("Sublime Text", "subl"),
    ];

    let mut editors = Vec::new();
    for (id, cmd) in definitions {
        if let Some(exe_path) = find_command(cmd).await {
            editors.push(EditorInfo {
                id: id.to_string(),
                name: id.to_string(),
                exe_path: Some(exe_path),
                icon_data: None,
            });
        }
    }
    if editors.is_empty() {
        editors.push(EditorInfo {
            id: "VSCode".to_string(),
            name: "VSCode".to_string(),
            exe_path: None,
            icon_data: None,
        });
    }
    editors
}

async fn find_command(cmd: &str) -> Option<String> {
    let which_cmd = if cfg!(windows) { "where" } else { "which" };
    let output = tokio::process::Command::new(which_cmd)
        .arg(cmd)
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    stdout.lines().next().map(|line| line.trim().to_string())
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
