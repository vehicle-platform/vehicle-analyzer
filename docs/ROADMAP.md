# vehicle-analyzer roadmap

Live task list of the analyzer (2026-10-24). Scope: D-081. Layer split: D-085. Background (market benchmark, functional inventory): `external/vehicle-defs/docs/ideas/can-analyzer-master-plan.md` §2-3; its task list is superseded by this file.

## Boundary (D-085)

The analyzer is the developer's engineering tool. It shows frames, decoded signals, UDS, E2E, timing and recorded sessions, and interprets nothing.

- No LLM, no fault-catalog matching, no rider wording. Those belong to vehicle-mcp (tools) and the rider layer (Q-037).
- It never transmits on a vehicle bus (invariant 1); the UDS composer reaches only the simulated ECU.
- It decodes only from the pinned defs (invariant 2).

## Built (main)

| Area | What exists |
|---|---|
| Trace | overwrite view per bus and ID, chronological log, E2E status, pause-on-ID, ASC/CSV/JSON export |
| Sniffer | byte heatmap, notch filter, flow view, bit-flip classes |
| Oscilloscope | platform signals and DIDs, dual cursors, math channels, CSV/PNG export |
| UDS observer | ISO-TP reassembly, request/response pairing, DIDs, DTCs with status bits, NRCs, `tester_policy` and second-tester alerts |
| Freeze frames (A5) | 0x19 0x04 / 0x06 records decoded with `dtc_record_reports` and the DID catalog: snapshot cards show named values with units, extended-data cards name the first record kind; an unknown or variable-length DID stops the walk and the rest stays raw with its reason |
| DTC report export (A5.1) | JSON and CSV export buttons on the DTCs tab: JSON has one object per DTC (code, status, decoded snapshot / extended data, raw bytes as hex) and the defs ref; CSV has one row per decoded value (one per field of a multi-value DID), a `stop:<reason>` row when the walk stopped and an `ext:<kind>` row for extended data; names, units and DIDs come from the defs catalog |
| Health | D-079 windows W1-W5, E2E supervisor, heartbeats |
| HUD | cornering level from 0x023; UNAVAILABLE without a fresh, E2E-valid status |
| Cluster (A1, analyzer#13) | key **F**: tach, speed, coolant / battery / throttle, lean, telltales (cornering level, BSM, immobilizer, ECU present), node heartbeats; every readout from a defs name, "no data" or STALE (`E2E_TIMEOUT_CYCLES` x DBC cycle) instead of a guessed value; cornering UNAVAILABLE without a fresh frame |
| Sources | virtual bus (simulated CL250 + platform bus), log replay, SLCAN listen-only, WebSocket client (`StreamMessageDto`) |
| Live source (A2, server#24 + analyzer#14) | vehicle-server `/ws/live`: first message `hello` with the token (header token field, sessionStorage only, never in the URL), `batch` envelopes, `heartbeat` every 5 s with `source` and `dropped`; 1008/1011 closes are not retried; the header shows `source mock` in amber. Server side: per-client ring of 256 batches (drop oldest), `VEHICLE_LIVE_SOURCE=mock` (default `none`); the real source (rt-core via the Raspi, D-077) is still open |
| Recorded sessions (A3) | key **E**, source `Session`: `GET /sessions`, `/sessions/{id}/report` summary and `/sessions/{id}/series` (max 2000 points) from vehicle-server; the token goes in the `Authorization` header only (shared sessionStorage field, never a URL). `did.<NAME>` series land on the live DID key (defs units), `sensor.*` / `derived.*` as `session · sensor` / `session · derived` channels with the response unit. **Open** replays through the transport (time-ordered samples), **Load all** pushes everything for static inspection |
| Track (A7a) | key **G**: relative dead-reckoned track from the selected/opened recorded session (`GET /sessions/{id}/track`): speed or any session series as colour, one canvas with north up, fit/zoom/pan, gap-aware segments, replay cursor and click-to-seek. The server stores no latitude, longitude or height; the view is metres from the first usable fix, never a map and never an absolute position. Zero third-party requests (Playwright). Pure geometry in `src/services/trackGeometry.ts` |
| Session comparison (A4) | key **A**: pick sessions A and B (same server URL / token fields), a channel present in both with the same unit, axis time or distance; overlay of A and B plus the difference B - A as SVG; **Export CSV** (key V): `# A=..; B=..; channel=..; unit=..; axis=..` comment line, then `axis,A,B,B_minus_A`. Both series are linearly interpolated onto a 500-point grid over the overlap of their ranges (the server's min/max samples as they are; no extrapolation; null across a gap longer than 5x the median sample spacing; the difference is null where either side is). Time axis = seconds since each session's own t0; distance axis = `derived.trip_distance` (km) and is disabled with the reason when either session lacks it. Position-like channels (latitude / longitude) are refused. Pure logic in `src/services/compare.ts` |
| Quality (A8, analyzer#24, analyzer#26) | Vitest unit and component tests, Playwright smoke test of every view and of a 200k-frame import in CI; active view and HUD layout persist across reloads; ASC/CSV logs are parsed in a module Web Worker (synchronous fallback) with progress and cancel, then loaded for replay at frame 0; decoding, timing and E2E stay in `CaptureStore` with the active catalog |

## Tasks (in order)

| # | Task | Depends on | Done when |
|---|---|---|---|
| A1.1 | **Tach rev limit:** the tach arc follows the DBC range of the RPM signal (0-16383.75 rpm), so normal RPM sits low on the arc; scale it to the real rev limit | a sourced rev-limit constant in defs (`/signal-change`); never a literal in the analyzer | the arc end comes from the defs constant; the DBC range stays the fallback |
| A6 | **Desktop (Tauri 2) and native HAL:** SocketCAN with `listen-only on`, SLCAN `L`, candleLight/gs_usb; the HAL refuses any interface it cannot open listen-only | rustup on the dev machine; red zone, Claude only | a test proves the refusal; the shell runs the same frontend; `.dmg`, AppImage/`.deb`, `.msi` from CI |
| A7a | **Relative dead-reckoned track:** speed/heading integration from the recorded GNSS speed and heading, colour by speed or any session series; no map, no position | D-060, D-076 item 3 not implemented; TR-1..TR-3 server `/track` | **done** (this run): server tests and analyzer tests/Playwright green |
| A7b | **Absolute position and self-hosted tiles** (D-076): map overlay with local or self-hosted tiles | D-076 item 3 (position storage decision) and defs support; A7a done | zero requests to third-party hosts (test); coordinates never committed; privacy review |
| A9 | **Repo hygiene:** analyzer CI as a required check (GitHub setting, user); consume per-signal tables from defs instead of parsing the DBC once defs generates them (ISSUES E-20) | defs E-20 item 1 | `src/services/dbcParser.ts` used only for "custom DBC" |

Not in the analyzer (D-085): rider explanations, the "master mechanic", fault-catalog matching, anything that talks to an LLM.
