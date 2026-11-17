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

/// The two bus kinds a frame can be tagged with (D-081): the UI decodes with the DBC of this bus.
pub const BUS_KINDS: [&str; 2] = ["vehicle", "platform"];

/// Validates the bus tag of an open request (pure, tested).
pub fn validate_bus(bus: &str) -> Result<(), String> {
    if BUS_KINDS.contains(&bus) {
        Ok(())
    } else {
        Err(format!("unknown bus {bus:?}: expected vehicle or platform"))
    }
}

fn is_ifname_byte(b: u8) -> bool {
    b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.')
}

/// A SocketCAN interface name: the kernel limit is 15 bytes (IFNAMSIZ - 1), plain
/// ASCII letters, digits, `_`, `-`, `.` and no path separators (pure, tested).
pub fn validate_interface_name(name: &str) -> Result<(), String> {
    if !name.is_empty() && name.len() <= 15 && name.bytes().all(is_ifname_byte) {
        Ok(())
    } else {
        Err(format!("invalid CAN interface name {name:?}"))
    }
}

/// `name` must be one of the serial ports the OS enumerates now, so the UI cannot make the
/// shell open an arbitrary path such as a device node or a file (pure, tested).
pub fn validate_port_name(name: &str, enumerated: &[String]) -> Result<(), String> {
    if enumerated.iter().any(|p| p == name) {
        Ok(())
    } else {
        Err(format!(
            "{name:?} is not a serial port reported by the system"
        ))
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
    validate_bus(&request.bus)?;
    match request.kind {
        AdapterKind::Slcan => validate_slcan_port(&request.name)?,
        AdapterKind::Socketcan => validate_interface_name(&request.name)?,
    }
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
fn validate_slcan_port(name: &str) -> Result<(), String> {
    let ports =
        vehicle_analyzer_hal::slcan::serial::available_port_names().map_err(|e| e.to_string())?;
    validate_port_name(name, &ports)
}

#[cfg(not(feature = "slcan"))]
fn validate_slcan_port(_: &str) -> Result<(), String> {
    Err(OpenError::BackendUnavailable("slcan").to_string())
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
    fn only_the_two_bus_kinds_are_accepted() {
        assert!(validate_bus("vehicle").is_ok());
        assert!(validate_bus("platform").is_ok());
        for bad in ["", "Vehicle", "can0", "vehicle ", "../x"] {
            assert!(validate_bus(bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn interface_names_are_plain_and_short() {
        for ok in ["can0", "vcan0", "can-1", "slcan0"] {
            assert!(validate_interface_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "../etc", "can0/x", "a b"] {
            assert!(validate_interface_name(bad).is_err(), "{bad:?}");
        }
        assert!(validate_interface_name("averyveryverylongname").is_err());
        assert!(validate_interface_name("can\u{e9}").is_err());
    }

    #[test]
    fn serial_ports_must_be_enumerated() {
        let ports = vec!["/dev/cu.usbmodem1".to_string(), "COM3".to_string()];
        assert!(validate_port_name("COM3", &ports).is_ok());
        assert!(validate_port_name("/dev/cu.usbmodem1", &ports).is_ok());
        assert!(validate_port_name("/dev/sda", &ports).is_err());
        assert!(validate_port_name("", &ports).is_err());
        assert!(validate_port_name("COM3", &[]).is_err());
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
