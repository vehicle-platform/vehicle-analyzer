import { z } from 'zod';
import { finite, isRecord, nonEmptyStr, parseItems, parseStrict, str } from './restCommon';

/** Wire schemas of GET /sessions, /sessions/{id}/series and /sessions/{id}/report (vehicle-server api.py). */

export type SeriesKind = 'did' | 'sensor' | 'derived';

/** One series; a length mismatch, a non-number or an unknown kind makes the series invalid. */
export const RecordedSeriesSchema = z
  .object({
    name: nonEmptyStr,
    kind: z.enum(['did', 'sensor', 'derived'], { error: 'is an unknown kind' }),
    unit: z.string().catch(''),
    points_total: finite.optional().catch(undefined),
    downsampled: z.boolean().catch(false),
    t_ms: z.array(finite, { error: 'is not a list of finite numbers' }),
    v: z.array(finite, { error: 'is not a list of finite numbers' }),
  })
  .refine((s) => s.t_ms.length === s.v.length, { path: ['v'], error: 'has a different length than t_ms' })
  .transform((s) => ({
    /** Server name, e.g. "did.ENGINE_SPEED". */
    name: s.name,
    kind: s.kind,
    unit: s.unit,
    pointsTotal: s.points_total ?? s.v.length,
    downsampled: s.downsampled,
    /** Milliseconds since t0_device_ms. */
    tMs: s.t_ms,
    v: s.v,
  }));
export type RecordedSeries = z.output<typeof RecordedSeriesSchema>;

export interface SeriesResponse {
  sessionId: string;
  t0DeviceMs: number;
  maxPoints: number;
  series: RecordedSeries[];
  /** Series the schema refused (dropped, not thrown); 0 for a clean response. */
  rejected: number;
}

const SeriesRootSchema = z.object({
  session_id: z.string().catch(''),
  t0_device_ms: z.number().catch(0),
  max_points: z.number().catch(0),
  series: z.array(z.unknown()).optional().catch(undefined),
});

/**
 * Lenient on purpose: invalid series are dropped and counted (`rejected`), a garbage root reads as
 * an empty response with `rejected: 1`. Never throws.
 */
export function parseSeriesResponse(json: unknown): SeriesResponse {
  const root = SeriesRootSchema.safeParse(json);
  if (!root.success) return { sessionId: '', t0DeviceMs: 0, maxPoints: 0, series: [], rejected: 1 };
  const { items, rejected } = parseItems(RecordedSeriesSchema, root.data.series ?? []);
  return {
    sessionId: root.data.session_id,
    t0DeviceMs: root.data.t0_device_ms,
    maxPoints: root.data.max_points,
    series: items,
    // A missing or non-list `series` is one rejected "list" unless the key is simply absent.
    rejected: rejected + (root.data.series === undefined && isRecord(json) && 'series' in json ? 1 : 0),
  };
}

/** One row of GET /sessions: only `session_id` is required (a number is accepted and stringified), the rest is kept as sent. */
export const SessionRowSchema = z.looseObject({
  session_id: z.union([z.string(), z.number()]).transform(String),
});
export type SessionRow = z.output<typeof SessionRowSchema> & Record<string, unknown>;

export interface SessionListResult {
  rows: SessionRow[];
  /** Rows without a session_id (dropped, not thrown); a root that is not a list counts as 1. */
  rejected: number;
}

export function parseSessionListResult(json: unknown): SessionListResult {
  const list = Array.isArray(json) ? json : isRecord(json) && Array.isArray(json.sessions) ? json.sessions : null;
  if (list === null) return { rows: [], rejected: 1 };
  const { items, rejected } = parseItems(SessionRowSchema, list);
  return { rows: items as SessionRow[], rejected };
}

/** Rows only; see `parseSessionListResult` for the drop count. */
export function parseSessionList(json: unknown): SessionRow[] {
  return parseSessionListResult(json).rows;
}

/** GET /sessions/{id}/report is the session's report.json: an object whose fields are shown, never re-computed. */
export const ReportSchema = z.record(str, z.unknown(), { error: 'is not an object' });
export type Report = z.output<typeof ReportSchema>;

export function parseReport(json: unknown): Report {
  return parseStrict(ReportSchema, json, 'session report');
}
