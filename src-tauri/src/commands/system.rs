use codez_contracts::{
    CONTRACT_VERSION, CommandError, DesktopEvent, HealthResponse, SystemProbeEvent,
};
use codez_core::AppError;
use tauri::{State, ipc::Channel};

use crate::{error::command_result, state::AppState};

#[tauri::command]
pub fn system_health(state: State<'_, AppState>) -> Result<HealthResponse, CommandError> {
    let health = state.system.health();

    Ok(HealthResponse {
        contract_version: CONTRACT_VERSION,
        backend_version: health.backend_version,
        uptime_ms: health.uptime_ms,
    })
}

#[tauri::command]
pub fn system_probe_channel(
    state: State<'_, AppState>,
    events: Channel<DesktopEvent<SystemProbeEvent>>,
) -> Result<(), CommandError> {
    let result = send_system_probe(&events);
    command_result(&state.errors, result)
}

fn send_system_probe(events: &Channel<DesktopEvent<SystemProbeEvent>>) -> Result<(), AppError> {
    const LABELS: [&str; 3] = ["commandReady", "channelReady", "completed"];
    for (index, label) in LABELS.into_iter().enumerate() {
        let event = DesktopEvent {
            version: CONTRACT_VERSION,
            stream_id: None,
            sequence: Some(index as u64),
            kind: "systemProbe".to_string(),
            payload: SystemProbeEvent {
                step: u16::try_from(index + 1).unwrap_or(u16::MAX),
                total: u16::try_from(LABELS.len()).unwrap_or(u16::MAX),
                label: label.to_string(),
            },
        };
        events.send(event).map_err(|source| {
            AppError::external(
                "The desktop event channel closed",
                format!("system probe channel: {source}"),
                true,
            )
        })?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use codez_contracts::{DesktopEvent, SystemProbeEvent};
    use tauri::ipc::{Channel, InvokeResponseBody};

    use super::send_system_probe;

    #[test]
    fn system_probe_sends_three_ordered_channel_events() {
        let received = Arc::new(Mutex::new(Vec::new()));
        let sink = Arc::clone(&received);
        let channel = Channel::new(move |body| {
            if let InvokeResponseBody::Json(json) = body {
                let event: DesktopEvent<SystemProbeEvent> = serde_json::from_str(&json)?;
                sink.lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(event);
            }
            Ok(())
        });

        send_system_probe(&channel).expect("probe channel must remain open");
        let events = received
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        assert_eq!(events.len(), 3);
        assert_eq!(events[0].sequence, Some(0));
        assert_eq!(events[2].payload.label, "completed");
    }
}
