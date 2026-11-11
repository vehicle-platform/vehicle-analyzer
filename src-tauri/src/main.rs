//! vehicle-analyzer desktop shell (D-081 stage 2).
//!
//! Runs the same web frontend as the browser host. It exposes no commands
//! yet: the native CAN HAL (SocketCAN, SLCAN, candleLight) arrives with its
//! listen-only refusal tests before it opens any hardware (D-081 item 2,
//! invariant 1). Until then the desktop app has the same sources as the web
//! host minus Web Serial, which the system webview does not provide.

// No extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("vehicle-analyzer desktop shell failed to start");
}
