import { buildRequest, getJson, readDetail, type BuiltRequest, type FetchLike } from './restHttp';
import { isRecord } from './schemas/restCommon';
import { parseBringupResult, type BringupGate, type BringupResult } from './schemas/bringup';
import { parseReport, parseSeriesResponse, parseSessionListResult, type Report, type SeriesResponse, type SessionListResult, type SessionRow } from './schemas/session';
import { parseRideSummary, parseRidesResponse, type RideSummary, type RidesResponse } from './schemas/summary';

/**
 * Read-only HTTP client for recorded vehicle-server sessions (roadmap A3). The API token goes in
 * the Authorization header only, never in a URL or query string.
 *
 * The response shapes live in `schemas/` as zod schemas (WEB-3) and the types are re-exported
 * from here, so importers keep using this module. A response that does not match its schema
 * throws a `RestSchemaError`; a list that can fail item by item drops and counts the bad items.
 */

export { buildRequest, describeHttpError, getJson } from './restHttp';
export type { BuiltRequest, FetchLike } from './restHttp';
export { RestSchemaError, isRecord } from './schemas/restCommon';
export { BRINGUP_GATES, parseBringupResult } from './schemas/bringup';
export type { BringupCheck, BringupGate, BringupResult, BringupStatus, BringupVerdict } from './schemas/bringup';
export { parseReport, parseSeriesResponse, parseSessionList, parseSessionListResult } from './schemas/session';
export type { RecordedSeries, Report, SeriesKind, SeriesResponse, SessionListResult, SessionRow } from './schemas/session';
export { parseRideSummary, parseRidesResponse } from './schemas/summary';
export type {
  PerGearSummary,
  PerGearValue,
  RideSummary,
  RideSummaryAxis,
  RideSummaryBinned,
  RideSummaryCell,
  RideSummaryRange,
  RideSummaryScalar,
  RideSummarySignal,
  RideSummaryStatus,
  RideSummaryUnavailable,
  RidesColumn,
  RidesResponse,
  RidesRow,
} from './schemas/summary';
export { mapSeriesKey } from './seriesKeys';
export type { MappedSeries } from './seriesKeys';

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

/** The server has no GET /sessions/{id}/bringup route (a vehicle-server older than LR12). */
export class BringupUnsupportedError extends Error {
  constructor() {
    super('this server has no bring-up check (needs vehicle-server with LR12)');
    this.name = 'BringupUnsupportedError';
  }
}

export class NoRideSummaryError extends Error {
  constructor() {
    super('No stored ride summary for this session.');
    this.name = 'NoRideSummaryError';
  }
}

export const DEFAULT_SERVER_URL = 'http://localhost:8000';
export const DEFAULT_MAX_POINTS = 2000;

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

export const sessionsRequest = (base: string, token: string) => buildRequest(base, token, '/sessions');
export const reportRequest = (base: string, token: string, id: string) => buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/report`);
export const seriesRequest = (base: string, token: string, id: string, q: SeriesQuery = {}) =>
  buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/series`, {
    signals: q.signals && q.signals.length > 0 ? q.signals.join(',') : undefined,
    max_points: q.maxPoints ?? DEFAULT_MAX_POINTS,
    from_ms: q.fromMs,
    to_ms: q.toMs,
  });

export const rideSummaryRequest = (base: string, token: string, id: string): BuiltRequest =>
  buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/summary`);

export const ridesRequest = (base: string, token: string, q: RidesQuery = {}): BuiltRequest =>
  buildRequest(base, token, '/rides', {
    from: q.from,
    to: q.to,
    names: q.names && q.names.length > 0 ? q.names.join(',') : undefined,
  });

export const bringupRequest = (base: string, token: string, id: string, gate: BringupGate): BuiltRequest =>
  buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/bringup`, { gate });

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

/** Compact text of a measured value: null = "—", object = key=value pairs, nested objects as short JSON. */
export function formatBringupMeasured(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return String(Math.round(value * 10000) / 10000);
  if (typeof value === 'string' || typeof value === 'boolean') return String(value);
  if (isRecord(value)) {
    return Object.entries(value)
      .map(([k, v]) => `${k}=${typeof v === 'object' && v !== null ? JSON.stringify(v) : formatBringupMeasured(v)}`)
      .join(' ');
  }
  return JSON.stringify(value);
}

/**
 * Reads the server's bring-up gate check. A 404 whose detail is just "Not Found" means the route
 * is missing (older server); "unknown session: <id>" stays a normal error.
 */
export async function fetchBringup(cfg: RideClientConfig, sessionId: string, gate: BringupGate): Promise<BringupResult> {
  const json = await getJson(bringupRequest(cfg.serverUrl, cfg.token, sessionId, gate), cfg.fetchFn ?? defaultFetch, async (res) => {
    if (res.status === 404 && (await readDetail(res)).trim().toLowerCase() === 'not found') throw new BringupUnsupportedError();
  });
  return parseBringupResult(json);
}

export class SessionClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchFn: FetchLike = (u, i) => fetch(u, i)
  ) {}

  /** Rows plus how many entries the schema refused (dropped, not thrown). */
  public async listSessionsChecked(): Promise<SessionListResult> {
    return parseSessionListResult(await getJson(sessionsRequest(this.baseUrl, this.token), this.fetchFn));
  }

  public async listSessions(): Promise<SessionRow[]> {
    return (await this.listSessionsChecked()).rows;
  }

  public async getReport(id: string): Promise<Report> {
    return parseReport(await getJson(reportRequest(this.baseUrl, this.token, id), this.fetchFn));
  }

  public async getSeries(id: string, q: SeriesQuery = {}): Promise<SeriesResponse> {
    return parseSeriesResponse(await getJson(seriesRequest(this.baseUrl, this.token, id, q), this.fetchFn));
  }

  public async getRideSummary(id: string): Promise<RideSummary> {
    return fetchRideSummary({ serverUrl: this.baseUrl, token: this.token, fetchFn: this.fetchFn }, id);
  }

  public async getBringup(id: string, gate: BringupGate): Promise<BringupResult> {
    return fetchBringup({ serverUrl: this.baseUrl, token: this.token, fetchFn: this.fetchFn }, id, gate);
  }

  public async getRides(q: RidesQuery = {}): Promise<RidesResponse> {
    return fetchRides({ serverUrl: this.baseUrl, token: this.token, fetchFn: this.fetchFn }, q);
  }
}

