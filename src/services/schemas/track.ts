import { z } from 'zod';
import { bool, finite, nonEmptyStr, nullableStr, parseStrict } from './restCommon';

/** Wire schema of GET /sessions/{id}/track (vehicle-server api.py). Relative to the first fix, never an absolute position. */

export type TrackMethod = 'dead_reckoning';
export type TrackFrame = 'relative_enu_from_first_fix';

const finiteList = z.array(z.number({ error: 'is non-finite' }), { error: 'is not a list of finite numbers' });
const nullableFiniteGap = z.number({ error: 'is not null or a finite number' }).nullable();

const SegmentWireSchema = z
  .object({
    t_ms: finiteList,
    x_m: finiteList,
    y_m: finiteList,
    speed_mps: finiteList,
    heading_deg: finiteList,
    color_v: z.array(z.number({ error: 'is non-finite' }).nullable(), { error: 'is not a list' }).optional(),
    gap_before_ms: nullableFiniteGap,
  })
  .superRefine((s, ctx) => {
    const n = s.t_ms.length;
    for (const key of ['x_m', 'y_m', 'speed_mps', 'heading_deg'] as const) {
      if (s[key].length !== n) ctx.addIssue({ code: 'custom', path: [key], message: 'list has different lengths than t_ms' });
    }
    if (s.color_v !== undefined && s.color_v.length !== n) {
      ctx.addIssue({ code: 'custom', path: ['color_v'], message: 'has a different length than t_ms' });
    }
    for (let i = 1; i < n; i++) {
      if (s.t_ms[i] < s.t_ms[i - 1]) {
        ctx.addIssue({ code: 'custom', path: ['t_ms'], message: 'times are not sorted' });
        break;
      }
    }
  });

export interface TrackSegment {
  tMs: number[];
  xM: number[];
  yM: number[];
  speedMps: number[];
  headingDeg: number[];
  /** Latest colour sample at each kept point, or null when no colour was requested. */
  colorV: (number | null)[] | null;
  gapBeforeMs: number | null;
}

export interface TrackColor {
  name: string;
  unit: string | null;
}

export interface TrackResponse {
  sessionId: string;
  t0DeviceMs: number;
  method: TrackMethod;
  frame: TrackFrame;
  maxPoints: number;
  pointsTotal: number;
  downsampled: boolean;
  pathLengthM: number;
  segmentsTotal: number;
  excluded: { noFix: number; staleFix: number; untrustedHeading: number };
  color: TrackColor | null;
  segments: TrackSegment[];
}

export const TrackResponseSchema = z
  .object({
    session_id: nonEmptyStr,
    t0_device_ms: finite,
    method: z.literal('dead_reckoning', { error: 'is an unknown method' }),
    frame: z.literal('relative_enu_from_first_fix', { error: 'is an unknown frame' }),
    max_points: finite,
    points_total: finite,
    downsampled: bool,
    path_length_m: finite,
    segments_total: finite,
    excluded: z.object({ no_fix: finite, stale_fix: finite, untrusted_heading: finite }, { error: 'is missing the counters' }),
    color: z.object({ name: nonEmptyStr, unit: nullableStr }, { error: 'is neither null nor {name, unit}' }).nullable(),
    segments: z.array(SegmentWireSchema, { error: 'is not a list' }),
  })
  .superRefine((t, ctx) => {
    if (t.segments.length !== t.segments_total) {
      ctx.addIssue({ code: 'custom', path: ['segments_total'], message: 'does not match the segments list' });
    }
    if (t.color !== null) {
      for (const [i, s] of t.segments.entries()) {
        if (s.color_v === undefined) {
          ctx.addIssue({ code: 'custom', path: ['segments', i, 'color_v'], message: 'is missing for the requested colour' });
        }
      }
    }
  })
  .transform(
    (t): TrackResponse => ({
      sessionId: t.session_id,
      t0DeviceMs: t.t0_device_ms,
      method: t.method,
      frame: t.frame,
      maxPoints: t.max_points,
      pointsTotal: t.points_total,
      downsampled: t.downsampled,
      pathLengthM: t.path_length_m,
      segmentsTotal: t.segments_total,
      excluded: { noFix: t.excluded.no_fix, staleFix: t.excluded.stale_fix, untrustedHeading: t.excluded.untrusted_heading },
      color: t.color,
      segments: t.segments.map((s) => ({
        tMs: s.t_ms,
        xM: s.x_m,
        yM: s.y_m,
        speedMps: s.speed_mps,
        headingDeg: s.heading_deg,
        colorV: s.color_v ?? null,
        gapBeforeMs: s.gap_before_ms,
      })),
    })
  );

/** Strict parser: a partial or inconsistent track is rejected (RestSchemaError) instead of drawn wrongly. */
export function parseTrackResponse(json: unknown): TrackResponse {
  return parseStrict(TrackResponseSchema, json, 'track response');
}
