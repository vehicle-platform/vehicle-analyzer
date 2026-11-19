import type { CanFrame, DbcMessageDef, DbcSignalDef } from '../types/can';
import type { DidDef } from '../defs/model';
import type { CaptureStore } from '../state/captureStore';
import { frameKey } from './capture';
import { isE2EValid } from './e2e';
import { E2E_TIMEOUT_CYCLES } from './e2e';
import { formatSignal, formatValue } from './format';

/**
 * Instrument cluster readouts: pure logic, no React. Every readout names a platform
 * message and signal (and, where defs has one, its validity signal); ranges and units
 * come from the DBC, never from this file. A name missing from the loaded catalog gives
 * state `not_in_defs`, so a defs rename shows up instead of silently emptying the view.
 *
 * There is no gear readout on purpose: neither bus carries a gear signal (gear_estimate
 * is a derived D-070 signal that is only logged to the SD card).
 */

export type ReadoutState = 'ok' | 'invalid' | 'stale' | 'no_data' | 'not_in_defs';

/** How the validity signal says "valid": any non-zero raw value, or one of these value-table names. */
export type ValidWhen = 'nonzero' | readonly string[];

export interface ReadoutSpec {
  /** Stable id used by the view. */
  id: string;
  label: string;
  message: string;
  signal: string;
  /** `number` is shown as a physical value; `enum` as its value-table name. */
  kind: 'number' | 'enum';
  /** Validity signal of the same message, where defs has one. */
  valid?: { signal: string; when: ValidWhen };
  /** Decimals for display only. */
  digits?: number;
}

const FLAG: ValidWhen = 'nonzero';

export const READOUTS: readonly ReadoutSpec[] = [
  { id: 'rpm', label: 'engine speed', message: 'VehicleEngine', signal: 'ENGINE_SPEED', kind: 'number', valid: { signal: 'ENGINE_SPEED_VALID', when: FLAG }, digits: 0 },
  { id: 'coolant', label: 'coolant', message: 'VehicleEngine', signal: 'COOLANT_TEMP', kind: 'number', valid: { signal: 'COOLANT_TEMP_VALID', when: FLAG }, digits: 0 },
  { id: 'battery', label: 'battery', message: 'VehicleEngine', signal: 'BATTERY_VOLTAGE', kind: 'number', valid: { signal: 'BATTERY_VOLTAGE_VALID', when: FLAG }, digits: 2 },
  { id: 'throttle', label: 'throttle', message: 'VehicleEngine', signal: 'THROTTLE_POS', kind: 'number', valid: { signal: 'THROTTLE_POS_VALID', when: FLAG }, digits: 0 },
  { id: 'ecu', label: 'ECU', message: 'VehicleEngine', signal: 'ECU_PRESENT', kind: 'enum' },
  { id: 'speed', label: 'speed', message: 'VehicleSpeed', signal: 'VEHICLE_SPEED', kind: 'number', valid: { signal: 'VEHICLE_SPEED_VALID', when: FLAG }, digits: 0 },
  { id: 'speedAge', label: 'speed age', message: 'VehicleSpeed', signal: 'VEHICLE_SPEED_AGE', kind: 'number', digits: 0 },
  { id: 'lean', label: 'lean', message: 'EkfLean', signal: 'LEAN_ANGLE', kind: 'number', valid: { signal: 'LEAN_ANGLE_STATE', when: ['ESTIMATED', 'CLAMPED'] }, digits: 1 },
  { id: 'leanState', label: 'lean state', message: 'EkfLean', signal: 'LEAN_ANGLE_STATE', kind: 'enum' },
  { id: 'leanQuality', label: 'lean quality', message: 'EkfLean', signal: 'LEAN_ANGLE_QUALITY', kind: 'number', digits: 0 },
  { id: 'cornering', label: 'cornering', message: 'SafetyWarningStatus', signal: 'CORNERING_LEVEL', kind: 'enum' },
  { id: 'corneringSource', label: 'cornering source', message: 'SafetyWarningStatus', signal: 'CORNERING_SOURCE', kind: 'enum' },
  { id: 'bsmLeft', label: 'blind spot L', message: 'SafetyWarningStatus', signal: 'BSM_LEFT', kind: 'enum' },
  { id: 'bsmRight', label: 'blind spot R', message: 'SafetyWarningStatus', signal: 'BSM_RIGHT', kind: 'enum' },
  { id: 'immobilizer', label: 'immobilizer', message: 'SafetyWarningStatus', signal: 'IMMOBILIZER_STATE', kind: 'enum' },
  { id: 'hbRtCore', label: 'rt-core', message: 'HeartbeatRtCore', signal: 'RT_CORE_NODE_MODE', kind: 'enum' },
  { id: 'hbSafety', label: 'safety', message: 'HeartbeatSafety', signal: 'SAFETY_NODE_MODE', kind: 'enum' },
  { id: 'hbConn', label: 'conn', message: 'HeartbeatConn', signal: 'CONN_NODE_MODE', kind: 'enum' },
  { id: 'hbLinux', label: 'linux', message: 'HeartbeatLinux', signal: 'LINUX_NODE_MODE', kind: 'enum' },
];

export const readoutSpec = (id: string): ReadoutSpec => {
  const s = READOUTS.find((r) => r.id === id);
  if (!s) throw new Error(`unknown cluster readout ${id}`);
  return s;
};

/** What the evaluation needs from the capture; `clusterInput` builds it from a store. */
export interface ClusterInput {
  catalog: readonly DbcMessageDef[];
  /** Latest frame of a platform message id. */
  frameOf: (messageId: number) => CanFrame | undefined;
  dids: readonly DidDef[];
  /** Latest decoded answer of a vehicle DID, `t` in seconds (same time base as `now`). */
  didSample: (name: string) => { value: number | string | null; t: number } | undefined;
  /** Source time in seconds. */
  now: number;
}

export interface Readout {
  spec: ReadoutSpec;
  state: ReadoutState;
  /** Physical value of the latest sample; kept for `stale` so the view can dim it. */
  value: number | null;
  /** Value-table name for enums, formatted number otherwise; '' when there is no sample. */
  text: string;
  unit: string;
  /** DBC range of the signal (null when the signal is not in defs). */
  min: number | null;
  max: number | null;
  /** `platform` or `DID <name>`. */
  source: string;
  /** Short reason for a non-ok state. */
  note?: string;
}

const msgKnown = (catalog: readonly DbcMessageDef[], name: string) => catalog.find((m) => m.name === name);
const sigOf = (m: DbcMessageDef | undefined, name: string): DbcSignalDef | undefined => m?.signals.find((s) => s.name === name);

/**
 * Age limit of a platform message in ms: E2E_TIMEOUT_CYCLES x the DBC cycle time (the
 * analyzer applies the E2E profile's timeout rule to every message as its display policy). Without a cycle time
 * (not periodic, or a custom DBC) 3 x the observed period of the frame; null when
 * neither is known, so the message cannot be called stale.
 */
export function staleLimitMs(msg: DbcMessageDef, frame: CanFrame): number | null {
  if (msg.cycleTimeMs && msg.cycleTimeMs > 0) return E2E_TIMEOUT_CYCLES * msg.cycleTimeMs;
  if (frame.periodMs > 0) return E2E_TIMEOUT_CYCLES * frame.periodMs;
  return null;
}

function validityOk(sig: DbcSignalDef | undefined, when: ValidWhen, v: number | string | undefined): boolean {
  if (typeof v !== 'number') return false;
  if (when === 'nonzero') return v !== 0;
  return when.includes(formatSignal(sig, v));
}

/** Evaluates one readout. Pure: the same input always gives the same result. */
export function evaluateReadout(spec: ReadoutSpec, input: ClusterInput): Readout {
  const msg = msgKnown(input.catalog, spec.message);
  const sig = sigOf(msg, spec.signal);
  const validSig = spec.valid ? sigOf(msg, spec.valid.signal) : undefined;
  const base = {
    spec,
    value: null,
    text: '',
    unit: sig?.unit ?? '',
    min: sig ? sig.min : null,
    max: sig ? sig.max : null,
    source: 'platform',
  };
  if (!msg || !sig || (spec.valid && !validSig)) {
    const what = !msg ? spec.message : !sig ? `${spec.message}.${spec.signal}` : `${spec.message}.${spec.valid!.signal}`;
    return { ...base, state: 'not_in_defs', note: `${what} is not in the loaded defs` };
  }

  const show = (raw: number | string | undefined) => {
    const v = typeof raw === 'number' ? raw : null;
    const text = v === null ? '' : spec.kind === 'enum' ? formatSignal(sig, v) : formatValue(Number(v.toFixed(spec.digits ?? 3)));
    return { value: v, text };
  };

  // 1. The platform frame, when it is fresh and passes its E2E check.
  const frame = input.frameOf(msg.id);
  let unusable: string | undefined;
  if (frame) {
    const limit = staleLimitMs(msg, frame);
    const ageMs = (input.now - frame.timestamp) * 1000;
    if (msg.e2e && (!frame.e2e || !isE2EValid(frame.e2e))) unusable = 'invalid';
    else if (limit !== null && ageMs > limit) unusable = 'stale';
    if (!unusable) {
      const shown = show(frame.decodedSignals?.[spec.signal]);
      if (spec.valid && !validityOk(validSig, spec.valid.when, frame.decodedSignals?.[spec.valid.signal])) {
        const why = spec.valid.when === 'nonzero' ? `${spec.valid.signal} = 0` : `${spec.valid.signal} = ${formatSignal(validSig, frame.decodedSignals?.[spec.valid.signal])}`;
        return { ...base, ...shown, state: 'invalid', note: why };
      }
      return { ...base, ...shown, state: 'ok' };
    }
  }

  // 2. A vehicle DID that rt-core republishes into this signal, while its answer is fresh.
  const ref = `${spec.message}.${spec.signal}`;
  const did = input.dids.find((d) => d.platformSignal === ref);
  const sample = did ? input.didSample(did.name) : undefined;
  if (did && sample && typeof sample.value === 'number' && (input.now - sample.t) * 1000 <= did.staleAfterMs) {
    return { ...base, ...show(sample.value), state: 'ok', source: `DID ${did.name}` };
  }

  // 3. Nothing usable: keep the last platform sample for the view to dim.
  if (frame && unusable === 'invalid') return { ...base, ...show(frame.decodedSignals?.[spec.signal]), state: 'invalid', note: 'E2E check failed' };
  if (frame) return { ...base, ...show(frame.decodedSignals?.[spec.signal]), state: 'stale', note: 'no frame within 3 cycles' };
  return { ...base, state: 'no_data' };
}

/** Evaluates every readout; the result is keyed by `ReadoutSpec.id`. */
export function evaluateCluster(input: ClusterInput): Record<string, Readout> {
  const out: Record<string, Readout> = {};
  for (const spec of READOUTS) out[spec.id] = evaluateReadout(spec, input);
  return out;
}

/**
 * Cluster input from the live capture. Source time is the newest frame's timestamp plus
 * the wall time since it arrived, scaled by `clockRate` (1 = live, the playback speed in a
 * running replay, 0 = paused). So a source that stops sending turns every readout STALE
 * instead of freezing its last values as if they were current.
 */
export function clusterInput(store: CaptureStore, clockRate: number): ClusterInput {
  const sinceLastFrameSec =
    clockRate > 0 && store.lastIngestWallMs > 0 ? ((performance.now() - store.lastIngestWallMs) / 1000) * clockRate : 0;
  return {
    catalog: store.pipeline.catalog('platform'),
    frameOf: (id) => store.framesByKey.get(frameKey('platform', id)),
    dids: store.defs.vehicle.dids,
    didSample: (name) => store.monitor.getDid(name),
    now: store.lastTime + sinceLastFrameSec,
  };
}
