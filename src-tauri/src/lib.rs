#![forbid(unsafe_code)]

mod commands;
mod state;

use tauri::{Manager, WebviewWindow};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

fn toggle_window_visibility(window: &WebviewWindow) {
    let is_visible = window.is_visible().unwrap_or(false);
    let is_focused = window.is_focused().unwrap_or(false);

    if is_visible && is_focused {
        let _ = window.hide();
    } else {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

pub fn run() {
    let builder = tauri::Builder::default()
        .manage(state::AppState::new())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
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
                eprintln!("CodeZ global shortcut is unavailable: {error}");
            }
            Ok(())
        });

    let app = builder
        .build(tauri::generate_context!())
        .expect("failed to build the CodeZ Tauri application");
    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
            let state = app_handle.state::<state::AppState>();
            let _ = state.shutdown.begin_shutdown();
        }
    });
}
