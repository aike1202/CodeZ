use codez_contracts::CommandError;
use codez_core::AppError;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::{error::command_result, state::AppState};

#[tauri::command]
#[tracing::instrument(
    name = "desktop.command",
    skip_all,
    fields(command = "workspace_open_directory")
)]
pub fn workspace_open_directory(
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

    Ok(Some(path.to_string_lossy().into_owned()))
}
