//! Tauri commands over the listen-only HAL (D-081 item 2).
//!
//! `hal_open` runs the backend's open sequence and returns only when the
//! adapter is confirmed listen-only; a refusal comes back as the error
//! string and nothing stays open. Frames then arrive as `can-frame` events.
//! There is no command that transmits: the HAL has no such path.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, State};
use vehicle_analyzer_hal::{Frame, OpenError};

pub const FRAME_EVENT: &str = "can-frame";

#[derive(Debug, Clone, Copy, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AdapterKind {
    Slcan,
    Socketcan,
}

#[derive(Debug, Clone, Deserialize)]
pub struct OpenRequest {
    pub kind: AdapterKind,
    /// Serial port path for SLCAN, interface name for SocketCAN.
    pub name: String,
    /// Bus bit rate in bit/s (SLCAN only; SocketCAN takes the interface's).
    pub bitrate: u32,
    /// `vehicle` or `platform`: echoed on every frame so the UI decodes with the right DBC.
    pub bus: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct FrameEvent {
    pub id: u32,
    pub extended: bool,
    pub data: Vec<u8>,
    /// Seconds since the adapter was opened.
    pub rx_time: f64,
    pub bus: String,
}

/// The one open adapter: its reader thread stops when the flag is cleared.
#[derive(Default)]
pub struct HalState {
    reader: Mutex<Option<Arc<AtomicBool>>>,
}

impl HalState {
    fn stop(&self) {
        if let Some(flag) = self.reader.lock().expect("hal state").take() {
            flag.store(false, Ordering::Relaxed);
        }
    }
}

fn event(frame: Frame, bus: &str) -> FrameEvent {
    FrameEvent {
        id: frame.id,
        extended: frame.extended,
        data: frame.data,
        rx_time: frame.rx_time.as_secs_f64(),
        bus: bus.to_string(),
    }
}

/// Which backend serves a request on this build (pure, tested).
pub fn backend_available(kind: AdapterKind) -> Result<(), OpenError> {
    match kind {
        AdapterKind::Slcan if cfg!(feature = "slcan") => Ok(()),
        AdapterKind::Slcan => Err(OpenError::BackendUnavailable("slcan")),
        AdapterKind::Socketcan if cfg!(all(feature = "socketcan", target_os = "linux")) => Ok(()),
        AdapterKind::Socketcan => Err(OpenError::BackendUnavailable("socketcan (Linux only)")),
    }
}

/// Reader loop shared by the backends: one adapter, one `next_frame` source.
fn pump(
    app: AppHandle,
    bus: String,
    running: Arc<AtomicBool>,
    mut next: impl FnMut() -> Option<Frame> + Send + 'static,
) {
    thread::spawn(move || {
        while running.load(Ordering::Relaxed) {
            match next() {
                Some(f) => {
                    let _ = app.emit(FRAME_EVENT, event(f, &bus));
                }
                None => break,
            }
        }
    });
}

#[tauri::command]
pub fn hal_open(
    app: AppHandle,
    state: State<'_, HalState>,
    request: OpenRequest,
) -> Result<(), String> {
    backend_available(request.kind).map_err(|e| e.to_string())?;
    state.stop();
    let running = Arc::new(AtomicBool::new(true));
    match request.kind {
        AdapterKind::Slcan => open_slcan(app, &request, running.clone())?,
        AdapterKind::Socketcan => open_socketcan(app, &request, running.clone())?,
    }
    // Only a confirmed listen-only adapter reaches this point.
    *state.reader.lock().expect("hal state") = Some(running);
    Ok(())
}

#[tauri::command]
pub fn hal_close(state: State<'_, HalState>) {
    state.stop();
}

#[cfg(feature = "slcan")]
fn open_slcan(app: AppHandle, req: &OpenRequest, running: Arc<AtomicBool>) -> Result<(), String> {
    use vehicle_analyzer_hal::slcan::{serial::SlcanAdapter, BitrateCode};
    let code = BitrateCode::for_bitrate(req.bitrate)
        .ok_or_else(|| format!("SLCAN has no bit-rate code for {} bit/s", req.bitrate))?;
    let mut adapter = SlcanAdapter::open(&req.name, 115_200, code).map_err(|e| e.to_string())?;
    pump(app, req.bus.clone(), running, move || adapter.next_frame());
    Ok(())
}

#[cfg(not(feature = "slcan"))]
fn open_slcan(_: AppHandle, _: &OpenRequest, _: Arc<AtomicBool>) -> Result<(), String> {
    Err(OpenError::BackendUnavailable("slcan").to_string())
}

#[cfg(all(feature = "socketcan", target_os = "linux"))]
fn open_socketcan(
    app: AppHandle,
    req: &OpenRequest,
    running: Arc<AtomicBool>,
) -> Result<(), String> {
    use vehicle_analyzer_hal::socketcan::linux::SocketCanAdapter;
    let mut adapter = SocketCanAdapter::open(&req.name).map_err(|e| e.to_string())?;
    pump(app, req.bus.clone(), running, move || adapter.next_frame());
    Ok(())
}

#[cfg(not(all(feature = "socketcan", target_os = "linux")))]
fn open_socketcan(_: AppHandle, _: &OpenRequest, _: Arc<AtomicBool>) -> Result<(), String> {
    Err(OpenError::BackendUnavailable("socketcan (Linux only)").to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slcan_availability_follows_the_feature() {
        let r = backend_available(AdapterKind::Slcan);
        assert_eq!(r.is_ok(), cfg!(feature = "slcan"));
    }

    #[test]
    fn socketcan_is_linux_only() {
        let r = backend_available(AdapterKind::Socketcan);
        assert_eq!(
            r.is_ok(),
            cfg!(all(feature = "socketcan", target_os = "linux"))
        );
    }

    #[test]
    fn the_bridge_exposes_no_transmit_command() {
        let src = include_str!("hal_bridge.rs");
        // Built at run time so this test does not match its own text.
        let marker = ["#[tauri::", "command]"].concat();
        let commands: Vec<&str> = src
            .split(marker.as_str())
            .skip(1)
            .map(|s| s.split("fn ").nth(1).unwrap().split('(').next().unwrap())
            .collect();
        assert_eq!(commands, vec!["hal_open", "hal_close"]);
    }
}
