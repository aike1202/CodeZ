#![forbid(unsafe_code)]

mod agent_runtime;
mod attachment_boundary;
mod chat_compaction;
mod chat_interaction;
mod chat_runtime;
mod chat_tool_runtime;
mod commands;
mod composition;
mod context_boundary;
mod error;
mod git_boundary;
mod lifecycle;
mod logging;
mod mcp_boundary;
mod mcp_interaction;
mod mcp_runtime;
mod notification_tool_runtime;
mod permission_ai_classifier;
mod provider_boundary;
mod session_deletion;
mod skill_document;
mod skill_tool_runtime;
mod state;
mod subagent_boundary;
mod subagent_runtime;
mod web_tool_runtime;

use codez_core::{AppError, RedactedText};
use tauri::{Emitter, Manager, WebviewWindow};
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
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            commands::system::system_health,
            commands::system::system_probe_channel,
            commands::renderer_log::renderer_log,
            commands::host::window_control,
            commands::host::open_external,
            commands::workspace::workspace_open_directory,
            commands::workspace::workspace_scan_file_tree,
            commands::terminal::terminal_start,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_ack,
            commands::terminal::terminal_kill,
            commands::provider::provider_get_all,
            commands::provider::provider_create,
            commands::provider::provider_update,
            commands::provider::provider_delete,
            commands::provider::provider_set_active,
            commands::context::ledger_append_event,
            commands::context::ledger_get_snapshot,
            commands::provider::provider_test_connection,
            commands::workspace::workspace_get_all_paths,
            commands::workspace::workspace_read_file,
            commands::workspace::workspace_detect_project,
            commands::workspace::workspace_get_recent_projects,
            commands::workspace::workspace_add_recent_project,
            commands::workspace::workspace_remove_recent_project,
            commands::workspace::workspace_rename_recent_project,
            commands::workspace::workspace_glob,
            commands::workspace::workspace_grep,
            commands::workspace::workspace_open_in_explorer,
            commands::workspace::workspace_open_in_editor,
            commands::workspace::workspace_detect_installed_editors,
            commands::workspace::workspace_get_project_snapshot,
            commands::git::workspace_get_git_snapshot,
            commands::git::workspace_create_worktree,
            commands::git::workspace_remove_worktree,
            commands::git::workspace_list_worktrees,
            commands::attachment::attachment_import_draft,
            commands::attachment::attachment_promote_drafts,
            commands::attachment::attachment_rollback_promotion,
            commands::attachment::attachment_discard_drafts,
            commands::attachment::attachment_read_preview,
            commands::theme::theme_get,
            commands::theme::theme_set,
            commands::permission::permission_mode_get,
            commands::permission::permission_mode_set,
            commands::settings::settings_get,
            commands::settings::settings_save,
            commands::settings::session_list,
            commands::settings::session_get,
            commands::settings::session_save,
            commands::settings::session_delete,
            commands::todo::todo_list,
            commands::todo::todo_get,
            commands::todo::todo_create,
            commands::todo::todo_update,
            commands::todo::todo_delete,
            commands::agent::agent_snapshot,
            commands::agent::agent_active_ids,
            commands::rules::rules_get_list,
            commands::rules::rules_save,
            commands::rules::rules_delete,
            commands::rules::rules_rename,
            commands::skills::skill_get_all,
            commands::skills::skill_toggle,
            commands::skills::skill_check_external,
            commands::skills::skill_import_external,
            commands::skills::skill_list_external,
            commands::skills::skill_import_single,
            commands::skills::skill_remove,
            commands::mcp::mcp_list,
            commands::mcp::mcp_save_user,
            commands::mcp::mcp_set_enabled,
            commands::mcp::mcp_get_catalog,
            commands::mcp::mcp_read_resource,
            commands::mcp::mcp_subscribe_resource,
            commands::mcp::mcp_unsubscribe_resource,
            commands::mcp::mcp_get_prompt,
            commands::mcp::mcp_reconnect,
            commands::mcp::mcp_authorize,
            commands::mcp::mcp_logout,
            commands::mcp::mcp_respond_reverse_request,
            commands::mcp::mcp_trust_project,
            commands::mcp::mcp_list_secret_keys,
            commands::mcp::mcp_set_secret,
            commands::mcp::mcp_delete_secret,
            commands::subagent::subagent_list,
            commands::subagent::subagent_toggle,
            commands::subagent::subagent_get_detail,
            commands::subagent::subagent_set_model,
            commands::subagent::subagent_run,
            commands::subagent::subagent_get_run,
            commands::subagent::subagent_cancel_run,
            commands::chat::chat_predict_next_input,
            commands::chat::chat_stream_start,
            commands::chat::chat_stream_ack,
            commands::chat::chat_stream_stop,
            commands::chat::chat_get_runtime_status,
            commands::chat::chat_steer,
            commands::chat::chat_interrupt_tool,
            commands::chat::chat_compact,
            commands::chat::chat_accept_file,
            commands::chat::chat_reject_file,
            commands::chat::chat_get_diff,
            commands::chat::chat_preview_history_revert,
            commands::chat::chat_revert_history,
            commands::chat::chat_respond_to_approval,
            commands::chat::chat_respond_ask_user,
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::ThemeChanged(_)) {
                commands::theme::emit_theme_changed(window);
            }
        })
        .setup(|app| {
            let (pty_tx, mut pty_rx) = tokio::sync::mpsc::channel(
                codez_platform::pty::PTY_EVENT_QUEUE_CAPACITY,
            );

            let state = composition::compose_app_state(app, pty_tx)?;
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                #[derive(serde::Serialize, Clone)]
                struct OutputPayload {
                    id: String,
                    sequence: u64,
                    data: Vec<u8>,
                }

                #[derive(serde::Serialize, Clone)]
                struct ExitPayload {
                    id: String,
                    exit_code: Option<u32>,
                }

                while let Some(event) = pty_rx.recv().await {
                    match event {
                        codez_platform::pty::PtyEvent::Output { id, sequence, data } => {
                            if let Err(source) = handle.emit(
                                "terminal:output",
                                OutputPayload { id, sequence, data },
                            ) {
                                tracing::warn!(diagnostic = %source, "terminal output event could not be emitted");
                            }
                        }
                        codez_platform::pty::PtyEvent::Exit { id, exit_code } => {
                            if let Err(source) = handle.emit(
                                "terminal:exit",
                                ExitPayload { id, exit_code },
                            ) {
                                tracing::warn!(diagnostic = %source, "terminal exit event could not be emitted");
                            }
                        }
                    }
                }
            });

            lifecycle::register_shutdown_hooks(
                app.handle(),
                &state.shutdown,
                &state.cancellation,
                &state.agent_runtime,
                &state.process_runner,
                &state.pty_manager,
                &state.mcp_runtime,
            )?;
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
            let app_handle = app.handle().clone();
            let state = app.state::<state::AppState>();
            let mcp_config = std::sync::Arc::clone(&state.mcp_config);
            let mcp_runtime = std::sync::Arc::clone(&state.mcp_runtime);
            let errors = std::sync::Arc::clone(&state.errors);
            tauri::async_runtime::spawn(async move {
                match mcp_config.list().await {
                    Ok(servers) => {
                        let statuses = mcp_runtime.reconcile(&servers).await;
                        if let Err(source) = app_handle.emit("mcp:status-changed", statuses) {
                            errors.log(&AppError::external(
                                "MCP status updates could not be delivered to the interface",
                                format!("emit initial MCP status update: {source}"),
                                false,
                            ));
                        }
                    }
                    Err(error) => errors.log(&AppError::from(error)),
                }
            });
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
                let shortcut_error = AppError::external(
                    "The global shortcut is unavailable",
                    format!("register global shortcut: {error}"),
                    false,
                );
                if let Some(state) = app.try_state::<state::AppState>() {
                    state.errors.log(&shortcut_error);
                } else {
                    tracing::error!("global shortcut initialization failed before state registration");
                }
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
