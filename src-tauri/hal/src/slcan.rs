//! Lawicel/SLCAN: reply parser, listen-only open sequence and frame decoding.
//!
//! Mirrors the browser adapter (`src/services/webSerialCan.ts`): a command is
//! answered by a bare `\r` (OK) or `\a` (BELL, refused); frames and text
//! replies are lines ended by `\r`. The session opens with `C` (close any
//! channel an earlier session left open; a BELL there only means it was
//! already closed), `S<n>` (bit rate) and `L` (listen-only). Frames are
//! delivered only once `L` was confirmed; `O` never appears.

use std::time::Duration;

use crate::{Frame, OpenError};

/// One unit of adapter output.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    Ok,
    Error,
    Line(String),
}

/// Splits a byte stream into [`Event`]s across reads.
#[derive(Debug, Default)]
pub struct Parser {
    buf: String,
}

impl Parser {
    pub fn feed(&mut self, bytes: &[u8]) -> Vec<Event> {
        let mut out = Vec::new();
        for &b in bytes {
            match b {
                b'\x07' => {
                    self.buf.clear();
                    out.push(Event::Error);
                }
                b'\r' => {
                    if self.buf.is_empty() {
                        out.push(Event::Ok);
                    } else {
                        out.push(Event::Line(std::mem::take(&mut self.buf)));
                    }
                }
                b'\n' => {}
                _ => self.buf.push(b as char),
            }
        }
        out
    }
}

/// Lawicel `S<n>` bit-rate codes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BitrateCode {
    S0 = 0,
    S1,
    S2,
    S3,
    S4,
    S5,
    S6,
    S7,
    S8,
}

impl BitrateCode {
    /// The code for a bit rate in bit/s, or `None` when SLCAN has no code for it.
    pub fn for_bitrate(bitrate: u32) -> Option<Self> {
        Some(match bitrate {
            10_000 => Self::S0,
            20_000 => Self::S1,
            50_000 => Self::S2,
            100_000 => Self::S3,
            125_000 => Self::S4,
            250_000 => Self::S5,
            500_000 => Self::S6,
            800_000 => Self::S7,
            1_000_000 => Self::S8,
            _ => return None,
        })
    }

    pub fn command(self) -> String {
        format!("S{}", self as u8)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum State {
    Closing,
    SettingBitrate,
    EnteringListenOnly,
    Open,
    Refused,
}

/// What the driver must do after feeding an event to the session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Step {
    /// Send this command (already without the trailing CR) and wait for its reply.
    Send(String),
    /// Keep waiting for the reply of the last command.
    Wait,
    /// Listen-only confirmed: the channel is open.
    Opened,
    /// Not opened; the driver closes the port.
    Refuse(OpenError),
    /// A received frame (only ever produced in the open state).
    Frame(Frame),
    /// Text that is not a frame (version strings etc.), ignored by the driver.
    Ignore,
}

/// Pure open/receive state machine.
#[derive(Debug)]
pub struct Session {
    state: State,
    bitrate: BitrateCode,
}

impl Session {
    pub fn new(bitrate: BitrateCode) -> Self {
        Self {
            state: State::Closing,
            bitrate,
        }
    }

    /// The first command of the open sequence.
    pub fn start(&self) -> Step {
        Step::Send("C".into())
    }

    pub fn is_open(&self) -> bool {
        self.state == State::Open
    }

    pub fn on_event(&mut self, event: Event, rx_time: Duration) -> Step {
        match (self.state, event) {
            // `C` may be refused when nothing was open: either way, go on.
            (State::Closing, Event::Ok | Event::Error) => {
                self.state = State::SettingBitrate;
                Step::Send(self.bitrate.command())
            }
            (State::SettingBitrate, Event::Ok) => {
                self.state = State::EnteringListenOnly;
                Step::Send("L".into())
            }
            (State::SettingBitrate, Event::Error) => {
                self.state = State::Refused;
                Step::Refuse(OpenError::BitrateRefused(self.bitrate.command()))
            }
            (State::EnteringListenOnly, Event::Ok) => {
                self.state = State::Open;
                Step::Opened
            }
            (State::EnteringListenOnly, Event::Error) => {
                self.state = State::Refused;
                Step::Refuse(OpenError::ListenOnlyRefused)
            }
            // Text while a command is pending is not a confirmation: keep waiting.
            (
                State::Closing | State::SettingBitrate | State::EnteringListenOnly,
                Event::Line(_),
            ) => Step::Wait,
            (State::Open, Event::Line(line)) => match parse_frame(&line, rx_time) {
                Some(frame) => Step::Frame(frame),
                None => Step::Ignore,
            },
            (State::Open, Event::Ok | Event::Error) => Step::Ignore,
            (State::Refused, _) => Step::Refuse(OpenError::ListenOnlyNotConfirmed),
        }
    }

    /// The reply timeout for a pending open command is a refusal, never a retry.
    pub fn on_timeout(&mut self) -> Step {
        match self.state {
            State::Open => Step::Ignore,
            State::EnteringListenOnly => {
                self.state = State::Refused;
                Step::Refuse(OpenError::ListenOnlyNotConfirmed)
            }
            State::Closing | State::SettingBitrate => {
                self.state = State::Refused;
                Step::Refuse(OpenError::Io("no reply from the adapter".into()))
            }
            State::Refused => Step::Refuse(OpenError::ListenOnlyNotConfirmed),
        }
    }
}

/// Decodes `tIIIL<data>` / `TIIIIIIIIL<data>` lines; remote and unknown lines give `None`.
pub fn parse_frame(line: &str, rx_time: Duration) -> Option<Frame> {
    let mut chars = line.chars();
    let kind = chars.next()?;
    let (extended, id_len) = match kind {
        't' => (false, 3),
        'T' => (true, 8),
        _ => return None,
    };
    let rest: &str = &line[1..];
    if rest.len() < id_len + 1 {
        return None;
    }
    let id = u32::from_str_radix(&rest[..id_len], 16).ok()?;
    let dlc = rest[id_len..id_len + 1].parse::<usize>().ok()?;
    if dlc > 8 {
        return None;
    }
    let hex = &rest[id_len + 1..];
    if hex.len() < dlc * 2 {
        return None;
    }
    let data = (0..dlc)
        .map(|i| u8::from_str_radix(&hex[2 * i..2 * i + 2], 16).ok())
        .collect::<Option<Vec<u8>>>()?;
    Some(Frame {
        id,
        extended,
        data,
        rx_time,
    })
}

#[cfg(feature = "slcan")]
pub mod serial {
    //! Serial driver around [`Session`]: the only place that writes to the port,
    //! and it writes nothing but the open sequence and the final `C`.

    use std::io::{Read, Write};
    use std::time::{Duration, Instant};

    use super::{BitrateCode, Parser, Session, Step};
    use crate::{Frame, OpenError};

    pub struct SlcanAdapter {
        port: Box<dyn serialport::SerialPort>,
        parser: Parser,
        session: Session,
        opened_at: Instant,
    }

    impl SlcanAdapter {
        /// Opens `path`, runs `C`/`S`/`L` and returns only when `L` was confirmed.
        pub fn open(path: &str, baud: u32, bitrate: BitrateCode) -> Result<Self, OpenError> {
            let port = serialport::new(path, baud)
                .timeout(Duration::from_millis(100))
                .open()
                .map_err(|e| OpenError::Io(e.to_string()))?;
            let mut adapter = Self {
                port,
                parser: Parser::default(),
                session: Session::new(bitrate),
                opened_at: Instant::now(),
            };
            let mut step = adapter.session.start();
            let reply_timeout = Duration::from_millis(1000);
            loop {
                match step {
                    Step::Send(cmd) => {
                        adapter.write_command(&cmd)?;
                        step = adapter.await_reply(reply_timeout)?;
                    }
                    Step::Wait => step = adapter.await_reply(reply_timeout)?,
                    Step::Opened => return Ok(adapter),
                    Step::Refuse(err) => {
                        let _ = adapter.write_command("C");
                        return Err(err);
                    }
                    Step::Frame(_) | Step::Ignore => step = adapter.await_reply(reply_timeout)?,
                }
            }
        }

        fn write_command(&mut self, cmd: &str) -> Result<(), OpenError> {
            debug_assert!(cmd != "O", "normal mode is never requested");
            self.port
                .write_all(format!("{cmd}\r").as_bytes())
                .map_err(|e| OpenError::Io(e.to_string()))
        }

        fn await_reply(&mut self, timeout: Duration) -> Result<Step, OpenError> {
            let deadline = Instant::now() + timeout;
            let mut buf = [0u8; 256];
            while Instant::now() < deadline {
                match self.port.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        for event in self.parser.feed(&buf[..n]) {
                            let step = self.session.on_event(event, self.opened_at.elapsed());
                            if !matches!(step, Step::Wait) {
                                return Ok(step);
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(e) => return Err(OpenError::Io(e.to_string())),
                }
            }
            Ok(self.session.on_timeout())
        }

        /// Blocks until the next frame; `None` on a port error.
        pub fn next_frame(&mut self) -> Option<Frame> {
            let mut buf = [0u8; 256];
            loop {
                match self.port.read(&mut buf) {
                    Ok(0) => {}
                    Ok(n) => {
                        for event in self.parser.feed(&buf[..n]) {
                            if let Step::Frame(f) =
                                self.session.on_event(event, self.opened_at.elapsed())
                            {
                                return Some(f);
                            }
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::TimedOut => {}
                    Err(_) => return None,
                }
            }
        }
    }

    impl Drop for SlcanAdapter {
        fn drop(&mut self) {
            let _ = self.write_command("C");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const T0: Duration = Duration::ZERO;

    fn open_sequence(replies: &[Event]) -> (Session, Vec<String>, Step) {
        let mut s = Session::new(BitrateCode::S6);
        let mut sent = Vec::new();
        let mut step = s.start();
        for r in replies {
            if let Step::Send(c) = &step {
                sent.push(c.clone());
            }
            step = s.on_event(r.clone(), T0);
        }
        (s, sent, step)
    }

    #[test]
    fn parser_splits_ok_error_and_lines() {
        let mut p = Parser::default();
        assert_eq!(
            p.feed(b"\rV1013\r\x07t12380011223344556677\r"),
            vec![
                Event::Ok,
                Event::Line("V1013".into()),
                Event::Error,
                Event::Line("t12380011223344556677".into()),
            ]
        );
        // A line split across reads is completed, a BELL discards partial text.
        assert_eq!(p.feed(b"t12"), vec![]);
        assert_eq!(p.feed(b"3100\r"), vec![Event::Line("t123100".into())]);
        assert_eq!(p.feed(b"V10\x07"), vec![Event::Error]);
    }

    #[test]
    fn happy_path_sends_c_s_l_and_opens_after_l_is_confirmed() {
        let (s, sent, step) = open_sequence(&[Event::Ok, Event::Ok, Event::Ok]);
        assert_eq!(sent, vec!["C", "S6", "L"]);
        assert_eq!(step, Step::Opened);
        assert!(s.is_open());
        assert!(!sent.iter().any(|c| c == "O"));
    }

    #[test]
    fn a_refused_close_is_not_an_error() {
        let (_, sent, step) = open_sequence(&[Event::Error, Event::Ok, Event::Ok]);
        assert_eq!(sent, vec!["C", "S6", "L"]);
        assert_eq!(step, Step::Opened);
    }

    #[test]
    fn a_refused_l_is_a_refusal_not_a_fallback_to_o() {
        let (s, sent, step) = open_sequence(&[Event::Ok, Event::Ok, Event::Error]);
        assert_eq!(step, Step::Refuse(OpenError::ListenOnlyRefused));
        assert!(!s.is_open());
        assert_eq!(sent, vec!["C", "S6", "L"]);
        // Nothing after a refusal reopens the channel.
        let mut s = s;
        assert!(matches!(s.on_event(Event::Ok, T0), Step::Refuse(_)));
    }

    #[test]
    fn a_refused_bitrate_is_a_refusal() {
        let (_, _, step) = open_sequence(&[Event::Ok, Event::Error]);
        assert_eq!(step, Step::Refuse(OpenError::BitrateRefused("S6".into())));
    }

    #[test]
    fn text_while_l_is_pending_is_not_a_confirmation_and_a_timeout_refuses() {
        let (mut s, _, step) = open_sequence(&[Event::Ok, Event::Ok, Event::Line("V1013".into())]);
        assert_eq!(step, Step::Wait);
        assert!(!s.is_open());
        assert_eq!(
            s.on_timeout(),
            Step::Refuse(OpenError::ListenOnlyNotConfirmed)
        );
    }

    #[test]
    fn frames_are_delivered_only_when_open() {
        let mut s = Session::new(BitrateCode::S6);
        s.start();
        // Frame text arriving before `L` is confirmed is dropped.
        assert_eq!(
            s.on_event(Event::Line("t1238001122334455667".into()), T0),
            Step::Wait
        );
        let (mut s, _, _) = open_sequence(&[Event::Ok, Event::Ok, Event::Ok]);
        let step = s.on_event(Event::Line("t12380011223344556677".into()), T0);
        assert_eq!(
            step,
            Step::Frame(Frame {
                id: 0x123,
                extended: false,
                data: vec![0, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77],
                rx_time: T0
            })
        );
        assert_eq!(s.on_event(Event::Line("V1013".into()), T0), Step::Ignore);
    }

    #[test]
    fn frame_parsing_covers_extended_and_rejects_garbage() {
        let f = parse_frame("T18DAF110302620A5", T0).unwrap();
        assert_eq!(
            (f.id, f.extended, f.data.clone()),
            (0x18DAF110, true, vec![0x02, 0x62, 0x0A])
        );
        assert!(parse_frame("r1230", T0).is_none());
        assert!(parse_frame("t12390011", T0).is_none()); // dlc 9
        assert!(parse_frame("t1232zz", T0).is_none());
        assert!(parse_frame("t1", T0).is_none());
    }

    #[test]
    fn bitrate_codes() {
        assert_eq!(BitrateCode::for_bitrate(500_000), Some(BitrateCode::S6));
        assert_eq!(BitrateCode::S6.command(), "S6");
        assert_eq!(BitrateCode::for_bitrate(123), None);
    }
}
