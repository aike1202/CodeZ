#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]
#![forbid(unsafe_code)]

fn main() -> std::process::ExitCode {
    match codez_desktop_lib::run() {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("CodeZ failed to start. See the diagnostic log for details.");
            std::process::ExitCode::FAILURE
        }
    }
}
