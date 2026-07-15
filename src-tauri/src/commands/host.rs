use codez_contracts::{CommandError, WindowAction};
use codez_core::AppError;
use tauri::{State, WebviewWindow};
use tauri_plugin_opener::OpenerExt;
use url::Url;

use crate::{error::command_result, state::AppState};

fn host_error(operation: &str, source: impl std::fmt::Display) -> AppError {
    AppError::external(
        "The desktop operation failed",
        format!("{operation}: {source}"),
        false,
    )
}

fn validate_external_url(target: &str) -> Result<Url, AppError> {
    let url = Url::parse(target).map_err(|_| AppError::validation("Invalid external URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AppError::validation(
            "Only HTTP and HTTPS external URLs are allowed",
        ));
    }
    Ok(url)
}

#[tauri::command]
pub fn window_control(
    window: WebviewWindow,
    state: State<'_, AppState>,
    action: WindowAction,
) -> Result<(), CommandError> {
    let result = (|| match action {
        WindowAction::Minimize => window
            .minimize()
            .map_err(|source| host_error("minimize", source)),
        WindowAction::ToggleMaximize => {
            let is_maximized = window
                .is_maximized()
                .map_err(|source| host_error("read maximize state", source))?;
            if is_maximized {
                window
                    .unmaximize()
                    .map_err(|source| host_error("unmaximize", source))
            } else {
                window
                    .maximize()
                    .map_err(|source| host_error("maximize", source))
            }
        }
        WindowAction::Close => window.close().map_err(|source| host_error("close", source)),
    })();
    command_result(&state.errors, result)
}

#[tauri::command]
pub fn open_external(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    target: String,
) -> Result<(), CommandError> {
    let result = (|| {
        let url = validate_external_url(&target)?;

        app.opener()
            .open_url(url.as_str(), None::<&str>)
            .map_err(|source| host_error("open external URL", source))
    })();
    command_result(&state.errors, result)
}

#[cfg(test)]
mod tests {
    use codez_core::AppErrorKind;

    use super::validate_external_url;

    #[test]
    fn non_http_urls_are_rejected_before_opening() {
        let error = validate_external_url("file:///C:/Users/example/secret.txt")
            .expect_err("file URLs must not cross the WebView boundary");

        assert_eq!(error.kind(), AppErrorKind::Validation);
    }

    #[test]
    fn https_urls_are_allowed() {
        let url = validate_external_url("https://example.com/docs")
            .expect("HTTPS is an allowed external scheme");

        assert_eq!(url.scheme(), "https");
    }
}
