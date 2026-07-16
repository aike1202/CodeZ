use serde::Serialize;
use tauri::{AppHandle, State};

#[derive(Serialize, Clone)]
struct OutputPayload {
    id: String,
    data: String,
}

#[derive(Serialize, Clone)]
struct ExitPayload {
    id: String,
}

#[tauri::command]
pub async fn terminal_start(
    app: AppHandle,
    state: State<'_, crate::state::AppState>,
    workspace_id: String,
    root_path: String,
) -> Result<(), String> {
    let pty_manager = state.pty_manager.clone();
    
    // Windows only: use powershell with utf8. 
    // Wait, need cross platform support for bash later, but for now match legacy
    let is_windows = cfg!(windows);
    let program = if is_windows { "powershell.exe" } else { "bash" };
    let args = if is_windows {
        vec!["-NoExit", "-Command", "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"]
    } else {
        vec![]
    };
    
    pty_manager.start(workspace_id, program, &args, &root_path).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_write(
    state: State<'_, crate::state::AppState>,
    workspace_id: String,
    text: String,
) -> Result<(), String> {
    state.pty_manager.write(&workspace_id, text.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_resize(
    state: State<'_, crate::state::AppState>,
    workspace_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    state.pty_manager.resize(&workspace_id, cols, rows).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn terminal_kill(
    state: State<'_, crate::state::AppState>,
    workspace_id: String,
) -> Result<(), String> {
    state.pty_manager.kill(&workspace_id).map_err(|e| e.to_string())
}
