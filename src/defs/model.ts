import { parse as parseYaml } from 'yaml';
import { DbcCatalog } from '../types/can';
import { parseDbc } from '../services/dbcParser';

/**
 * Typed view of the vehicle-defs files the analyzer reads. Everything here is
 * built from the pinned defs copy (external/vehicle-defs); nothing is hard-coded
 * (Invariant 2). The builder takes the file texts so tests can feed fixtures.
 */

export interface DidDef {
  did: number;
  name: string;
  description: string;
  length: number;
  factorNum: number;
  factorDen: number;
  offset: number;
  unit: string;
  min: number;
  max: number;
  pollPeriodMs: number;
  staleAfterMs: number;
  verified: boolean;
  /** `Message.SIGNAL` on the platform bus that rt-core republishes this DID into. */
  platformSignal?: string;
}

export interface IdentificationDid {
  did: number;
  name: string;
  label: string;
  description: string;
  encoding: string;
}

/** A non-DID input of the derived signals (derived/cl250_derived.yaml `sensors`). */
export interface SensorDef {
  name: string;
  unit: string;
  description: string;
  /** Phase 0 source (`ble.<block>.<field>`), or null when there is none. */
  phase0: string | null;
  /** rt-core source (`can.<Message>.<SIGNAL>` or `uds.<DID>.<FIELD>`), or null. */
  rtCore: string | null;
}

export type DerivedClass = 'A' | 'B' | 'C' | 'D';

/** One definition of derived/cl250_derived.yaml `signals` (no formula, D-070). */
export interface DerivedSignalDef {
  name: string;
  class: DerivedClass;
  unit: string;
  description: string;
  inputs: string[];
  pendingInputs: string[];
  window?: string;
  record?: string;
  /** Named codes of an enum signal (defs v0.25.0 `values`), e.g. 0 -> "engaged". */
  values?: Record<number, string>;
}

/** One value inside a multi-value catalog DID (D-068). */
export interface DidFieldDef {
  name: string;
  byte: number;
  size: number;
  bit: number;
  bits: number;
  factorNum: number;
  factorDen: number;
  offset: number;
  unit: string;
  enumNames?: Record<number, string>;
  notUsedRaw?: number;
}

/**
 * A DID the host can decode: a polled vehicle DID or an OBD catalog candidate.
 * `fields` is set only for a multi-value entry.
 */
export interface CatalogDidDef {
  did: number;
  name: string;
  label: string;
  group: string;
  description: string;
  length: number;
  status: 'polled' | 'candidate';
  factorNum: number;
  factorDen: number;
  offset: number;
  unit: string;
  min: number;
  max: number;
  fields?: DidFieldDef[];
}

export interface TesterPolicy {
  allowed: { sid: number; name: string; subfunctions?: number[] }[];
  forbidden: number[];
  forbiddenSubfunctions: { sid: number; subfunctions: number[] }[];
}

export interface VehicleDefs {
  vehicle: string;
  bitrate: number;
  addressing: {
    primary: { requestId: number; responseId: number; extended: boolean };
    fallback?: { requestId: number; responseId: number; extended: boolean; verified: boolean };
    functionalWatchIds: { id: number; extended: boolean }[];
  };
  paddingByte: number;
  flowControl: { flowStatus: number; blockSize: number; stMinMs: number; maxFfDl: number };
  testerPolicy: TesterPolicy;
  session: { startRequest: number[]; testerPresentRequest: number[]; testerPresentPeriodMs: number };
  timing: { responseTimeoutBaseMs: number; responseTimeoutMaxMs: number };
  dtcSnapshot?: { statusMask: number; maxDtcsPerRun: number; snapshotRecord: number; extDataRecord: number; warmIdleWindow?: string };
  dids: DidDef[];
}

export interface DtcSnapshotReport {
  /** Positive SID and sub-function, derived from the service and sub-function names. */
  response: [number, number];
  recordHeaderLength: number;
  identifierLength: number;
  undefinedNumberOfIdentifiers: number;
  legislatedRecordNumber: number;
}

export interface DtcExtDataReport {
  response: [number, number];
  recordHeaderLength: number;
  manufacturerRecords: [number, number];
  obdRecords: [number, number];
}

export interface DtcRecordReports {
  dtcAndStatusLength: number;
  snapshot: DtcSnapshotReport;
  extData: DtcExtDataReport;
}

export interface Iso14229Names {
  services: Map<number, string>;
  positiveResponseOffset: number;
  negativeResponseSid: number;
  suppressPosRspBit: number;
  sessions: Map<number, string>;
  readDtcSubfunctions: Map<number, string>;
  dtcStatusBits: { mask: number; name: string }[];
  nrcs: Map<number, string>;
  p2ResolutionMs: number;
  p2StarResolutionMs: number;
  dtcRecordReports: DtcRecordReports;
}

export type WindowOp = 'lt' | 'le' | 'gt' | 'ge' | 'eq';

export interface HealthWindowDef {
  key: string;
  description: string;
  opensOn: string;
  conditions: { input: string; op: WindowOp; value: number }[];
  stable: { input: string; maxSpread: number }[];
  minDurationMs: number;
  maxDurationMs: number;
  record: string;
  recordDid?: number;
  recordDescription?: string;
}

export interface CorneringLimits {
  kYellow: number;
  kRed: number;
  frictionCoeffDefault: number;
}

export interface Defs {
  /** Tag (or commit) of the pinned vehicle-defs copy. */
  ref: string;
  platform: DbcCatalog;
  vehicleDbc: DbcCatalog;
  vehicle: VehicleDefs;
  identification: IdentificationDid[];
  /**
   * Polled vehicle DIDs plus OBD catalog candidates, by DID. Identification DIDs stay out:
   * they are variable length, so a freeze-frame walk stops at them (D-090).
   */
  catalog: CatalogDidDef[];
  catalogByDid: Map<number, CatalogDidDef>;
  iso: Iso14229Names;
  windows: HealthWindowDef[];
  sensors: SensorDef[];
  derivedSignals: DerivedSignalDef[];
  limits: CorneringLimits;
}

export interface DefsSources {
  ref: string;
  platformDbc: string;
  vehicleDbc: string;
  vehicleYaml: string;
  obdCatalogYaml: string;
  iso14229Yaml: string;
  derivedYaml: string;
  limitsYaml: string;
}

const num = (v: unknown, what: string): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`defs: ${what} is not a number`);
  return v;
};

const byteArray = (v: unknown, what: string): number[] => {
  if (!Array.isArray(v)) throw new Error(`defs: ${what} is not a list`);
  return v.map((x, i) => num(x, `${what}[${i}]`));
};

const text = (v: unknown, what: string): string => {
  if (typeof v !== 'string') throw new Error(`defs: ${what} is not a string`);
  return v;
};

const textList = (v: unknown, what: string): string[] => {
  if (!Array.isArray(v)) throw new Error(`defs: ${what} is not a list`);
  return v.map((x, i) => text(x, `${what}[${i}]`));
};

const nullableSource = (v: unknown, what: string): string | null => {
  if (v === null) return null;
  return text(v, what);
};

type Rec = Record<string, unknown>;

/** A YAML mapping; anything else (scalar, list, null) is a malformed defs file. */
const rec = (v: unknown, what: string): Rec => {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`defs: ${what} is not a mapping`);
  return v as Rec;
};

/** A YAML list. */
const list = (v: unknown, what: string): unknown[] => {
  if (!Array.isArray(v)) throw new Error(`defs: ${what} is not a list`);
  return v;
};

/** A mapping that may be absent (undefined or null reads as empty). */
const optRec = (v: unknown, what: string): Rec => (v === undefined || v === null ? {} : rec(v, what));

/** Child mapping of a mapping. */
const child = (o: Rec, key: string, what: string): Rec => rec(o[key], `${what}.${key}`);

/** Items of a list, each required to be a mapping. */
const recList = (v: unknown, what: string): Rec[] => list(v, what).map((x, i) => rec(x, `${what}[${i}]`));

/** String view of an optional value; `fallback` when it is absent. */
const strOr = (v: unknown, fallback: unknown): string => {
  const x = v ?? fallback;
  if (typeof x === 'string') return x;
  if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint') return String(x);
  return JSON.stringify(x) ?? 'undefined';
};

const idType = (o: Rec): boolean => o.id_type === 'extended_29bit';

function buildVehicle(raw: unknown): VehicleDefs {
  const doc = rec(raw, 'vehicle yaml');
  const addressing = child(doc, 'addressing', 'vehicle');
  const prim = child(addressing, 'primary', 'addressing');
  const fb = addressing.fallback ? rec(addressing.fallback, 'addressing.fallback') : undefined;
  const tp = child(doc, 'tester_policy', 'vehicle');
  const bus = child(doc, 'bus', 'vehicle');
  const transport = child(doc, 'transport', 'vehicle');
  const fc = child(transport, 'flow_control', 'transport');
  const session = child(doc, 'session', 'vehicle');
  const start = child(session, 'start', 'session');
  const testerPresent = child(session, 'tester_present', 'session');
  const timing = child(doc, 'timing', 'vehicle');
  const snap = doc.dtc_snapshot ? rec(doc.dtc_snapshot, 'dtc_snapshot') : undefined;
  return {
    vehicle: String(doc.vehicle),
    bitrate: num(bus.bitrate, 'bus.bitrate'),
    addressing: {
      primary: {
        requestId: num(prim.request_id, 'primary.request_id'),
        responseId: num(prim.response_id, 'primary.response_id'),
        extended: idType(prim),
      },
      fallback: fb
        ? {
            requestId: num(fb.request_id, 'fallback.request_id'),
            responseId: num(fb.response_id, 'fallback.response_id'),
            extended: idType(fb),
            verified: fb.verified === true,
          }
        : undefined,
      functionalWatchIds: recList(optRec(addressing.functional_watch, 'functional_watch').ids ?? [], 'functional_watch.ids').map((x) => ({
        id: num(x.id, 'functional_watch.id'),
        extended: idType(x),
      })),
    },
    paddingByte: num(transport.padding_byte, 'transport.padding_byte'),
    flowControl: {
      flowStatus: num(fc.flow_status, 'flow_status'),
      blockSize: num(fc.block_size, 'block_size'),
      stMinMs: num(fc.st_min_ms, 'st_min_ms'),
      maxFfDl: num(fc.max_ff_dl, 'max_ff_dl'),
    },
    testerPolicy: {
      allowed: recList(tp.allowed, 'tester_policy.allowed').map((a) => ({
        sid: num(a.sid, 'tester_policy.allowed.sid'),
        name: String(a.name),
        subfunctions: a.subfunctions ? byteArray(a.subfunctions, 'subfunctions') : undefined,
      })),
      forbidden: byteArray(tp.forbidden, 'tester_policy.forbidden'),
      forbiddenSubfunctions: recList(tp.forbidden_subfunctions ?? [], 'tester_policy.forbidden_subfunctions').map((f) => ({
        sid: num(f.sid, 'forbidden_subfunctions.sid'),
        subfunctions: byteArray(f.subfunctions, 'forbidden_subfunctions.subfunctions'),
      })),
    },
    session: {
      startRequest: byteArray(start.request, 'session.start.request'),
      testerPresentRequest: byteArray(testerPresent.request, 'session.tester_present.request'),
      testerPresentPeriodMs: num(testerPresent.period_ms, 'tester_present.period_ms'),
    },
    timing: {
      responseTimeoutBaseMs: num(timing.response_timeout_base_ms, 'response_timeout_base_ms'),
      responseTimeoutMaxMs: num(timing.response_timeout_max_ms, 'response_timeout_max_ms'),
    },
    dtcSnapshot: snap
      ? {
          statusMask: num(snap.status_mask, 'dtc_snapshot.status_mask'),
          maxDtcsPerRun: num(snap.max_dtcs_per_run, 'dtc_snapshot.max_dtcs_per_run'),
          snapshotRecord: num(snap.snapshot_record, 'dtc_snapshot.snapshot_record'),
          extDataRecord: num(snap.ext_data_record, 'dtc_snapshot.ext_data_record'),
          warmIdleWindow: snap.warm_idle_window === undefined ? undefined : text(snap.warm_idle_window, 'dtc_snapshot.warm_idle_window'),
        }
      : undefined,
    dids: recList(doc.dids, 'dids').map((d) => ({
      did: num(d.did, 'did'),
      name: String(d.name),
      description: strOr(d.description, ''),
      length: num(d.length, `${String(d.name)}.length`),
      factorNum: num(d.factor_num, `${String(d.name)}.factor_num`),
      factorDen: num(d.factor_den, `${String(d.name)}.factor_den`),
      offset: num(d.offset, `${String(d.name)}.offset`),
      unit: strOr(d.unit, ''),
      min: num(d.min, `${String(d.name)}.min`),
      max: num(d.max, `${String(d.name)}.max`),
      pollPeriodMs: num(d.poll_period_ms, `${String(d.name)}.poll_period_ms`),
      staleAfterMs: num(d.stale_after_ms, `${String(d.name)}.stale_after_ms`),
      verified: d.verified === true,
      platformSignal: d.platform_signal === undefined || d.platform_signal === null ? undefined : text(d.platform_signal, `${String(d.name)}.platform_signal`),
    })),
  };
}

function buildCatalog(vehicle: VehicleDefs, obdDoc: Rec): CatalogDidDef[] {
  const polledMeta = optRec(obdDoc.polled, 'polled');
  const polled: CatalogDidDef[] = vehicle.dids.map((d) => {
    const meta = polledMeta[d.name] ? rec(polledMeta[d.name], `polled.${d.name}`) : {};
    return {
      did: d.did,
      name: d.name,
      label: strOr(meta.label, d.name),
      group: strOr(meta.group, ''),
      description: d.description,
      length: d.length,
      status: 'polled',
      factorNum: d.factorNum,
      factorDen: d.factorDen,
      offset: d.offset,
      unit: d.unit,
      min: d.min,
      max: d.max,
    };
  });
  const candidates: CatalogDidDef[] = recList(obdDoc.candidates ?? [], 'candidates').map((c) => {
    const cname = String(c.name);
    const length = num(c.length, `${cname}.length`);
    const fields: DidFieldDef[] | undefined = c.fields
      ? recList(c.fields, `${cname}.fields`).map((f, i) => {
          const what = `${cname}.fields[${i}]`;
          const size = num(f.size ?? 1, `${what}.size`);
          return {
            name: String(f.name),
            byte: num(f.byte, `${what}.byte`),
            size,
            bit: num(f.bit ?? 0, `${what}.bit`),
            bits: num(f.bits ?? 8 * size, `${what}.bits`),
            factorNum: num(f.factor_num, `${what}.factor_num`),
            factorDen: num(f.factor_den, `${what}.factor_den`),
            offset: num(f.offset, `${what}.offset`),
            unit: String(f.unit),
            enumNames: f.enum
              ? Object.fromEntries(Object.entries(rec(f.enum, `${what}.enum`)).map(([raw, name]) => [Number(raw), String(name)]))
              : undefined,
            notUsedRaw: f.not_used_raw === undefined || f.not_used_raw === null ? undefined : num(f.not_used_raw, `${what}.not_used_raw`),
          };
        })
      : undefined;
    // A multi-value entry has no formula of its own: like the defs codegen, its scalar
    // columns are the neutral raw view. A scalar entry must carry all of them.
    const scalar = fields
      ? { factorNum: 1, factorDen: 1, offset: 0, unit: '', min: 0, max: 2 ** (8 * length) - 1 }
      : {
          factorNum: num(c.factor_num, `${cname}.factor_num`),
          factorDen: num(c.factor_den, `${cname}.factor_den`),
          offset: num(c.offset, `${cname}.offset`),
          unit: String(c.unit),
          min: num(c.min, `${cname}.min`),
          max: num(c.max, `${cname}.max`),
        };
    return {
      did: num(c.did, 'candidate.did'),
      name: cname,
      label: strOr(c.label, c.name),
      group: strOr(c.group, ''),
      description: strOr(c.description, ''),
      length,
      status: 'candidate',
      ...scalar,
      fields,
    };
  });
  return [...polled, ...candidates].sort((a, b) => a.did - b.did);
}

function buildIso(raw: unknown): Iso14229Names {
  const doc = rec(raw, 'iso14229 yaml');
  const toMap = (items: Rec[], key: string) => new Map<number, string>(items.map((x) => [num(x[key], key), String(x.name)]));
  const serviceList = recList(doc.services, 'services');
  const subfunctionList = recList(doc.read_dtc_subfunctions, 'read_dtc_subfunctions');
  const services = toMap(serviceList, 'sid');
  const readDtcSubfunctions = toMap(subfunctionList, 'id');
  const positiveResponseOffset = num(doc.positive_response_offset, 'positive_response_offset');
  const dtcService = serviceList.find((s) => s.name === 'READ_DTC_INFORMATION');
  if (!dtcService) throw new Error('defs: READ_DTC_INFORMATION service not found');
  const subfunctionId = (name: string): number => {
    const found = subfunctionList.find((s) => s.name === name);
    if (!found) throw new Error(`defs: DTC sub-function ${name} not found`);
    return num(found.id, `${name}.id`);
  };
  const reports = child(doc, 'dtc_record_reports', 'iso14229');
  const snapshot = child(reports, 'snapshot', 'dtc_record_reports');
  const extData = child(reports, 'ext_data', 'dtc_record_reports');
  const sid = num(dtcService.sid, 'READ_DTC_INFORMATION.sid') + positiveResponseOffset;
  const pair = (name: unknown): [number, number] => [sid, subfunctionId(text(name, 'dtc_record_reports.subfunction'))];
  const range = (v: unknown, what: string): [number, number] => {
    const items = list(v, what);
    return [num(items[0], `${what}[0]`), num(items[1], `${what}[1]`)];
  };
  return {
    services,
    positiveResponseOffset,
    negativeResponseSid: num(doc.negative_response_sid, 'negative_response_sid'),
    suppressPosRspBit: num(doc.suppress_pos_rsp_bit, 'suppress_pos_rsp_bit'),
    sessions: toMap(recList(doc.sessions, 'sessions'), 'id'),
    readDtcSubfunctions,
    dtcStatusBits: recList(doc.dtc_status_bits, 'dtc_status_bits').map((b) => ({ mask: num(b.mask, 'mask'), name: String(b.name) })),
    nrcs: toMap(recList(doc.nrcs, 'nrcs'), 'nrc'),
    p2ResolutionMs: num(doc.p2_resolution_ms, 'p2_resolution_ms'),
    p2StarResolutionMs: num(doc.p2_star_resolution_ms, 'p2_star_resolution_ms'),
    dtcRecordReports: {
      dtcAndStatusLength: num(reports.dtc_and_status_length, 'dtc_and_status_length'),
      snapshot: {
        response: pair(snapshot.subfunction),
        recordHeaderLength: num(snapshot.record_header_length, 'snapshot.record_header_length'),
        identifierLength: num(snapshot.identifier_length, 'snapshot.identifier_length'),
        undefinedNumberOfIdentifiers: num(snapshot.undefined_number_of_identifiers, 'snapshot.undefined_number_of_identifiers'),
        legislatedRecordNumber: num(snapshot.legislated_record_number, 'snapshot.legislated_record_number'),
      },
      extData: {
        response: pair(extData.subfunction),
        recordHeaderLength: num(extData.record_header_length, 'ext_data.record_header_length'),
        manufacturerRecords: range(extData.manufacturer_records, 'manufacturer_records'),
        obdRecords: range(extData.obd_records, 'obd_records'),
      },
    },
  };
}

function buildWindows(doc: Rec): HealthWindowDef[] {
  const records = optRec(doc.ride_summary_records, 'ride_summary_records');
  return Object.entries(optRec(doc.windows, 'windows')).map(([key, raw]) => {
    const w = rec(raw, `windows.${key}`);
    const record = String(w.record);
    const recordMeta = records[record] ? rec(records[record], `ride_summary_records.${record}`) : undefined;
    return {
      key,
      description: strOr(w.description, ''),
      opensOn: String(w.opens_on),
      conditions: recList(w.conditions ?? [], `${key}.conditions`).map((c) => ({
        input: String(c.input),
        op: c.op as WindowOp,
        value: num(c.value, `${key}.value`),
      })),
      stable: recList(w.stable ?? [], `${key}.stable`).map((s) => ({ input: String(s.input), maxSpread: num(s.max_spread, `${key}.max_spread`) })),
      minDurationMs: num(w.min_duration_ms, `${key}.min_duration_ms`),
      maxDurationMs: num(w.max_duration_ms, `${key}.max_duration_ms`),
      record,
      recordDid: recordMeta?.did === undefined ? undefined : num(recordMeta.did, `${record}.did`),
      recordDescription: recordMeta?.description === undefined ? undefined : text(recordMeta.description, `${record}.description`),
    };
  });
}

function buildSensors(doc: Rec): SensorDef[] {
  return Object.entries(optRec(doc.sensors, 'sensors')).map(([name, raw]) => {
    const s = rec(raw, `sensors.${name}`);
    return {
      name,
      unit: text(s.unit, `${name}.unit`),
      description: text(s.description, `${name}.description`),
      phase0: nullableSource(s.phase0, `${name}.phase0`),
      rtCore: nullableSource(s.rt_core, `${name}.rt_core`),
    };
  });
}

/** `{code: name}` of a derived enum signal; the codes are integers (codegen checks the range). */
function enumValues(raw: unknown, where: string): Record<number, string> {
  const out: Record<number, string> = {};
  for (const [code, label] of Object.entries(rec(raw, where))) {
    const n = Number(code);
    if (!Number.isInteger(n)) throw new Error(`defs: ${where} code ${code} is not an integer`);
    out[n] = text(label, `${where}.${code}`);
  }
  return out;
}

function buildDerivedSignals(doc: Rec): DerivedSignalDef[] {
  const classes: DerivedClass[] = ['A', 'B', 'C', 'D'];
  return Object.entries(optRec(doc.signals, 'signals')).map(([name, raw]) => {
    const s = rec(raw, `signals.${name}`);
    const signalClass = text(s.class, `${name}.class`) as DerivedClass;
    if (!classes.includes(signalClass)) throw new Error(`defs: ${name}.class is not A, B, C or D`);
    return {
      name,
      class: signalClass,
      unit: text(s.unit, `${name}.unit`),
      description: text(s.description, `${name}.description`),
      inputs: textList(s.inputs, `${name}.inputs`),
      pendingInputs: s.pending_inputs === undefined ? [] : textList(s.pending_inputs, `${name}.pending_inputs`),
      window: s.window === undefined || s.window === null ? undefined : text(s.window, `${name}.window`),
      record: s.record === undefined || s.record === null ? undefined : text(s.record, `${name}.record`),
      values: s.values === undefined || s.values === null ? undefined : enumValues(s.values, `${name}.values`),
    };
  });
}

function buildLimits(doc: unknown): CorneringLimits {
  const find = (name: string): number => {
    // The limits file groups values in sections; search them for the key.
    const stack: unknown[] = [doc];
    while (stack.length) {
      const o = stack.pop();
      if (o && typeof o === 'object') {
        const entry = (o as Rec)[name];
        if (entry && typeof entry === 'object' && 'value' in entry) return num((entry as Rec).value, name);
        Object.values(o).forEach((v) => stack.push(v));
      }
    }
    throw new Error(`defs: limits ${name} not found`);
  };
  return { kYellow: find('k_yellow'), kRed: find('k_red'), frictionCoeffDefault: find('friction_coeff_default') };
}

export function buildDefs(src: DefsSources): Defs {
  const obd = rec(parseYaml(src.obdCatalogYaml), 'obd catalog yaml');
  const vehicle = buildVehicle(parseYaml(src.vehicleYaml));
  const catalog = buildCatalog(vehicle, obd);
  const derived = rec(parseYaml(src.derivedYaml), 'derived yaml');
  return {
    ref: src.ref,
    platform: parseDbc(src.platformDbc),
    vehicleDbc: parseDbc(src.vehicleDbc),
    vehicle,
    identification: recList(obd.identification ?? [], 'identification').map((x) => ({
      did: num(x.did, 'identification.did'),
      name: String(x.name),
      label: strOr(x.label, x.name),
      description: strOr(x.description, ''),
      encoding: strOr(x.encoding, 'ascii'),
    })),
    catalog,
    catalogByDid: new Map(catalog.map((d) => [d.did, d])),
    iso: buildIso(parseYaml(src.iso14229Yaml)),
    windows: buildWindows(derived),
    sensors: buildSensors(derived),
    derivedSignals: buildDerivedSignals(derived),
    limits: buildLimits(parseYaml(src.limitsYaml)),
  };
}

/** Physical value of a DID answer: big-endian raw * factor_num / factor_den + offset. */
export function decodeDid(def: Pick<DidDef, 'length' | 'factorNum' | 'factorDen' | 'offset'>, bytes: number[]): number | null {
  if (bytes.length < def.length) return null;
  let raw = 0;
  for (let i = 0; i < def.length; i++) raw = raw * 256 + bytes[i];
  return (raw * def.factorNum) / def.factorDen + def.offset;
}

/** Inverse of decodeDid, saturated to the DID length (simulator only). */
export function encodeDid(def: DidDef, physical: number): number[] {
  const maxRaw = 256 ** def.length - 1;
  let raw = Math.round(((physical - def.offset) * def.factorDen) / def.factorNum);
  raw = Math.max(0, Math.min(maxRaw, Number.isFinite(raw) ? raw : 0));
  const out: number[] = [];
  for (let i = def.length - 1; i >= 0; i--) {
    out[i] = raw % 256;
    raw = Math.floor(raw / 256);
  }
  return out;
}
