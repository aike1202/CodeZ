use codez_contracts::{
    CONTRACT_VERSION, CommandError, DesktopEvent, THEME_CHANGED_EVENT, ThemeInfo, ThemeSource,
};
use codez_core::{AppError, HostThemeSource};
use tauri::{Emitter, Manager, State, Theme, Window};

use crate::{error::command_result, state::AppState};

fn host_error(operation: &str, source: impl std::fmt::Display) -> AppError {
    AppError::external(
        "The theme operation failed",
        format!("{operation}: {source}"),
        false,
    )
}

fn to_contract_source(source: HostThemeSource) -> ThemeSource {
    match source {
        HostThemeSource::System => ThemeSource::System,
        HostThemeSource::Light => ThemeSource::Light,
        HostThemeSource::Dark => ThemeSource::Dark,
    }
}

fn to_host_source(source: ThemeSource) -> HostThemeSource {
    match source {
        ThemeSource::System => HostThemeSource::System,
        ThemeSource::Light => HostThemeSource::Light,
        ThemeSource::Dark => HostThemeSource::Dark,
    }
}

fn window_theme(source: ThemeSource) -> Option<Theme> {
    match source {
        ThemeSource::System => None,
        ThemeSource::Light => Some(Theme::Light),
        ThemeSource::Dark => Some(Theme::Dark),
    }
}

fn read_theme_info(window: &Window, state: &AppState) -> Result<ThemeInfo, AppError> {
    let effective = window
        .theme()
        .map_err(|source| host_error("read theme", source))?;
    Ok(ThemeInfo {
        should_use_dark_colors: effective == Theme::Dark,
        theme_source: to_contract_source(state.host_preferences.theme_source()),
    })
}

pub(crate) fn emit_theme_changed(window: &Window) {
    let state = window.state::<AppState>();
    let payload = match read_theme_info(window, &state) {
        Ok(payload) => payload,
        Err(error) => {
            state.errors.log(&error);
            return;
        }
    };
    let event = DesktopEvent {
        version: CONTRACT_VERSION,
        stream_id: None,
        sequence: None,
        kind: "themeChanged".to_string(),
        payload,
    };
    if let Err(source) = window.emit(THEME_CHANGED_EVENT, event) {
        state.errors.log(&host_error("emit theme event", source));
    }
}

#[tauri::command]
pub fn theme_get(window: Window, state: State<'_, AppState>) -> Result<ThemeInfo, CommandError> {
    command_result(&state.errors, read_theme_info(&window, &state))
}

#[tauri::command]
pub fn theme_set(
    window: Window,
    state: State<'_, AppState>,
    source: ThemeSource,
) -> Result<ThemeInfo, CommandError> {
    let result = (|| {
        window
            .set_theme(window_theme(source))
            .map_err(|error| host_error("set theme", error))?;
        state
            .host_preferences
            .set_theme_source(to_host_source(source));
        let info = read_theme_info(&window, &state)?;
        emit_theme_changed(&window);
        Ok(info)
    })();
    command_result(&state.errors, result)
}

#[cfg(test)]
mod tests {
    use codez_contracts::ThemeSource;
    use codez_core::HostThemeSource;

    use super::{to_contract_source, to_host_source};

    #[test]
    fn theme_sources_map_without_losing_system_mode() {
        assert_eq!(
            to_contract_source(HostThemeSource::System),
            ThemeSource::System
        );
        assert_eq!(to_host_source(ThemeSource::Dark), HostThemeSource::Dark);
    }
}
