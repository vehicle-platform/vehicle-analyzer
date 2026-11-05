import type { PerGearSummary, RecordedSeries, RideSummary, RideSummaryRange, RideSummarySignal, SeriesResponse } from './sessionClient';

/**
 * Session comparison (roadmap A4): two recorded vehicle-server sessions on a common time or
 * distance axis, overlay and difference (B - A) per channel. Pure functions, no React.
 *
 * Value used: the points of the series response as they are. The server downsamples with
 * min/max bucketing and returns real samples (the minimum and maximum of each bucket, in
 * time order), not bucket means or midpoints, so no value is invented here; between two
 * returned samples we interpolate linearly. Spikes survive, which is what a ride
 * comparison needs.
 */

export type CompareAxis = 'time' | 'distance';

/** Server name of the cumulative distance channel (defs: derived/cl250_derived.yaml `trip_distance`, km). */
export const DISTANCE_CHANNEL = 'derived.trip_distance';
/** Unit of the distance axis. */
export const DISTANCE_UNIT = 'km';
/** Default number of grid points of the common axis. */
export const DEFAULT_GRID_POINTS = 500;
/**
 * A segment between two consecutive samples is a gap when it is longer than this many
 * times the median sample spacing of that series; the grid is null across a gap.
 */
export const GAP_FACTOR = 5;

/** One session's data for one channel. Times are ms since the session's own t0. */
export interface SessionChannel {
  sessionId: string;
  /** Server channel name, e.g. "did.ENGINE_SPEED". */
  channel: string;
  unit: string;
  tMs: number[];
  v: number[];
  /** Cumulative trip distance (km) over time, when the session has `derived.trip_distance`. */
  distance?: { tMs: number[]; km: number[] };
}

export interface CompareResult {
  axis: CompareAxis;
  /** Axis unit: "s" or "km". */
  axisUnit: string;
  channel: string;
  unit: string;
  sessionA: string;
  sessionB: string;
  x: number[];
  a: (number | null)[];
  b: (number | null)[];
  /** B - A, null where either side is null. */
  diff: (number | null)[];
}

// ------------------------------------------------------------------ guards

/** Position channels are never compared or exported (D-076): latitude / longitude and short forms. */
export function isPositionChannel(name: string): boolean {
  return /latitude|longitude|(^|[._:\s-])(lat|lon|lng)($|[._:\s-])/i.test(name);
}

// ------------------------------------------------------------------ interpolation

/** Ascending, finite, strictly increasing x (the first of equal x wins); drops other points. */
export function cleanSeries(x: number[], v: number[]): { x: number[]; v: number[] } {
  const ox: number[] = [];
  const ov: number[] = [];
  const n = Math.min(x.length, v.length);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(v[i])) continue;
    if (ox.length > 0 && x[i] <= ox[ox.length - 1]) continue;
    ox.push(x[i]);
    ov.push(v[i]);
  }
  return { x: ox, v: ov };
}

/** Median of the positive spacings of an ascending x (Infinity when there is no spacing). */
function medianSpacing(x: number[]): number {
  const d: number[] = [];
  for (let i = 1; i < x.length; i++) d.push(x[i] - x[i - 1]);
  if (d.length === 0) return Infinity;
  d.sort((p, q) => p - q);
  const m = d.length >> 1;
  return d.length % 2 ? d[m] : (d[m - 1] + d[m]) / 2;
}

/**
 * Linear interpolation of (x, v) at each grid point. Null outside [x0, xN] (no
 * extrapolation) and inside a segment longer than gapFactor x the median spacing. `x` must
 * be strictly increasing (see cleanSeries); `grid` must be ascending.
 */
export function resample(x: number[], v: number[], grid: number[], gapFactor = GAP_FACTOR): (number | null)[] {
  const out: (number | null)[] = new Array<number | null>(grid.length).fill(null);
  const n = Math.min(x.length, v.length);
  if (n === 0) return out;
  const maxGap = gapFactor * medianSpacing(x.slice(0, n));
  let i = 0;
  for (let k = 0; k < grid.length; k++) {
    const g = grid[k];
    if (g < x[0] || g > x[n - 1]) continue;
    while (i + 1 < n && x[i + 1] < g) i++;
    // x[i] <= g <= x[i + 1] here, except at i = 0 when g == x[0]
    if (x[i] === g) {
      out[k] = v[i];
      continue;
    }
    if (i + 1 >= n) continue;
    if (x[i + 1] === g) {
      out[k] = v[i + 1];
      continue;
    }
    if (x[i + 1] - x[i] > maxGap) continue;
    const f = (g - x[i]) / (x[i + 1] - x[i]);
    out[k] = v[i] + f * (v[i + 1] - v[i]);
  }
  return out;
}

/** Uniform grid of `points` values over [lo, hi]; empty when the range is empty or reversed. */
export function makeGrid(lo: number, hi: number, points = DEFAULT_GRID_POINTS): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi < lo || points < 1) return [];
  if (hi === lo || points === 1) return [lo];
  const g: number[] = new Array<number>(points);
  for (let i = 0; i < points; i++) g[i] = lo + ((hi - lo) * i) / (points - 1);
  g[points - 1] = hi;
  return g;
}

// ------------------------------------------------------------------ axes

/** x (axis units) and values of one session's channel on the chosen axis. */
function onAxis(s: SessionChannel, axis: CompareAxis): { x: number[]; v: number[] } | null {
  if (axis === 'time') return cleanSeries(s.tMs.map((ms) => ms / 1000), s.v);
  if (!s.distance) return null;
  // Distance at each sample time, from the trip-distance series (no extrapolation, no
  // interpolation across its gaps). Stationary samples share one distance: first wins.
  const d = cleanSeries(s.distance.tMs, s.distance.km);
  const sig = cleanSeries(s.tMs, s.v);
  const km = resample(d.x, d.v, sig.x);
  const x: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < km.length; i++) {
    const k = km[i];
    if (k !== null) {
      x.push(k);
      v.push(sig.v[i]);
    }
  }
  return cleanSeries(x, v);
}

/** Whether both sessions can be compared per distance, and why not otherwise. */
export function distanceAvailability(a: SessionChannel | null, b: SessionChannel | null): { ok: boolean; reason: string } {
  if (!a || !b) return { ok: false, reason: 'Pick two sessions first.' };
  const missing = [a, b].filter((s) => !s.distance || s.distance.tMs.length < 2).map((s) => s.sessionId);
  if (missing.length > 0) return { ok: false, reason: `No ${DISTANCE_CHANNEL} channel in ${missing.join(', ')}.` };
  return { ok: true, reason: '' };
}

// ------------------------------------------------------------------ compare

/** The tMs->km pair of the trip-distance series of a response, if present with the expected unit. */
function distanceOf(res: SeriesResponse): SessionChannel['distance'] {
  const d = res.series.find((s) => s.name === DISTANCE_CHANNEL && s.unit === DISTANCE_UNIT);
  return d ? { tMs: d.tMs, km: d.v } : undefined;
}

/** Builds a SessionChannel from a series response; null when the channel is absent. Refuses position channels. */
export function sessionChannel(res: SeriesResponse, sessionId: string, channel: string): SessionChannel | null {
  if (isPositionChannel(channel)) throw new Error(`Position channel "${channel}" is never compared or exported.`);
  const s = res.series.find((x) => x.name === channel);
  if (!s) return null;
  return { sessionId, channel, unit: s.unit, tMs: s.tMs, v: s.v, distance: distanceOf(res) };
}

/** Channels present in both responses with the same unit, sorted; position channels excluded. */
export function commonChannels(a: RecordedSeries[], b: RecordedSeries[]): string[] {
  const bUnits = new Map(b.map((s) => [s.name, s.unit]));
  return a
    .filter((s) => !isPositionChannel(s.name) && bUnits.get(s.name) === s.unit)
    .map((s) => s.name)
    .sort();
}

/**
 * Resamples A and B onto one grid over the overlap of their ranges on the chosen axis and
 * returns A, B and B - A. Throws for a position channel, different channels or units, or an
 * unavailable distance axis. No overlap gives empty arrays.
 */
export function compareSessions(
  a: SessionChannel,
  b: SessionChannel,
  axis: CompareAxis,
  points = DEFAULT_GRID_POINTS,
  gapFactor = GAP_FACTOR
): CompareResult {
  if (isPositionChannel(a.channel) || isPositionChannel(b.channel)) throw new Error('Position channels are never compared or exported.');
  if (a.channel !== b.channel) throw new Error(`Different channels cannot be compared (${a.channel} vs ${b.channel}).`);
  if (a.unit !== b.unit) throw new Error(`Units differ for ${a.channel} ("${a.unit}" vs "${b.unit}").`);
  if (axis === 'distance') {
    const av = distanceAvailability(a, b);
    if (!av.ok) throw new Error(av.reason);
  }
  const pa = onAxis(a, axis);
  const pb = onAxis(b, axis);
  const base = { axis, axisUnit: axis === 'time' ? 's' : DISTANCE_UNIT, channel: a.channel, unit: a.unit, sessionA: a.sessionId, sessionB: b.sessionId };
  if (!pa || !pb || pa.x.length === 0 || pb.x.length === 0) return { ...base, x: [], a: [], b: [], diff: [] };
  const lo = Math.max(pa.x[0], pb.x[0]);
  const hi = Math.min(pa.x[pa.x.length - 1], pb.x[pb.x.length - 1]);
  const x = makeGrid(lo, hi, points);
  const ra = resample(pa.x, pa.v, x, gapFactor);
  const rb = resample(pb.x, pb.v, x, gapFactor);
  const diff = ra.map((va, i) => {
    const vb = rb[i];
    return va === null || vb === null ? null : vb - va;
  });
  return { ...base, x, a: ra, b: rb, diff };
}


export interface RideSummaryCompareRow {
  name: string;
  unit: string;
  range: RideSummaryRange;
  aStatus: string;
  bStatus: string;
  aValue: number | null;
  bValue: number | null;
  diff: number | null;
}

const scalarValue = (signal: RideSummary['signals'][number]): number | null =>
  signal.status === 'computed' && signal.kind === 'scalar' ? signal.value : null;

const scalarRange = (signal: RideSummary['signals'][number]): RideSummaryRange | null =>
  signal.status === 'computed' && signal.kind === 'scalar' ? signal.range : null;

const scalarUnit = (signal: RideSummary['signals'][number]): string =>
  signal.status === 'computed' && signal.kind === 'scalar' ? signal.unit : '';

const perGear = (signal: RideSummarySignal): signal is PerGearSummary =>
  signal.status === 'computed' && signal.kind === 'per_gear';

const mergedRange = (rangeA: RideSummaryRange | null, rangeB: RideSummaryRange | null): RideSummaryRange => {
  const ranges = [rangeA, rangeB].filter((range): range is RideSummaryRange => range !== null);
  return ranges.length ? [Math.min(...ranges.map((r) => r[0])), Math.max(...ranges.map((r) => r[1]))] : [0, 1];
};

const mergedUnit = (unitA: string, unitB: string): string =>
  unitA && unitB && unitA !== unitB ? `${unitA} / ${unitB}` : unitA || unitB;

/**
 * One row per gear stored in A or B (`<signal> gear n`, gear order). A gear stored on one side
 * only reads as a missing value there; the server lists stored gears only and infers none.
 */
function perGearRows(signalA: RideSummarySignal, signalB: RideSummarySignal): RideSummaryCompareRow[] {
  const sideA = perGear(signalA) ? signalA : null;
  const sideB = perGear(signalB) ? signalB : null;
  const valuesA = new Map(sideA?.gears.map((entry) => [entry.gear, entry.value] as const) ?? []);
  const valuesB = new Map(sideB?.gears.map((entry) => [entry.gear, entry.value] as const) ?? []);
  const range = mergedRange(sideA?.range ?? null, sideB?.range ?? null);
  const unit = mergedUnit(sideA?.unit ?? '', sideB?.unit ?? '');
  const gears = [...new Set([...valuesA.keys(), ...valuesB.keys()])].sort((x, y) => x - y);
  return gears.map((gear) => {
    const aValue = valuesA.get(gear) ?? null;
    const bValue = valuesB.get(gear) ?? null;
    return {
      name: `${signalA.name} gear ${gear}`,
      unit,
      range,
      aStatus: sideA ? 'computed' : signalA.status,
      bStatus: sideB ? 'computed' : signalB.status,
      aValue,
      bValue,
      diff: aValue !== null && bValue !== null ? bValue - aValue : null,
    };
  });
}

/** Summary rows present in both sessions; statuses replace values where not computed. */
export function compareRideSummaries(a: RideSummary | null, b: RideSummary | null): RideSummaryCompareRow[] {
  if (!a || !b) return [];
  const byName = new Map(b.signals.map((signal) => [signal.name, signal]));
  const rows: RideSummaryCompareRow[] = [];
  for (const signalA of a.signals) {
    const signalB = byName.get(signalA.name);
    if (!signalB) continue;
    if (signalA.status === 'computed' && signalA.kind === 'binned') continue;
    if (signalB.status === 'computed' && signalB.kind === 'binned') continue;
    if (perGear(signalA) || perGear(signalB)) {
      rows.push(...perGearRows(signalA, signalB));
      continue;
    }
    const aValue = scalarValue(signalA);
    const bValue = scalarValue(signalB);
    const range = mergedRange(scalarRange(signalA), scalarRange(signalB));
    const unit = mergedUnit(scalarUnit(signalA), scalarUnit(signalB));
    rows.push({
      name: signalA.name,
      unit,
      range,
      aStatus: signalA.status,
      bStatus: signalB.status,
      aValue,
      bValue,
      diff: aValue !== null && bValue !== null ? bValue - aValue : null,
    });
  }
  return rows;
}

// ------------------------------------------------------------------ export and drawing

const num = (n: number | null): string => (n === null ? '' : String(Number(n.toFixed(6))));
const oneLine = (s: string): string => s.replace(/[\r\n]+/g, ' ');

/**
 * CSV of a comparison: one `#` comment line (session ids, channel, unit, axis), then
 * `axis,A,B,B_minus_A`. Null values are empty cells. Session ids only, never a position.
 */
export function compareToCsv(r: CompareResult, summaries: RideSummaryCompareRow[] = []): string {
  if (isPositionChannel(r.channel)) throw new Error('Position channels are never compared or exported.');
  const axisName = r.axis === 'time' ? 'time (s since session start)' : 'distance (km, derived.trip_distance)';
  const lines = [`# A=${oneLine(r.sessionA)}; B=${oneLine(r.sessionB)}; channel=${oneLine(r.channel)}; unit=${oneLine(r.unit)}; axis=${axisName}`, 'axis,A,B,B_minus_A'];
  for (let i = 0; i < r.x.length; i++) lines.push([num(r.x[i]), num(r.a[i]), num(r.b[i]), num(r.diff[i])].join(','));
  if (summaries.length > 0) {
    lines.push(`# ride summaries; A=${oneLine(r.sessionA)}; B=${oneLine(r.sessionB)}`, 'name,A,B,B_minus_A,unit');
    const cell = (value: number | null, status: string): string => (value !== null ? num(value) : status === 'computed' ? '' : oneLine(status));
    for (const row of summaries) {
      lines.push([oneLine(row.name), cell(row.aValue, row.aStatus), cell(row.bValue, row.bStatus), num(row.diff), oneLine(row.unit)].join(','));
    }
  }
  return lines.join('\n') + '\n';
}

/** Pixel polylines for a trace: one point list per run of non-null values (nulls break the line). */
export function polylines(x: number[], y: (number | null)[], xr: [number, number], yr: [number, number], w: number, h: number): [number, number][][] {
  const runs: [number, number][][] = [];
  let cur: [number, number][] = [];
  const sx = xr[1] > xr[0] ? w / (xr[1] - xr[0]) : 0;
  const sy = yr[1] > yr[0] ? h / (yr[1] - yr[0]) : 0;
  for (let i = 0; i < x.length; i++) {
    const v = y[i];
    if (v === null) {
      if (cur.length) runs.push(cur);
      cur = [];
      continue;
    }
    cur.push([(x[i] - xr[0]) * sx, h - (v - yr[0]) * sy]);
  }
  if (cur.length) runs.push(cur);
  return runs;
}

/** [min, max] over the non-null values of several traces; null when there are none. */
export function valueRange(...traces: (number | null)[][]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const t of traces) for (const v of t) if (v !== null) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return lo > hi ? null : [lo, hi];
}
