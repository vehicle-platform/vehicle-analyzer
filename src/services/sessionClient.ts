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
