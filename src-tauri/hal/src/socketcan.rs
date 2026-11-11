//! Linux SocketCAN (and candleLight/gs_usb, which the kernel exposes the same
//! way): open only an interface that already reports listen-only mode.
//!
//! The HAL never changes an interface's control modes (that is the operator's
//! `ip link set ... listen-only on`, see vehicle-linux-node's
//! `vehicle-linux-node-can vehicle-tap`) and never holds a transmit path.

use crate::OpenError;

/// `CAN_CTRLMODE_LISTENONLY` from `linux/can/netlink.h` (kernel ABI, stable).
pub const CAN_CTRLMODE_LISTENONLY: u32 = 0x02;

/// Policy: open only when the reported control-mode flags include listen-only.
///
/// `flags` is `None` when the interface did not report its modes (a virtual
/// `vcan` does not have any): that is a refusal too, because the analyzer
/// cannot prove it will not acknowledge frames there. Development replay goes
/// through log files and the server stream instead.
pub fn check_listen_only(ifname: &str, flags: Option<u32>) -> Result<(), OpenError> {
    match flags {
        None => Err(OpenError::InterfaceModeUnknown(ifname.to_string())),
        Some(f) if f & CAN_CTRLMODE_LISTENONLY != 0 => Ok(()),
        Some(_) => Err(OpenError::InterfaceNotListenOnly(ifname.to_string())),
    }
}

#[cfg(all(feature = "socketcan", target_os = "linux"))]
pub mod linux {
    //! Real backend: netlink query, then a receive-only socket.

    use std::time::Instant;

    use socketcan::{CanCtrlMode, CanInterface, CanSocket, EmbeddedFrame, Frame as _, Socket};

    use super::{check_listen_only, CAN_CTRLMODE_LISTENONLY};
    use crate::{Frame, OpenError};

    pub struct SocketCanAdapter {
        socket: CanSocket,
        opened_at: Instant,
    }

    impl SocketCanAdapter {
        pub fn open(ifname: &str) -> Result<Self, OpenError> {
            let iface = CanInterface::open(ifname).map_err(|e| OpenError::Io(e.to_string()))?;
            // socketcan 4 exposes the modes through has_mode(); fold the one bit we need.
            let flags = iface
                .ctrlmodes()
                .map_err(|e| OpenError::Io(e.to_string()))?
                .map(|m| {
                    if m.has_mode(CanCtrlMode::ListenOnly) {
                        CAN_CTRLMODE_LISTENONLY
                    } else {
                        0
                    }
                });
            check_listen_only(ifname, flags)?;
            let socket = CanSocket::open(ifname).map_err(|e| OpenError::Io(e.to_string()))?;
            Ok(Self {
                socket,
                opened_at: Instant::now(),
            })
        }

        /// Blocks until the next frame; `None` on a socket error.
        pub fn next_frame(&mut self) -> Option<Frame> {
            let frame = self.socket.read_frame().ok()?;
            Some(Frame {
                id: frame.raw_id(),
                extended: frame.is_extended(),
                data: frame.data().to_vec(),
                rx_time: self.opened_at.elapsed(),
            })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn listen_only_flag_set_opens() {
        assert_eq!(
            check_listen_only("can1", Some(CAN_CTRLMODE_LISTENONLY | 0x10)),
            Ok(())
        );
    }

    #[test]
    fn normal_mode_is_refused() {
        assert_eq!(
            check_listen_only("can0", Some(0x00)),
            Err(OpenError::InterfaceNotListenOnly("can0".into()))
        );
        // Loopback or other flags without listen-only are still a refusal.
        assert!(check_listen_only("can0", Some(0x01)).is_err());
    }

    #[test]
    fn unknown_modes_are_refused() {
        assert_eq!(
            check_listen_only("vcan0", None),
            Err(OpenError::InterfaceModeUnknown("vcan0".into()))
        );
    }

    #[test]
    fn the_backend_source_has_no_transmit_or_mode_change() {
        let src = include_str!("socketcan.rs");
        // Built at run time so this list does not match itself.
        let forbidden = [
            ["write_", "frame"].concat(),
            ["set_", "ctrlmode"].concat(),
            ["trans", "mit("].concat(),
            ["bring_", "up"].concat(),
        ];
        for word in &forbidden {
            assert!(
                !src.contains(word.as_str()),
                "{word} must not appear in the SocketCAN backend"
            );
        }
    }
}
