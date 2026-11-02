import { didKey } from './pipeline';

/**
 * Read-only HTTP client for recorded vehicle-server sessions (roadmap A3). The API token goes in
 * the Authorization header only, never in a URL or query string.
 */

export type SeriesKind = 'did' | 'sensor' | 'derived';

export interface RecordedSeries {
  /** Server name, e.g. "did.ENGINE_SPEED". */
  name: string;
  kind: SeriesKind;
  unit: string;
  pointsTotal: number;
  downsampled: boolean;
  /** Milliseconds since t0_device_ms. */
  tMs: number[];
  v: number[];
}

export interface SeriesResponse {
  sessionId: string;
  t0DeviceMs: number;
  maxPoints: number;
  series: RecordedSeries[];
}

/** One row of GET /sessions: loosely typed, only `session_id` is required. */
export type SessionRow = { session_id: string } & Record<string, unknown>;

export type RideSummaryStatus = 'computed' | 'not_ready' | 'not_implemented' | 'missing_inputs' | 'error';
export type RideSummaryRange = [number, number];

export interface RideSummaryAxis {
  input: string;
  unit: string;
  edges: RideSummaryRange[];
}

export interface RideSummaryCell {
  index: number;
  axes: number[];
  value: number | null;
  flag: string | null;
}

export interface RideSummaryScalar {
  name: string;
  status: 'computed';
  kind: 'scalar';
  unit: string;
  range: RideSummaryRange;
  value: number | null;
  flag: string | null;
}

export interface RideSummaryBinned {
  name: string;
  status: 'computed';
  kind: 'binned';
  unit: string;
  range: RideSummaryRange;
  axes: RideSummaryAxis[];
  cells: RideSummaryCell[];
  totalS: number;
  outsideS: number;
  defsMismatch: boolean;
}

export interface RideSummaryUnavailable {
  name: string;
  status: Exclude<RideSummaryStatus, 'computed'>;
  reason?: string;
  pendingInputs?: string[];
  missing?: string[];
  message?: string;
}

export type RideSummarySignal = RideSummaryScalar | RideSummaryBinned | RideSummaryUnavailable;

export interface RideSummary {
  sessionId: string;
  rideDefinition: string | null;
  defsVersion: string | null;
  signals: RideSummarySignal[];
}

export interface RidesColumn {
  name: string;
  unit: string;
}

export interface RidesRow {
  sessionId: string;
  createdUtc: string | null;
  values: Record<string, number | null>;
  flags: Record<string, string | null>;
}

export interface RidesResponse {
  columns: RidesColumn[];
  rows: RidesRow[];
  skipped: number;
}

export interface RidesQuery {
  from?: string;
  to?: string;
  names?: string[];
}

export interface RideClientConfig {
  serverUrl: string;
  token: string;
  fetchFn?: FetchLike;
}

export class NoRideSummaryError extends Error {
  constructor() {
    super('No stored ride summary for this session.');
    this.name = 'NoRideSummaryError';
  }
}

export const DEFAULT_SERVER_URL = 'http://localhost:8000';
export const DEFAULT_MAX_POINTS = 2000;

const KINDS: readonly SeriesKind[] = ['did', 'sensor', 'derived'];

export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const isNumArray = (x: unknown): x is number[] => Array.isArray(x) && x.every((n) => typeof n === 'number' && Number.isFinite(n));

/** Drops malformed series (length mismatch, non-numbers, unknown kind) instead of throwing. */
export function parseSeriesResponse(json: unknown): SeriesResponse {
  const root = isRecord(json) ? json : {};
  const series: RecordedSeries[] = [];
  if (Array.isArray(root.series)) {
    for (const s of root.series) {
      if (!isRecord(s) || typeof s.name !== 'string' || s.name === '') continue;
      if (typeof s.kind !== 'string' || !(KINDS as readonly string[]).includes(s.kind)) continue;
      if (!isNumArray(s.t_ms) || !isNumArray(s.v) || s.t_ms.length !== s.v.length) continue;
      series.push({
        name: s.name,
        kind: s.kind as SeriesKind,
        unit: typeof s.unit === 'string' ? s.unit : '',
        pointsTotal: typeof s.points_total === 'number' ? s.points_total : s.v.length,
        downsampled: s.downsampled === true,
        tMs: s.t_ms,
        v: s.v,
      });
    }
  }
  return {
    sessionId: typeof root.session_id === 'string' ? root.session_id : '',
    t0DeviceMs: typeof root.t0_device_ms === 'number' ? root.t0_device_ms : 0,
    maxPoints: typeof root.max_points === 'number' ? root.max_points : 0,
    series,
  };
}

/** Defensive parse of GET /sessions: rows without a session_id are dropped. */
export function parseSessionList(json: unknown): SessionRow[] {
  const rows = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.sessions) ? json.sessions : [];
  const out: SessionRow[] = [];
  for (const r of rows) {
    if (isRecord(r) && (typeof r.session_id === 'string' || typeof r.session_id === 'number')) out.push({ ...r, session_id: String(r.session_id) });
  }
  return out;
}

/** A few top-level scalar fields of a report, as "key: value" pairs. Never throws. */
export function summarizeReport(json: unknown, limit = 8): { key: string; value: string }[] {
  if (!isRecord(json)) return [];
  const out: { key: string; value: string }[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (out.length >= limit) break;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push({ key, value: typeof value === 'number' ? String(Math.round(value * 1000) / 1000) : String(value) });
    }
  }
  return out;
}

/** Time/duration-like fields of a session row, for the list (defensive: any may be absent). */
export function sessionRowInfo(row: SessionRow): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(row)) {
    if (k === 'session_id' || typeof v !== 'number' && typeof v !== 'string') continue;
    if (/(time|start|end|date|duration|created|_ms|_s$|_sec)/i.test(k)) parts.push(`${k} ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`);
    if (parts.length >= 2) break;
  }
  return parts.join(' · ');
}

export interface SeriesQuery {
  signals?: string[];
  maxPoints?: number;
  fromMs?: number;
  toMs?: number;
}

export interface BuiltRequest {
  url: string;
  headers: Record<string, string>;
}

const trimBase = (base: string) => base.trim().replace(/\/+$/, '');

/** Builds a request: the token only ever lands in the headers. */
export function buildRequest(baseUrl: string, token: string, path: string, query?: Record<string, string | number | undefined>): BuiltRequest {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) if (v !== undefined && v !== '') params.set(k, String(v));
  const qs = params.toString();
  return {
    url: `${trimBase(baseUrl)}${path}${qs ? `?${qs}` : ''}`,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  };
}

export const sessionsRequest = (base: string, token: string) => buildRequest(base, token, '/sessions');
export const reportRequest = (base: string, token: string, id: string) => buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/report`);
export const seriesRequest = (base: string, token: string, id: string, q: SeriesQuery = {}) =>
  buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/series`, {
    signals: q.signals && q.signals.length > 0 ? q.signals.join(',') : undefined,
    max_points: q.maxPoints ?? DEFAULT_MAX_POINTS,
    from_ms: q.fromMs,
    to_ms: q.toMs,
  });

/** Maps an HTTP failure to a message for the user (the token never appears in it). */
export async function describeHttpError(res: Pick<Response, 'status' | 'statusText' | 'text'>): Promise<string> {
  if (res.status === 401) return 'Unauthorized (401): the API token is missing or wrong.';
  if (res.status === 404) return 'Not found (404): unknown session.';
  if (res.status === 422) {
    let detail = '';
    try {
      const body = JSON.parse(await res.text()) as unknown;
      const d = isRecord(body) ? body.detail : undefined;
      detail = typeof d === 'string' ? d : d === undefined ? '' : JSON.stringify(d);
    } catch {
      // body was not JSON
    }
    return `Rejected (422): ${detail || 'bad signal names or parameters'}`;
  }
  return `Server error (${res.status}${res.statusText ? ` ${res.statusText}` : ''}).`;
}

export type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

/**
 * GET + JSON with the shared error mapping. `onHttpError` runs first on a non-2xx answer, so a
 * caller can turn a specific body (e.g. a 404 detail) into its own error before the generic one.
 */
export async function getJson(req: BuiltRequest, fetchFn: FetchLike, onHttpError?: (res: Response) => Promise<void>): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(req.url, { headers: req.headers });
  } catch {
    throw new Error('Cannot reach the server (network error, wrong URL or CORS).');
  }
  if (!res.ok) {
    await onHttpError?.(res);
    throw new Error(await describeHttpError(res));
  }
  try {
    return await res.json();
  } catch {
    throw new Error('The server answered with something that is not JSON.');
  }
}

const SUMMARY_STATUSES: readonly RideSummaryStatus[] = ['computed', 'not_ready', 'not_implemented', 'missing_inputs', 'error'];
const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const malformedSummary = (why: string): never => {
  throw new Error(`Malformed ride summary: ${why}.`);
};
const malformedRides = (why: string): never => {
  throw new Error(`Malformed rides response: ${why}.`);
};
const finiteRange = (x: unknown): x is RideSummaryRange =>
  Array.isArray(x) && x.length === 2 && finite(x[0]) && finite(x[1]) && x[0] <= x[1];
const stringList = (x: unknown): x is string[] => Array.isArray(x) && x.every((v) => typeof v === 'string');

function parseSummarySignal(raw: unknown): RideSummarySignal {
  if (!isRecord(raw)) return malformedSummary('signal is not an object');
  const { name, status } = raw;
  if (typeof name !== 'string' || name === '') return malformedSummary('signal has no name');
  if (typeof status !== 'string' || !(SUMMARY_STATUSES as readonly string[]).includes(status)) {
    return malformedSummary(`${name} has an unknown status`);
  }
  if (status !== 'computed') {
    const signal: RideSummaryUnavailable = { name, status: status as RideSummaryUnavailable['status'] };
    for (const key of ['reason', 'message'] as const) {
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'string') return malformedSummary(`${name}.${key} is not a string`);
        signal[key] = raw[key];
      }
    }
    for (const key of ['pending_inputs', 'missing'] as const) {
      if (raw[key] !== undefined) {
        if (!stringList(raw[key])) return malformedSummary(`${name}.${key} is not a list of strings`);
        if (key === 'pending_inputs') signal.pendingInputs = raw[key];
        else signal.missing = raw[key];
      }
    }
    return signal;
  }

  if (typeof raw.unit !== 'string') return malformedSummary(`${name}.unit is not a string`);
  if (!finiteRange(raw.range)) return malformedSummary(`${name}.range is not a finite range`);
  const range = raw.range;
  if (raw.kind === 'scalar') {
    const value = raw.value === null ? null : finite(raw.value) ? raw.value : malformedSummary(`${name}.value is not null or a finite number`);
    const flag = raw.flag === null ? null : typeof raw.flag === 'string' ? raw.flag : malformedSummary(`${name}.flag is not null or a string`);
    return { name, status: 'computed', kind: 'scalar', unit: raw.unit, range, value, flag };
  }
  if (raw.kind !== 'binned') return malformedSummary(`${name}.kind is neither scalar nor binned`);

  if (!Array.isArray(raw.axes) || raw.axes.length === 0) return malformedSummary(`${name}.axes is not a non-empty list`);
  const axes: RideSummaryAxis[] = [];
  for (const [index, rawAxis] of raw.axes.entries()) {
    if (!isRecord(rawAxis) || typeof rawAxis.input !== 'string' || rawAxis.input === '' || typeof rawAxis.unit !== 'string') {
      return malformedSummary(`${name}.axes[${index}] is not {input, unit, edges}`);
    }
    if (!Array.isArray(rawAxis.edges) || rawAxis.edges.length === 0 || !rawAxis.edges.every(finiteRange)) {
      return malformedSummary(`${name}.axes[${index}].edges is not a list of finite ranges`);
    }
    axes.push({ input: rawAxis.input, unit: rawAxis.unit, edges: rawAxis.edges });
  }
  if (!Array.isArray(raw.cells)) return malformedSummary(`${name}.cells is not a list`);
  const cells: RideSummaryCell[] = [];
  for (const [cellIndex, rawCell] of raw.cells.entries()) {
    if (!isRecord(rawCell) || !Number.isInteger(rawCell.index) || (rawCell.index as number) < 0) {
      return malformedSummary(`${name}.cells[${cellIndex}] has no valid index`);
    }
    if (!Array.isArray(rawCell.axes) || rawCell.axes.length !== axes.length || !rawCell.axes.every((v) => Number.isInteger(v) && v >= 0)) {
      return malformedSummary(`${name}.cells[${cellIndex}].axes does not match the axes`);
    }
    for (const [axisIndex, binIndex] of rawCell.axes.entries()) {
      if ((binIndex as number) >= axes[axisIndex].edges.length) return malformedSummary(`${name}.cells[${cellIndex}] has an out-of-range bin`);
    }
    const value = rawCell.value === null ? null : finite(rawCell.value) ? rawCell.value : malformedSummary(`${name}.cells[${cellIndex}].value is not null or a finite number`);
    const flag = rawCell.flag === null ? null : typeof rawCell.flag === 'string' ? rawCell.flag : malformedSummary(`${name}.cells[${cellIndex}].flag is not null or a string`);
    cells.push({ index: rawCell.index as number, axes: rawCell.axes as number[], value, flag });
  }
  if (!finite(raw.total_s)) return malformedSummary(`${name}.total_s is not a finite number`);
  if (!finite(raw.outside_s)) return malformedSummary(`${name}.outside_s is not a finite number`);
  if (raw.defs_mismatch !== undefined && typeof raw.defs_mismatch !== 'boolean') {
    return malformedSummary(`${name}.defs_mismatch is not a boolean`);
  }
  return {
    name,
    status: 'computed',
    kind: 'binned',
    unit: raw.unit,
    range,
    axes,
    cells,
    totalS: raw.total_s,
    outsideS: raw.outside_s,
    defsMismatch: raw.defs_mismatch === true,
  };
}

/** Strict parser: a partial or inconsistent summary is rejected instead of drawn wrongly. */
export function parseRideSummary(json: unknown): RideSummary {
  if (!isRecord(json)) return malformedSummary('root is not an object');
  if (typeof json.session_id !== 'string' || json.session_id === '') return malformedSummary('missing session_id');
  if (json.ride_definition !== null && typeof json.ride_definition !== 'string') {
    return malformedSummary('ride_definition is not null or a string');
  }
  if (json.defs_version !== null && typeof json.defs_version !== 'string') {
    return malformedSummary('defs_version is not null or a string');
  }
  if (!Array.isArray(json.signals)) return malformedSummary('signals is not a list');
  return {
    sessionId: json.session_id,
    rideDefinition: json.ride_definition as string | null,
    defsVersion: json.defs_version as string | null,
    signals: json.signals.map(parseSummarySignal),
  };
}

/** Strict parser for GET /rides: every cell must belong to a returned column. */
export function parseRidesResponse(json: unknown): RidesResponse {
  if (!isRecord(json)) return malformedRides('root is not an object');
  if (!Array.isArray(json.columns)) return malformedRides('columns is not a list');
  const columns: RidesColumn[] = [];
  for (const [index, raw] of json.columns.entries()) {
    if (!isRecord(raw) || typeof raw.name !== 'string' || raw.name === '' || typeof raw.unit !== 'string') {
      return malformedRides(`columns[${index}] is not {name, unit}`);
    }
    if (columns.some((c) => c.name === raw.name)) return malformedRides(`duplicate column ${raw.name}`);
    columns.push({ name: raw.name, unit: raw.unit });
  }
  if (!Array.isArray(json.rows)) return malformedRides('rows is not a list');
  const rows: RidesRow[] = [];
  for (const [index, raw] of json.rows.entries()) {
    if (!isRecord(raw) || typeof raw.session_id !== 'string' || raw.session_id === '') {
      return malformedRides(`rows[${index}] has no session_id`);
    }
    if (raw.created_utc !== null && typeof raw.created_utc !== 'string') {
      return malformedRides(`rows[${index}].created_utc is not null or a string`);
    }
    if (!isRecord(raw.values) || !isRecord(raw.flags)) return malformedRides(`rows[${index}] has no values/flags`);
    const values: Record<string, number | null> = {};
    const flags: Record<string, string | null> = {};
    for (const column of columns) {
      const value = raw.values[column.name];
      if (value !== null && !finite(value)) return malformedRides(`rows[${index}].values.${column.name} is not null or a finite number`);
      const flag = raw.flags[column.name];
      if (flag !== null && typeof flag !== 'string') return malformedRides(`rows[${index}].flags.${column.name} is not null or a string`);
      values[column.name] = value;
      flags[column.name] = flag;
    }
    rows.push({ sessionId: raw.session_id, createdUtc: raw.created_utc as string | null, values, flags });
  }
  if (!Number.isInteger(json.skipped) || (json.skipped as number) < 0) return malformedRides('skipped is not a non-negative integer');
  return { columns, rows, skipped: json.skipped as number };
}

export const rideSummaryRequest = (base: string, token: string, id: string): BuiltRequest =>
  buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/summary`);

export const ridesRequest = (base: string, token: string, q: RidesQuery = {}): BuiltRequest =>
  buildRequest(base, token, '/rides', {
    from: q.from,
    to: q.to,
    names: q.names && q.names.length > 0 ? q.names.join(',') : undefined,
  });

async function readDetail(res: Response): Promise<string> {
  try {
    const body = JSON.parse(await res.text()) as unknown;
    return isRecord(body) && typeof body.detail === 'string' ? body.detail : '';
  } catch {
    return '';
  }
}

const defaultFetch: FetchLike = (url, init) => fetch(url, init);

/** Reads the stored summary of one session; `NoRideSummaryError` means there is none. */
export async function fetchRideSummary(cfg: RideClientConfig, sessionId: string): Promise<RideSummary> {
  const json = await getJson(rideSummaryRequest(cfg.serverUrl, cfg.token, sessionId), cfg.fetchFn ?? defaultFetch, async (res) => {
    if (res.status === 404 && (await readDetail(res)) === 'session has no ride summary') throw new NoRideSummaryError();
  });
  return parseRideSummary(json);
}

/** Reads the cross-session scalar table; absent signals stay null with a status flag. */
export async function fetchRides(cfg: RideClientConfig, query: RidesQuery = {}): Promise<RidesResponse> {
  return parseRidesResponse(await getJson(ridesRequest(cfg.serverUrl, cfg.token, query), cfg.fetchFn ?? defaultFetch));
}

export class SessionClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchFn: FetchLike = (u, i) => fetch(u, i)
  ) {}

  public async listSessions(): Promise<SessionRow[]> {
    return parseSessionList(await getJson(sessionsRequest(this.baseUrl, this.token), this.fetchFn));
  }

  public async getReport(id: string): Promise<unknown> {
    return getJson(reportRequest(this.baseUrl, this.token, id), this.fetchFn);
  }

  public async getSeries(id: string, q: SeriesQuery = {}): Promise<SeriesResponse> {
    return parseSeriesResponse(await getJson(seriesRequest(this.baseUrl, this.token, id, q), this.fetchFn));
  }

  public async getRideSummary(id: string): Promise<RideSummary> {
    return fetchRideSummary({ serverUrl: this.baseUrl, token: this.token, fetchFn: this.fetchFn }, id);
  }

  public async getRides(q: RidesQuery = {}): Promise<RidesResponse> {
    return fetchRides({ serverUrl: this.baseUrl, token: this.token, fetchFn: this.fetchFn }, q);
  }
}

// ------------------------------------------------------------ key mapping

/** Where a recorded series lands in the store history. */
export interface MappedSeries {
  key: string;
  /** DIDs take label, unit and range from defs; sensor/derived from the response. */
  fromDefs: boolean;
  group: string;
  label: string;
}

/**
 * did.<NAME> -> the live DID key (so the scope's DID channels and the cluster show the
 * recorded values); sensor.<x> -> "sensor:<x>"; derived.<x> -> "derived:<x>".
 */
export function mapSeriesKey(name: string, kind: SeriesKind): MappedSeries {
  const dot = name.indexOf('.');
  const rest = dot >= 0 ? name.slice(dot + 1) : name;
  if (kind === 'did') return { key: didKey(rest), fromDefs: true, group: 'vehicle DID', label: rest };
  if (kind === 'sensor') return { key: `sensor:${rest}`, fromDefs: false, group: 'session · sensor', label: rest };
  return { key: `derived:${rest}`, fromDefs: false, group: 'session · derived', label: rest };
}
