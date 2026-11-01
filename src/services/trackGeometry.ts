/**
 * Pure geometry for the relative dead-reckoned track view (roadmap A7a). Coordinates are
 * metres relative to the first usable GNSS sample: +x east, +y north. The screen is
 * y-down, so the view flips y; one metre east and one metre north are always the same
 * number of pixels (no stretch).
 */

export interface TrackBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

/** screenX = x * scale + tx; screenY = -y * scale + ty. */
export interface TrackView {
  scale: number;
  tx: number;
  ty: number;
}

export interface ScreenPoint {
  x: number;
  y: number;
}

export interface TrackSegmentLike {
  tMs: number[];
  xM: number[];
  yM: number[];
}

export interface NearestPoint {
  segmentIndex: number;
  pointIndex: number;
  x: number;
  y: number;
  tMs: number;
}

export interface NearestScreenPoint extends NearestPoint {
  distancePx: number;
}

export const MIN_VIEW_SCALE = 0.01;
export const MAX_VIEW_SCALE = 1000;
export const TRACK_PALETTE = [
  '#2f6f9f',
  '#3d8bb8',
  '#52a7c9',
  '#6cc3d2',
  '#8ad8d2',
  '#a9e5c4',
  '#c8edaa',
  '#e5ee8a',
  '#f4e06d',
  '#f7c65a',
  '#f5a64e',
  '#ef8548',
  '#e6664b',
  '#d84a55',
  '#c33366',
  '#a82478',
] as const;
export const TRACK_NEUTRAL = '#6b7280';

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const finite = (n: number) => Number.isFinite(n);

/** Bounding box of every point in every segment, or null when there is no point. */
export function boundsOfSegments(segments: readonly TrackSegmentLike[]): TrackBounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let any = false;
  for (const segment of segments) {
    const n = Math.min(segment.xM.length, segment.yM.length);
    for (let i = 0; i < n; i++) {
      const x = segment.xM[i];
      const y = segment.yM[i];
      if (!finite(x) || !finite(y)) continue;
      any = true;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return any ? { minX, minY, maxX, maxY } : null;
}

/** Aspect-preserving fit with north up, centred in the canvas; degenerate spans are handled. */
export function fitView(bounds: TrackBounds, width: number, height: number, padding = 24): TrackView {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const pad = clamp(finite(padding) ? padding : 0, 0, Math.min(w, h) / 2 - 0.5);
  const availW = Math.max(1, w - 2 * pad);
  const availH = Math.max(1, h - 2 * pad);
  const spanX = Math.max(0, bounds.maxX - bounds.minX);
  const spanY = Math.max(0, bounds.maxY - bounds.minY);
  let scale: number;
  if (spanX === 0 && spanY === 0) scale = 1;
  else if (spanX === 0) scale = availH / spanY;
  else if (spanY === 0) scale = availW / spanX;
  else scale = Math.min(availW / spanX, availH / spanY);
  scale = clamp(scale, MIN_VIEW_SCALE, MAX_VIEW_SCALE);
  const cx = (bounds.minX + bounds.maxX) / 2;
  const cy = (bounds.minY + bounds.maxY) / 2;
  return { scale, tx: w / 2 - cx * scale, ty: h / 2 + cy * scale };
}

export function worldToScreen(view: TrackView, x: number, y: number): ScreenPoint {
  return { x: x * view.scale + view.tx, y: -y * view.scale + view.ty };
}

export function screenToWorld(view: TrackView, px: number, py: number): ScreenPoint {
  return { x: (px - view.tx) / view.scale, y: (view.ty - py) / view.scale };
}

/** Zoom about a screen point: the world point under the cursor stays fixed. */
export function zoomAt(view: TrackView, px: number, py: number, factor: number): TrackView {
  const world = screenToWorld(view, px, py);
  const scale = clamp(view.scale * (finite(factor) && factor > 0 ? factor : 1), MIN_VIEW_SCALE, MAX_VIEW_SCALE);
  return { scale, tx: px - world.x * scale, ty: py + world.y * scale };
}

/** Pan in screen pixels (positive dx moves the track right). */
export function panView(view: TrackView, dx: number, dy: number): TrackView {
  return { ...view, tx: view.tx + (finite(dx) ? dx : 0), ty: view.ty + (finite(dy) ? dy : 0) };
}

/** Nearest point to a replay time; null outside a segment or inside a gap. */
export function nearestByTime(segments: readonly TrackSegmentLike[], tMs: number): NearestPoint | null {
  if (segments.length === 0 || !finite(tMs)) return null;
  let lo = 0;
  let hi = segments.length - 1;
  let candidate = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const times = segments[mid].tMs;
    const last = times.length > 0 ? times[times.length - 1] : -Infinity;
    if (last >= tMs) {
      candidate = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (candidate < 0) return null;
  const segment = segments[candidate];
  const times = segment.tMs;
  if (times.length === 0 || tMs < times[0]) return null;
  let left = 0;
  let right = times.length - 1;
  while (left < right) {
    const mid = (left + right) >> 1;
    if (times[mid] < tMs) left = mid + 1;
    else right = mid;
  }
  let index = left;
  if (index > 0 && Math.abs(times[index - 1] - tMs) <= Math.abs(times[index] - tMs)) index -= 1;
  return {
    segmentIndex: candidate,
    pointIndex: index,
    x: segment.xM[index] ?? 0,
    y: segment.yM[index] ?? 0,
    tMs: times[index],
  };
}

/** Nearest point to a canvas pixel, within maxPx; null when nothing is close enough. */
export function nearestByScreen(
  segments: readonly TrackSegmentLike[],
  view: TrackView,
  px: number,
  py: number,
  maxPx: number
): NearestScreenPoint | null {
  const limit = finite(maxPx) && maxPx >= 0 ? maxPx : 0;
  let best: NearestScreenPoint | null = null;
  let bestSq = limit * limit;
  for (let s = 0; s < segments.length; s++) {
    const segment = segments[s];
    const n = Math.min(segment.xM.length, segment.yM.length, segment.tMs.length);
    for (let i = 0; i < n; i++) {
      const screen = worldToScreen(view, segment.xM[i], segment.yM[i]);
      const dx = screen.x - px;
      const dy = screen.y - py;
      const sq = dx * dx + dy * dy;
      if (sq <= bestSq) {
        bestSq = sq;
        best = {
          segmentIndex: s,
          pointIndex: i,
          x: segment.xM[i],
          y: segment.yM[i],
          tMs: segment.tMs[i],
          distancePx: Math.sqrt(sq),
        };
      }
    }
  }
  return best;
}

export interface TrackColorScale {
  min: number;
  max: number;
  bins: number;
  neutral: string;
  colors: string[];
  /** Bin 0..bins-1 for a finite value, null for a null/non-finite value. */
  binOf(value: number | null): number | null;
  colorOf(value: number | null): string;
}

const samplePalette = (bins: number): string[] => {
  if (bins === TRACK_PALETTE.length) return [...TRACK_PALETTE];
  if (bins <= 1) return [TRACK_PALETTE[Math.floor(TRACK_PALETTE.length / 2)]];
  return Array.from({ length: bins }, (_, i) => {
    const at = Math.round((i * (TRACK_PALETTE.length - 1)) / (bins - 1));
    return TRACK_PALETTE[at];
  });
};

/** Sequential bins over the finite colour values; nulls use a neutral "no data" colour. */
export function colorScale(values: readonly (number | null)[], bins = 16): TrackColorScale {
  const count = Math.max(1, Math.floor(finite(bins) ? bins : 16));
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value === null || !finite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const empty = min === Infinity;
  if (empty) {
    min = 0;
    max = 0;
  }
  const constant = min === max;
  const colors = samplePalette(count);
  const binOf = (value: number | null): number | null => {
    if (value === null || !finite(value)) return null;
    if (constant) return Math.floor((count - 1) / 2);
    const raw = Math.floor(((value - min) / (max - min)) * count);
    return clamp(raw, 0, count - 1);
  };
  return {
    min,
    max,
    bins: count,
    neutral: TRACK_NEUTRAL,
    colors,
    binOf,
    colorOf: (value) => {
      const bin = binOf(value);
      return bin === null ? TRACK_NEUTRAL : colors[bin];
    },
  };
}

export interface ScaleBar {
  meters: number;
  px: number;
  label: string;
}

/** A 1/2/5 × 10^k metre bar, normally 60..150 px long. */
export function scaleBar(view: TrackView): ScaleBar {
  if (!finite(view.scale) || view.scale <= 0) return { meters: 0, px: 0, label: '0 m' };
  const target = 100 / view.scale;
  const exponent = Math.floor(Math.log10(target));
  let best: ScaleBar | null = null;
  for (let e = exponent - 1; e <= exponent + 1; e++) {
    for (const factor of [1, 2, 5]) {
      const meters = factor * 10 ** e;
      const px = meters * view.scale;
      if (px < 60 || px > 150) continue;
      if (best === null || Math.abs(px - 100) < Math.abs(best.px - 100)) best = { meters, px, label: formatDistance(meters) };
    }
  }
  if (best !== null) return best;
  // Extremely large/small scales: keep the 1/2/5 rule even outside the preferred width.
  let meters = 1;
  outer: for (let e = -12; e <= 12; e++) {
    for (const factor of [1, 2, 5]) {
      const candidate = factor * 10 ** e;
      if (candidate * view.scale >= 60) {
        meters = candidate;
        break outer;
      }
    }
  }
  return { meters, px: meters * view.scale, label: formatDistance(meters) };
}

export function formatDistance(meters: number): string {
  if (!finite(meters) || meters <= 0) return '0 m';
  if (meters >= 1000) return `${Number((meters / 1000).toPrecision(3))} km`;
  if (meters < 1) return `${Number(meters.toPrecision(3))} m`;
  return `${Number(meters.toPrecision(3))} m`;
}
