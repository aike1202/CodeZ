#![forbid(unsafe_code)]

mod commands;
mod composition;
mod error;
mod lifecycle;
mod logging;
mod state;

use codez_core::{AppError, RedactedText};
use tauri::{Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn log_window_error(window: &WebviewWindow, operation: &str, source: impl std::fmt::Display) {
    let error = AppError::external(
        "The desktop window operation failed",
        format!("{operation}: {source}"),
        false,
    );
    if let Some(state) = window.try_state::<state::AppState>() {
        state.errors.log(&error);
    } else {
        tracing::error!(
            error_code = error.kind().as_str(),
            diagnostic = %error.diagnostic().unwrap_or("window operation failed"),
            "desktop operation failed before application state initialization"
        );
    }
}

fn toggle_window_visibility(window: &WebviewWindow) {
    let is_visible = match window.is_visible() {
        Ok(is_visible) => is_visible,
        Err(source) => {
            log_window_error(window, "read visibility", source);
            return;
        }
    };
    let is_focused = match window.is_focused() {
        Ok(is_focused) => is_focused,
        Err(source) => {
            log_window_error(window, "read focus", source);
            return;
        }
    };

    if is_visible && is_focused {
        if let Err(source) = window.hide() {
            log_window_error(window, "hide", source);
        }
    } else {
        if let Err(source) = window.show() {
            log_window_error(window, "show", source);
            return;
        }
        if let Err(source) = window.set_focus() {
            log_window_error(window, "focus", source);
        }
    }
}

/// Builds and runs the Tauri desktop host.
///
/// # Errors
///
/// Returns a Tauri startup error when the application cannot be built.
pub fn run() -> Result<(), tauri::Error> {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                if let Err(source) = window.unminimize() {
                    log_window_error(&window, "restore second instance", source);
                }
                if let Err(source) = window.show() {
                    log_window_error(&window, "show second instance", source);
                }
                if let Err(source) = window.set_focus() {
                    log_window_error(&window, "focus second instance", source);
                }
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::system::system_health,
            commands::system::system_probe_channel,
            commands::host::window_control,
            commands::host::open_external,
            commands::workspace::workspace_open_directory,
            commands::theme::theme_get,
            commands::theme::theme_set,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
                commands::theme::emit_theme_changed(window);
            }
        })
        .setup(|app| {
            let state = composition::compose_app_state(app)?;
            lifecycle::register_shutdown_hooks(app.handle(), &state.shutdown)?;
            tracing::debug!(
                data_path_ready = state.paths.data_directory().is_absolute(),
                max_document_bytes = state.storage.max_document_bytes(),
                credential_service = state.credentials.service_name(),
                "storage composition initialized"
            );
            if let Err(error) = state.resources.validate_required() {
                state.errors.log(&AppError::internal(format!(
                    "bundled resource validation: {error}"
                )));
            }
            if !app.manage(state) {
                return Err("CodeZ application state was already initialized".into());
            }
            let shortcut_result = app.global_shortcut().on_shortcut(
                "CommandOrControl+Shift+Space",
                |app, _shortcut, event| {
                    if event.state == ShortcutState::Pressed
                        && let Some(window) = app.get_webview_window("main")
                    {
                        toggle_window_visibility(&window);
                    }
                },
            );
            if let Err(error) = shortcut_result {
                app.state::<state::AppState>()
                    .errors
                    .log(&AppError::external(
                        "The global shortcut is unavailable",
                        format!("register global shortcut: {error}"),
                        false,
                    ));
            }
            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .inspect_err(|error| {
            let diagnostic = RedactedText::new(error.to_string());
            tracing::error!(
                %diagnostic,
                "failed to build the CodeZ Tauri application"
            );
        })?;
    app.run(lifecycle::handle_run_event);
    Ok(())
}
