use std::sync::Arc;

use codez_core::AppError;
use codez_runtime::{
    ShutdownCoordinator, ShutdownFuture, ShutdownHook, ShutdownPhase, ShutdownReport,
};
use tauri::{AppHandle, Manager, RunEvent};
use tauri_plugin_global_shortcut::GlobalShortcutExt;

use crate::{error::ErrorReporter, state::AppState};

pub(crate) fn register_shutdown_hooks(
    app_handle: &AppHandle,
    shutdown: &ShutdownCoordinator,
) -> Result<(), AppError> {
    shutdown.register(Arc::new(GlobalShortcutShutdown {
        app_handle: app_handle.clone(),
    }))
}

pub(crate) fn handle_run_event(app_handle: &AppHandle, event: RunEvent) {
    let RunEvent::ExitRequested { code, api, .. } = event else {
        return;
    };
    let state = app_handle.state::<AppState>();
    if state.shutdown.is_complete() {
        return;
    }

    api.prevent_exit();
    if !state.shutdown.begin_shutdown() {
        return;
    }

    let shutdown = Arc::clone(&state.shutdown);
    let errors = Arc::clone(&state.errors);
    let app_handle = app_handle.clone();
    let exit_code = code.unwrap_or_default();
    tauri::async_runtime::spawn(async move {
        let report = shutdown.execute().await;
        log_shutdown_report(&errors, report);
        app_handle.exit(exit_code);
    });
}

struct GlobalShortcutShutdown {
    app_handle: AppHandle,
}

impl ShutdownHook for GlobalShortcutShutdown {
    fn name(&self) -> &'static str {
        "global-shortcuts"
    }

    fn run(&self, phase: ShutdownPhase) -> ShutdownFuture<'_> {
        Box::pin(async move {
            if phase != ShutdownPhase::StopAccepting {
                return Ok(());
            }

            self.app_handle
                .global_shortcut()
                .unregister_all()
                .map_err(|source| {
                    AppError::external(
                        "The global shortcuts could not be released",
                        format!("unregister global shortcuts during shutdown: {source}"),
                        false,
                    )
                })
        })
    }
}

fn log_shutdown_report(reporter: &ErrorReporter, report: ShutdownReport) {
    for failure in report.failures {
        tracing::warn!(
            hook = failure.hook,
            phase = ?failure.phase,
            "shutdown hook reported a failure"
        );
        reporter.log(&failure.error);
    }
    for phase in report.timed_out_phases {
        reporter.log(&AppError::timeout(format!(
            "Shutdown phase {phase:?} exceeded its deadline"
        )));
    }
}
