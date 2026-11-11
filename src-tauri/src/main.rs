//! vehicle-analyzer desktop shell (D-081 stage 2).
//!
//! Runs the same web frontend as the browser host and adds the native
//! listen-only CAN source: `hal_open` / `hal_close` over the
//! `vehicle-analyzer-hal` crate (SLCAN serial; SocketCAN/candleLight on
//! Linux), frames as `can-frame` events. The HAL refuses anything it cannot
//! open listen-only and has no transmit path (D-081 item 2, invariant 1).

// No extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod hal_bridge;

fn main() {
    tauri::Builder::default()
        .manage(hal_bridge::HalState::default())
        .invoke_handler(tauri::generate_handler![
            hal_bridge::hal_open,
            hal_bridge::hal_close
        ])
        .run(tauri::generate_context!())
        .expect("vehicle-analyzer desktop shell failed to start");
}
