# vehicle-analyzer

Real-time CAN bus analyzer and telemetry cockpit (Web Host & Cross-Platform Desktop) for the [`vehicle-platform`](https://github.com/vehicle-platform) motorcycle SDV diagnostics & telemetry architecture.

Benchmarked against automotive OEM and open-source standards: **Vector CANalyzer**, **SavvyCAN**, **Cabana**, and **Foxglove Studio**.

---

## Features

Every CAN ID, signal, scaling, cycle time, E2E DataID, DID, UDS address and tester rule comes from the pinned [`vehicle-defs`](https://github.com/vehicle-platform/vehicle-defs) copy in `external/vehicle-defs` (Invariant 2). The analyzer has no built-in signal catalog.

- **Trace:** overwrite view per bus and ID (period, frequency, count, changed bytes, E2E status, decoded signals with value-table names) and a chronological log; pause-on-ID trigger; export to Vector ASC, CSV and JSON.
- **Sniffer:** byte heatmap (up, down, direction reversal, static), notch filter, flow view and bit-flip classes by flip rate.
- **Oscilloscope:** any platform signal or vehicle DID, dual cursors with per-channel values, host-side math channels (derivative, difference, product, ratio), CSV and PNG export.
- **UDS observer:** passive decoding of the tester's ISO 14229 conversation on the vehicle bus (ISO-TP reassembly, request/response pairing, DID values with stale state, DTCs with status bits, NRC names), alerts for a request outside `tester_policy` or a functional request (a second tester). The request composer sends only to the simulated ECU.
- **Health:** the D-079 window entry conditions (W1-W5) evaluated on the observed inputs, the E2E supervisor of the platform bus (CRC-8/SAE-J1850, alive counter, timeout) and node heartbeats.
- **Cluster (key F):** instrument cluster (tach, speed, coolant, battery, throttle, lean, telltales, node heartbeats) built only from defs signal names. A missing input shows "no data" and an old one STALE, never a guessed value; the cornering telltale shows UNAVAILABLE without a fresh frame.
- **Sources:** virtual bus (simulated CL250 vehicle bus with the UDS conversation, platform bus with E2E), log replay at recorded timing, recorded vehicle-server sessions (read-only HTTP), the vehicle-server live stream (`/ws/live`, `StreamMessageDto`), and USB SLCAN adapters opened listen-only.
- **Recorded sessions (key E):** pick a stored vehicle-server session (server URL and token fields; the token is sent in the `Authorization` header only), see its report summary, then **Open** to replay the series through the replay transport or **Load all** to inspect them in the oscilloscope. DIDs show with defs units; sensor and derived series appear as `session · sensor` / `session · derived` channels.
- **Compare (key A):** choose two recorded sessions and a channel they share (same unit); the overlay and the difference B - A are drawn on a common time axis (seconds since each session start) or, when both sessions have `derived.trip_distance`, a distance axis (km). Interpolation is linear inside each series only; gaps and non-overlap stay blank. Export CSV (`axis,A,B,B_minus_A`) names the session IDs, channel, unit and axis; position channels are never compared or exported.
- **Track (key G):** relative dead-reckoned track from the recorded session selected/opened in **Recorded sessions (E)**. GNSS speed and heading are integrated into metres from the first usable fix (east = +x, north = +y); colour by speed or any series the session offers, with the series name and unit from the server response. One canvas, north up, gap-aware segments, wheel zoom / drag pan / **Fit**, a replay cursor and click-to-seek. It is approximate and **not a map**; the server stores no latitude, longitude or height and the view never shows an absolute position. No third-party requests.
- **Ride summaries:** the D-070 class-B per-ride summaries that vehicle-server stores (one session = one ride). **Recorded sessions (E)** shows a ride summary card for the selected session (scalars with units, time-in-bin charts with their axes, and the signals that could not be computed with the reason); **Compare (A)** adds an A / B / B - A table of the common scalars and a second CSV block; **Ride history (key N)** plots 1-4 scalar columns of `GET /rides` across sessions, with gaps where a ride has no value, and a click opens that ride in Sessions. Names, units, ranges and bin edges come from the server response, never from a list in the analyzer.
- **Live stream:** the client sends a `hello` with the token entered in the header's token field (kept in sessionStorage, never in the URL); a rejected token (close 1008/1011) is not retried. The header shows the server's `source` from its heartbeat; `source mock` (server started with `VEHICLE_LIVE_SOURCE=mock`) is shown in amber so synthetic data is not mistaken for a real bus.

## Quick start

Requires Node.js 18+.

```bash
git submodule update --init      # external/vehicle-defs at the pinned tag
npm install
npm run dev                      # http://localhost:5173
npm test                         # vitest
npm run build
```

To move to a newer defs tag: `git -C external/vehicle-defs fetch --tags && git -C external/vehicle-defs checkout vX.Y.Z`, run the tests, commit the submodule pointer and record the combination in `vehicle-workspace/manifest.yaml`.

## Architecture

```
external/vehicle-defs ──► src/defs        (DBC + YAML -> typed Defs, bundled at build time)
sources (virtual bus, log replay, WebSocket, SLCAN)
        │ raw frames + bus role (vehicle | platform)
        ▼
src/services/pipeline.ts   timing per ID, decode with the bus's DBC, E2E check
src/services/udsMonitor.ts passive UDS observer of the vehicle bus
        ▼
src/state/captureStore.ts  frames, 50k-frame log ring, sniffer, Float64Array signal rings;
                           UI notified at most every 66 ms, however fast frames arrive
        ▼
src/components/*           Trace, Sniffer, Oscilloscope, UDS, Health, Defs & Logs, HUD, Cluster
```

- **Throughput:** ingest is O(1) per frame and independent of rendering (`npm test` measures it; about 130k frames/s in CI-class hardware, ~30x a fully loaded 500 kbit/s bus). The scroll log renders only visible rows; the oscilloscope draws on its own animation frames (at most 30 fps for new data) with min-max decimation per pixel column.
- **Invariant 1:** the analyzer never transmits on a vehicle bus. SLCAN adapters open in listen-only mode (`L`), and an adapter that refuses or does not confirm `L` is not used; the UDS composer only reaches the simulated ECU.
- **Invariant 2:** decoding uses only the pinned defs. Loading another DBC is possible for analysis and is shown as "custom DBC" in the header.
- **Safety outputs:** the HUD shows the cornering level the safety partition sent (0x023); without a fresh, E2E-valid status it shows UNAVAILABLE, never GREEN.
- **Not** `vehicle-mcp` (LLM tools) and **not** `vehicle-ml` (training).

---

## License

MIT, see [LICENSE](LICENSE) (D-036). Copyright (c) 2026 The vehicle-platform authors.
