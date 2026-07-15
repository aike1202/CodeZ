use codez_contracts::CommandError;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub fn workspace_open_directory(app: AppHandle) -> Result<Option<String>, CommandError> {
    let selected = app.dialog().file().blocking_pick_folder();
    let Some(selected) = selected else {
        return Ok(None);
    };
    let path = selected
        .into_path()
        .map_err(|_| CommandError::validation("Selected directory is not a local path"))?;

    Ok(Some(path.to_string_lossy().into_owned()))
}
