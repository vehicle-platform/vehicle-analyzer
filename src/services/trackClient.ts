/**
 * Read-only client for GET /sessions/{id}/track (roadmap A7a). The response is relative
 * to the first usable GNSS sample; it never contains an absolute position.
 */

import { buildRequest, describeHttpError, type BuiltRequest } from './sessionClient';

export type TrackMethod = 'dead_reckoning';
export type TrackFrame = 'relative_enu_from_first_fix';

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

export interface TrackQuery {
  maxPoints?: number;
  minHeadingSpeedMps?: number;
  color?: string;
  fromMs?: number;
  toMs?: number;
}

/** The server answered 404 `session has no GPS`; this is a state, not an error. */
export class NoGpsInSessionError extends Error {
  constructor() {
    super('No GPS in this session.');
    this.name = 'NoGpsInSessionError';
  }
}

const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const finiteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const finiteArray = (x: unknown): x is number[] => Array.isArray(x) && x.every(finiteNumber);
const malformed = (why: string): never => {
  throw new Error(`Malformed track response: ${why}.`);
};

export const trackRequest = (base: string, token: string, id: string, q: TrackQuery = {}): BuiltRequest =>
  buildRequest(base, token, `/sessions/${encodeURIComponent(id)}/track`, {
    max_points: q.maxPoints,
    min_heading_speed_mps: q.minHeadingSpeedMps,
    color: q.color,
    from_ms: q.fromMs,
    to_ms: q.toMs,
  });

/** Strict parser: a partial or inconsistent track is rejected instead of drawn wrongly. */
export function parseTrackResponse(json: unknown): TrackResponse {
  if (!isRecord(json)) return malformed('root is not an object');
  if (typeof json.session_id !== 'string' || json.session_id === '') return malformed('missing session_id');
  if (json.method !== 'dead_reckoning') return malformed('unknown method');
  if (json.frame !== 'relative_enu_from_first_fix') return malformed('unknown frame');
  for (const key of ['t0_device_ms', 'max_points', 'points_total', 'path_length_m', 'segments_total']) {
    if (!finiteNumber(json[key])) return malformed(`${key} is not a finite number`);
  }
  if (typeof json.downsampled !== 'boolean') return malformed('downsampled is not a boolean');
  if (!isRecord(json.excluded)) return malformed('missing excluded counters');
  const excluded = json.excluded;
  for (const key of ['no_fix', 'stale_fix', 'untrusted_heading']) {
    if (!finiteNumber(excluded[key])) return malformed(`excluded.${key} is not a finite number`);
  }

  let color: TrackColor | null = null;
  if (json.color !== null) {
    if (
      !isRecord(json.color) ||
      typeof json.color.name !== 'string' ||
      json.color.name === '' ||
      (typeof json.color.unit !== 'string' && json.color.unit !== null)
    ) {
      return malformed('color is neither null nor {name, unit}');
    }
    color = { name: json.color.name, unit: json.color.unit as string | null };
  }

  if (!Array.isArray(json.segments)) return malformed('segments is not a list');
  if (json.segments.length !== json.segments_total) return malformed('segments_total does not match the segments list');
  const segments: TrackSegment[] = [];
  for (const [index, raw] of json.segments.entries()) {
    if (!isRecord(raw)) return malformed(`segment ${index} is not an object`);
    const tMs = raw.t_ms;
    const xM = raw.x_m;
    const yM = raw.y_m;
    const speedMps = raw.speed_mps;
    const headingDeg = raw.heading_deg;
    if (!finiteArray(tMs) || !finiteArray(xM) || !finiteArray(yM) || !finiteArray(speedMps) || !finiteArray(headingDeg)) {
      return malformed(`segment ${index} has a missing or non-finite list`);
    }
    const n = tMs.length;
    if (xM.length !== n || yM.length !== n || speedMps.length !== n || headingDeg.length !== n) {
      return malformed(`segment ${index} lists have different lengths`);
    }
    for (let i = 1; i < n; i++) if (tMs[i] < tMs[i - 1]) return malformed(`segment ${index} times are not sorted`);
    if (raw.gap_before_ms !== null && !finiteNumber(raw.gap_before_ms)) {
      return malformed(`segment ${index} gap_before_ms is not null or a finite number`);
    }

    let colorV: (number | null)[] | null = null;
    if (raw.color_v !== undefined) {
      if (!Array.isArray(raw.color_v) || raw.color_v.length !== n) return malformed(`segment ${index} color_v has a different length`);
      colorV = raw.color_v.map((value) => {
        if (value === null) return null;
        if (!finiteNumber(value)) return malformed(`segment ${index} color_v has a non-finite value`);
        return value;
      });
    } else if (color !== null) {
      return malformed(`segment ${index} has no color_v for the requested colour`);
    }

    segments.push({
      tMs,
      xM,
      yM,
      speedMps,
      headingDeg,
      colorV,
      gapBeforeMs: raw.gap_before_ms as number | null,
    });
  }

  return {
    sessionId: json.session_id,
    t0DeviceMs: json.t0_device_ms as number,
    method: 'dead_reckoning',
    frame: 'relative_enu_from_first_fix',
    maxPoints: json.max_points as number,
    pointsTotal: json.points_total as number,
    downsampled: json.downsampled,
    pathLengthM: json.path_length_m as number,
    segmentsTotal: json.segments_total as number,
    excluded: {
      noFix: excluded.no_fix as number,
      staleFix: excluded.stale_fix as number,
      untrustedHeading: excluded.untrusted_heading as number,
    },
    color,
    segments,
  };
}

type FetchLike = (url: string, init: { headers: Record<string, string> }) => Promise<Response>;

async function readDetail(res: Response): Promise<string> {
  try {
    const body = JSON.parse(await res.text()) as unknown;
    return isRecord(body) && typeof body.detail === 'string' ? body.detail : '';
  } catch {
    return '';
  }
}

export class TrackClient {
  constructor(
    private baseUrl: string,
    private token: string,
    private fetchFn: FetchLike = (u, i) => fetch(u, i)
  ) {}

  public async getTrack(id: string, q: TrackQuery = {}): Promise<TrackResponse> {
    const request = trackRequest(this.baseUrl, this.token, id, q);
    let res: Response;
    try {
      res = await this.fetchFn(request.url, { headers: request.headers });
    } catch {
      throw new Error('Cannot reach the server (network error, wrong URL or CORS).');
    }
    if (!res.ok) {
      if (res.status === 404) {
        const detail = await readDetail(res);
        if (detail === 'session has no GPS') throw new NoGpsInSessionError();
      }
      throw new Error(await describeHttpError(res));
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      throw new Error('The server answered with something that is not JSON.');
    }
    return parseTrackResponse(json);
  }
}
