use codez_contracts::{CommandError, WindowAction};
use tauri::WebviewWindow;
use tauri_plugin_opener::OpenerExt;
use url::Url;

fn host_error(operation: &str) -> CommandError {
    CommandError::internal(format!("Host operation failed: {operation}"))
}

fn validate_external_url(target: &str) -> Result<Url, CommandError> {
    let url = Url::parse(target).map_err(|_| CommandError::validation("Invalid external URL"))?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(CommandError::validation(
            "Only HTTP and HTTPS external URLs are allowed",
        ));
    }
    Ok(url)
}

#[tauri::command]
pub fn window_control(window: WebviewWindow, action: WindowAction) -> Result<(), CommandError> {
    match action {
        WindowAction::Minimize => window.minimize().map_err(|_| host_error("minimize")),
        WindowAction::ToggleMaximize => {
            let is_maximized = window
                .is_maximized()
                .map_err(|_| host_error("read maximize state"))?;
            if is_maximized {
                window.unmaximize().map_err(|_| host_error("unmaximize"))
            } else {
                window.maximize().map_err(|_| host_error("maximize"))
            }
        }
        WindowAction::Close => window.close().map_err(|_| host_error("close")),
    }
}

#[tauri::command]
pub fn open_external(app: tauri::AppHandle, target: String) -> Result<(), CommandError> {
    let url = validate_external_url(&target)?;

    app.opener()
        .open_url(url.as_str(), None::<&str>)
        .map_err(|_| host_error("open external URL"))
}

#[cfg(test)]
mod tests {
    use codez_contracts::ErrorCode;

    use super::validate_external_url;

    #[test]
    fn non_http_urls_are_rejected_before_opening() {
        let error = validate_external_url("file:///C:/Users/example/secret.txt")
            .expect_err("file URLs must not cross the WebView boundary");

        assert_eq!(error.code, ErrorCode::Validation);
    }

    #[test]
    fn https_urls_are_allowed() {
        let url = validate_external_url("https://example.com/docs")
            .expect("HTTPS is an allowed external scheme");

        assert_eq!(url.scheme(), "https");
    }
}
