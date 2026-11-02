import type { RidesColumn, RidesRow } from './sessionClient';

export type RideHistoryAxis = 'order' | 'time';

export interface RideChartPoint {
  sessionId: string;
  createdUtc: string | null;
  x: number | null;
  value: number | null;
  flag: string | null;
}

export interface MappedRidePoint extends RideChartPoint {
  px: number;
  py: number;
}

export const MAX_HISTORY_COLUMNS = 4;

/** Keeps only columns the response actually has, preserving the caller's order. */
export function selectedColumns(columns: RidesColumn[], names: string[], max = MAX_HISTORY_COLUMNS): string[] {
  const available = new Set(columns.map((column) => column.name));
  return names.filter((name) => available.has(name)).slice(0, max);
}

/** Defaults to the first response column; never invents a signal name. */
export function defaultColumns(columns: RidesColumn[]): string[] {
  return columns.slice(0, 1).map((column) => column.name);
}

export function toggleColumn(names: string[], name: string, max = MAX_HISTORY_COLUMNS): string[] {
  if (names.includes(name)) return names.length <= 1 ? names : names.filter((value) => value !== name);
  if (names.length >= max) return names;
  return [...names, name];
}

export function chartPoints(rows: RidesRow[], name: string, axis: RideHistoryAxis): RideChartPoint[] {
  return rows.map((row, index) => {
    const date = axis === 'time' && row.createdUtc !== null ? Date.parse(row.createdUtc) : Number.NaN;
    return {
      sessionId: row.sessionId,
      createdUtc: row.createdUtc,
      x: axis === 'order' ? index : Number.isFinite(date) ? date : null,
      value: row.values[name] ?? null,
      flag: row.flags[name] ?? null,
    };
  });
}

/** Runs of points with both x and value; a null in either breaks the line. */
export function lineRuns(points: RideChartPoint[]): RideChartPoint[][] {
  const runs: RideChartPoint[][] = [];
  let run: RideChartPoint[] = [];
  for (const point of points) {
    if (point.x === null || point.value === null || !Number.isFinite(point.x) || !Number.isFinite(point.value)) {
      if (run.length > 0) runs.push(run);
      run = [];
      continue;
    }
    run.push(point);
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

export function xDomain(points: RideChartPoint[]): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (const point of points) {
    if (point.x === null || !Number.isFinite(point.x)) continue;
    if (point.x < lo) lo = point.x;
    if (point.x > hi) hi = point.x;
  }
  if (lo > hi) return [0, 1];
  if (lo === hi) return [lo - 1, hi + 1];
  return [lo, hi];
}

export function yDomain(points: RideChartPoint[]): [number, number] | null {
  let lo = Infinity;
  let hi = -Infinity;
  for (const point of points) {
    if (point.value === null || !Number.isFinite(point.value)) continue;
    if (point.value < lo) lo = point.value;
    if (point.value > hi) hi = point.value;
  }
  if (lo > hi) return null;
  if (lo === hi) {
    const pad = Math.abs(lo) * 0.05 || 1;
    return [lo - pad, hi + pad];
  }
  const pad = (hi - lo) * 0.05;
  return [lo - pad, hi + pad];
}

export function mapPoints(points: RideChartPoint[], xd: [number, number], yd: [number, number], width: number, height: number, pad = 6): MappedRidePoint[] {
  const innerW = Math.max(1, width - pad * 2);
  const innerH = Math.max(1, height - pad * 2);
  return points
    .filter((point): point is RideChartPoint & { x: number; value: number } => point.x !== null && point.value !== null && Number.isFinite(point.x) && Number.isFinite(point.value))
    .map((point) => ({
      ...point,
      px: pad + ((point.x - xd[0]) / (xd[1] - xd[0] || 1)) * innerW,
      py: height - pad - ((point.value - yd[0]) / (yd[1] - yd[0] || 1)) * innerH,
    }));
}

export function pointText(point: RideChartPoint, unit: string, domain: [number, number]): string {
  if (point.value === null) return `${point.sessionId} · – ${unit}`;
  const span = Math.abs(domain[1] - domain[0]);
  const decimals = Math.min(6, Math.max(0, 4 - Math.floor(Math.log10(span || 1))));
  return `${point.sessionId} · ${point.value.toFixed(decimals)} ${unit}`;
}

export function columnUnit(columns: RidesColumn[], name: string): string {
  return columns.find((column) => column.name === name)?.unit ?? '';
}

