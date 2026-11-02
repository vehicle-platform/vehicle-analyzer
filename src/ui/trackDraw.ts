import { themeColor } from './theme';
import type { TrackResponse } from '../services/trackClient';
import { colorScale, nearestByTime, scaleBar, worldToScreen, type TrackView } from '../services/trackGeometry';

export const valuesForColor = (track: TrackResponse): (number | null)[] => {
  const out: (number | null)[] = [];
  for (const segment of track.segments) {
    if (track.color) out.push(...(segment.colorV ?? segment.speedMps.map(() => null)));
    else out.push(...segment.speedMps);
  }
  return out;
};

/** Sizes the canvas bitmap to its CSS box times the device pixel ratio; the context draws in CSS pixels. */
export const prepareCanvas = (canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; width: number; height: number } | null => {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof Path2D === 'undefined') return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, width: rect.width, height: rect.height };
};

/**
 * The polyline (coloured by the track's colour scale, or one `stroke` colour) plus the start
 * (circle) and end (square) markers of every segment.
 */
export const drawTrackLayer = (ctx: CanvasRenderingContext2D, track: TrackResponse, view: TrackView, stroke?: string) => {
  const scale = colorScale(stroke ? [] : valuesForColor(track), 16);
  const binFor = (value: number | null) => (stroke ? null : scale.binOf(value));
  const paths = new Map<number, Path2D>();
  const pathFor = (bin: number | null) => {
    const key = bin ?? -1;
    let path = paths.get(key);
    if (!path) {
      path = new Path2D();
      paths.set(key, path);
    }
    return path;
  };

  for (const segment of track.segments) {
    const n = Math.min(segment.tMs.length, segment.xM.length, segment.yM.length, segment.speedMps.length);
    if (n === 0) continue;
    let previous = worldToScreen(view, segment.xM[0], segment.yM[0]);
    let previousBin = binFor(track.color ? (segment.colorV?.[0] ?? null) : segment.speedMps[0]);
    const first = pathFor(previousBin);
    first.moveTo(previous.x, previous.y);
    for (let i = 1; i < n; i++) {
      const point = worldToScreen(view, segment.xM[i], segment.yM[i]);
      const bin = binFor(track.color ? (segment.colorV?.[i] ?? null) : segment.speedMps[i]);
      const path = pathFor(bin);
      if (bin !== previousBin) path.moveTo(previous.x, previous.y);
      path.lineTo(point.x, point.y);
      previous = point;
      previousBin = bin;
    }
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  for (const [key, path] of paths) {
    ctx.strokeStyle = stroke ?? (key < 0 ? scale.neutral : scale.colors[key]);
    ctx.stroke(path);
  }

  for (const segment of track.segments) {
    if (segment.xM.length === 0) continue;
    const start = worldToScreen(view, segment.xM[0], segment.yM[0]);
    const end = worldToScreen(view, segment.xM[segment.xM.length - 1], segment.yM[segment.yM.length - 1]);
    ctx.fillStyle = stroke ?? themeColor('hi');
    ctx.beginPath();
    ctx.arc(start.x, start.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = stroke ?? themeColor('amber');
    ctx.fillRect(end.x - 3, end.y - 3, 6, 6);
  }
};

/** One track with its replay cursor (null: none), north arrow and scale bar. */
export const drawTrack = (canvas: HTMLCanvasElement, track: TrackResponse, view: TrackView, replayTimeSec: number | null, theme: string) => {
  const prepared = prepareCanvas(canvas);
  if (!prepared) return;
  const { ctx } = prepared;
  const rect = { width: prepared.width, height: prepared.height };
  drawTrackLayer(ctx, track, view);

  // Replay cursor (null outside a segment or inside a gap, or when the replay is another session).
  const cursor = replayTimeSec === null ? null : nearestByTime(track.segments, replayTimeSec * 1000);
  if (cursor) {
    const at = worldToScreen(view, cursor.x, cursor.y);
    ctx.strokeStyle = themeColor('red');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(at.x - 10, at.y);
    ctx.lineTo(at.x + 10, at.y);
    ctx.moveTo(at.x, at.y - 10);
    ctx.lineTo(at.x, at.y + 10);
    ctx.stroke();
  }

  // North arrow and scale bar.
  const arrowX = rect.width - 28;
  const arrowY = 28;
  ctx.strokeStyle = themeColor('dim');
  ctx.fillStyle = themeColor('dim');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY + 14);
  ctx.lineTo(arrowX, arrowY - 10);
  ctx.moveTo(arrowX - 4, arrowY - 5);
  ctx.lineTo(arrowX, arrowY - 12);
  ctx.lineTo(arrowX + 4, arrowY - 5);
  ctx.stroke();
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', arrowX, arrowY + 27);

  const bar = scaleBar(view);
  if (bar.px > 0) {
    const x0 = 18;
    const y0 = rect.height - 22;
    ctx.strokeStyle = themeColor('fg');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + bar.px, y0);
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0 + 4);
    ctx.moveTo(x0 + bar.px, y0 - 4);
    ctx.lineTo(x0 + bar.px, y0 + 4);
    ctx.stroke();
    ctx.fillStyle = themeColor('dim');
    ctx.textAlign = 'left';
    ctx.fillText(bar.label, x0, y0 - 7);
  }

  // `theme` is read through themeColor; the argument keeps the redraw dependency explicit.
  void theme;
};

