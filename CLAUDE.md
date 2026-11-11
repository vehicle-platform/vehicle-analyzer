# CLAUDE.md — vehicle-analyzer

@.claude/PLATFORM-RULES.md

## What this repo is

Real-time CAN bus analyzer and telemetry cockpit (Web Host & Cross-Platform Desktop) for `vehicle-platform`.
- Interactive automotive engineering tool benchmarked against Vector CANalyzer, SavvyCAN, Cabana, and Foxglove Studio.
- Modular dockable panels: Bus Monitor / Trace (Overwrite & Scroll modes), SavvyCAN Byte Sniffer heatmap & diff inspector, multi-channel Signal Oscilloscope, and UDS ISO 14229 Diagnostic console.
- Supports local file synchronization (DBC definitions from `vehicle-defs`, log playback for ASC, CSV, JSON) and live streaming.
- Self-contained architecture: includes a high-fidelity virtual CAN generator (Honda CL250 dynamics) for zero-dependency standalone operation.

## What this repo is NOT

- No vehicle bus write access outside designated simulation modes (Platform Invariant 1: passive monitoring).
- Not `vehicle-mcp` (read-only LLM RPC tool server) — this is a deterministic automotive engineering cockpit.
- Not `vehicle-ml` (offline ML training) — no machine learning model training here.
- Not the rider layer (D-085): no LLM, no fault-catalog matching, no plain-language diagnosis; those are vehicle-mcp and the rider front end (Q-037).
- No invented signals or hardcoded CAN IDs (Platform Invariant 2: decoded signals derive strictly from `vehicle-defs`).
- No unauthorized GPS position leak (Platform Invariant 7 / D-076: strictly local / self-hosted auth).

## Build / run

```bash
git submodule update --init   # external/vehicle-defs, pinned to a tag
npm install
npm run dev      # Web Host dev server on http://localhost:5173
npm test         # vitest (tests/), runs against the pinned defs
npm run build    # Production bundle
npm run preview  # Preview production build
npm run tauri dev      # Desktop shell (A6, needs rustup + Tauri 2 system libs); `npm run tauri build` bundles
```

Desktop shell (`src-tauri/`, red zone): runs the same `dist/` build, strict CSP, `core:default` capability only, two native commands only, `hal_open` / `hal_close` (`src-tauri/src/hal_bridge.rs`, frames as `can-frame` events; the shell test pins the command list). The listen-only CAN HAL lives in the workspace crate `src-tauri/hal` (`vehicle-analyzer-hal`): pure policy with refusal tests (SLCAN session: `C`, `S<n>`, `L`, frames only after `L` is confirmed, never `O`; SocketCAN/candleLight: open only when the interface reports `CAN_CTRLMODE_LISTENONLY`, no mode change, no transmit path), real I/O behind the `slcan` (serialport, MPL-2.0, optional) and `socketcan` (Linux) features. UI: source "Native CAN" (`src/services/desktopCan.ts`, `DesktopCanAdapter`) appears only inside the Tauri webview (`isDesktop()`), replaces the browser-only Web Serial entry there, and reports a refusal as the source error; nothing is delivered before `hal_open` resolves. Next: bundles from CI and a first run on a real adapter.

Defs are read at build time from `external/vehicle-defs` (`src/defs/index.ts`, Vite `?raw` imports); there is no built-in signal catalog.

## Context

- Roadmap (live task list): `docs/ROADMAP.md`. Scope D-081, layer split D-085. Background only: `external/vehicle-defs/docs/ideas/can-analyzer-master-plan.md` §2-3
- DBC Definitions: `external/vehicle-defs/dbc/platform.dbc`, `external/vehicle-defs/dbc/cl250.dbc`
- UDS Specifications: `external/vehicle-defs/uds/vehicle_cl250.yaml`, `uds/iso14229.yaml`, `uds/obd_catalog.yaml`
- D-079 windows and limits: `external/vehicle-defs/derived/cl250_derived.yaml`, `limits/platform_limits.yaml`
- E2E profile: `external/vehicle-defs/docs/e2e-profile.md` (`src/services/e2e.ts`)
