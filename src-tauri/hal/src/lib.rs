//! Listen-only CAN adapter HAL for the vehicle-analyzer desktop shell.
//!
//! D-081 item 2 / platform invariant 1: the analyzer never transmits on a
//! vehicle bus and never acknowledges frames. Every backend here opens its
//! adapter in controller listen-only mode and **refuses** to open anything
//! it cannot put into that mode:
//!
//! - [`slcan`]: Lawicel/SLCAN serial adapters. The open sequence is `C`,
//!   `S<n>`, `L`; a frame is delivered only after the adapter confirmed `L`
//!   with a bare CR. `O` (normal mode) is never sent.
//! - [`socketcan`]: Linux SocketCAN interfaces, which is also how
//!   candleLight/gs_usb adapters appear. The interface must already report
//!   `CAN_CTRLMODE_LISTENONLY`; the HAL does not change interface modes and
//!   holds no transmit path.
//!
//! The policy lives in pure, feature-free code with unit tests; the real
//! serial/socket I/O sits behind the `slcan` and `socketcan` cargo features.

pub mod slcan;
pub mod socketcan;

use std::time::Duration;

/// One received classic CAN frame (listen-only: never constructed for sending).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    pub id: u32,
    pub extended: bool,
    pub data: Vec<u8>,
    /// Host receive time relative to the adapter's open, best effort.
    pub rx_time: Duration,
}

/// Why an adapter was not opened. Every variant is a refusal, never a retry hint.
#[derive(Debug, Clone, thiserror::Error, PartialEq, Eq)]
pub enum OpenError {
    #[error("the adapter refused listen-only mode (L); not opened")]
    ListenOnlyRefused,
    #[error("the adapter did not confirm listen-only mode (L); not opened")]
    ListenOnlyNotConfirmed,
    #[error("the adapter refused the bit rate ({0}); not opened")]
    BitrateRefused(String),
    #[error("interface {0} is not in listen-only mode (CAN_CTRLMODE_LISTENONLY off); not opened")]
    InterfaceNotListenOnly(String),
    #[error("interface {0} does not report its control modes; not opened")]
    InterfaceModeUnknown(String),
    #[error("backend not compiled in: {0}")]
    BackendUnavailable(&'static str),
    #[error("I/O error: {0}")]
    Io(String),
}
