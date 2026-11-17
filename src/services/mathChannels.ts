/**
 * Math Channels & Telemetry Signal Calculus Service for vehicle-analyzer
 *
 * Provides host-side math channels (derivative, difference, product, ratio)
 * and oscilloscope telemetry export (CSV & branded snapshot).
 */

/**
 * Host-side analysis channels computed from captured series (CANalyzer-style math).
 * They are not platform signals: derived vehicle signals are defined in
 * vehicle-defs (derived/) and computed on rt-core / vehicle-server.
 */
export type MathOp = 'derivative' | 'difference' | 'product' | 'ratio';

export interface MathChannelDef {
  id: string;
  label: string;
  op: MathOp;
  /** History key of input A (e.g. `EkfLean.LEAN_ANGLE` or `DID.ENGINE_SPEED`). */
  a: string;
  /** History key of input B (not used by `derivative`). */
  b?: string;
  scale: number;
  unit: string;
  color: string;
  enabled: boolean;
}

export const MATH_OP_LABEL: Record<MathOp, string> = {
  derivative: 'd(A)/dt',
  difference: 'A − B',
  product: 'A × B',
  ratio: 'A ÷ B',
};

import { csvQuoted } from './csv';
import { SeriesLike, lowerBound } from '../state/ring';

type Series = { time: number; value: number }[];

/** Pairs every A sample with the nearest B sample within `maxGapSec`. */
function align(a: SeriesLike, from: number, b: SeriesLike, maxGapSec: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  if (b.length === 0) return out;
  let j = Math.max(0, lowerBound(b, a.length ? a.timeAt(from) : 0) - 1);
  for (let i = from; i < a.length; i++) {
    const t = a.timeAt(i);
    while (j < b.length - 1 && Math.abs(b.timeAt(j + 1) - t) <= Math.abs(b.timeAt(j) - t)) j++;
    if (Math.abs(b.timeAt(j) - t) <= maxGapSec) out.push([t, a.valueAt(i), b.valueAt(j)]);
  }
  return out;
}

const EMPTY: SeriesLike = { length: 0, timeAt: () => 0, valueAt: () => 0 };

/**
 * Computes a math channel from `fromTime` on; samples farther apart than 1 s are not
 * differentiated, and A/B samples farther apart than 150 ms are not combined.
 */
export function computeMathChannel(def: MathChannelDef, history: Map<string, SeriesLike>, fromTime = -Infinity): Series {
  const a = history.get(def.a) ?? EMPTY;
  const from = lowerBound(a, fromTime);
  if (def.op === 'derivative') {
    const out: Series = [];
    for (let i = Math.max(1, from); i < a.length; i++) {
      const dt = a.timeAt(i) - a.timeAt(i - 1);
      if (dt > 1e-6 && dt < 1.0) out.push({ time: a.timeAt(i), value: ((a.valueAt(i) - a.valueAt(i - 1)) / dt) * def.scale });
    }
    return out;
  }
  const b = def.b ? history.get(def.b) ?? EMPTY : EMPTY;
  return align(a, from, b, 0.15).flatMap(([time, va, vb]) => {
    let v: number;
    if (def.op === 'difference') v = va - vb;
    else if (def.op === 'product') v = va * vb;
    else {
      if (vb === 0) return [];
      v = va / vb;
    }
    return [{ time, value: v * def.scale }];
  });
}

export interface CsvExportChannel {
  name: string;
  label: string;
  unit: string;
  data: { time: number; value: number }[];
}

/**
 * Generates ISO/SAE compliant CSV string for oscilloscope signal series
 */
export function exportOscilloscopeCsv(channels: CsvExportChannel[], minTime?: number, maxTime?: number): string {
  if (channels.length === 0) return 'Time_s\n';

  // Collect all unique timestamps sorted ascending
  const timeSet = new Set<number>();
  channels.forEach((ch) => {
    ch.data.forEach((pt) => {
      if ((minTime === undefined || pt.time >= minTime) && (maxTime === undefined || pt.time <= maxTime)) {
        // Quantize to millisecond (3 decimal places) to avoid floating point jitter
        timeSet.add(Math.round(pt.time * 1000) / 1000);
      }
    });
  });

  const sortedTimes = Array.from(timeSet).sort((a, b) => a - b);

  // Header line
  const headers = ['Time_s', ...channels.map((ch) => csvQuoted(`${ch.label} (${ch.unit})`))];
  const lines: string[] = [headers.join(',')];

  // Map each channel's points by quantized time for quick lookup
  const channelLookup = channels.map((ch) => {
    const map = new Map<number, number>();
    ch.data.forEach((pt) => {
      map.set(Math.round(pt.time * 1000) / 1000, pt.value);
    });
    return map;
  });

  // Track last known values for sample-and-hold interpolation
  const lastKnown = channels.map(() => '');

  for (const t of sortedTimes) {
    const row = [t.toFixed(3)];
    for (let c = 0; c < channels.length; c++) {
      const val = channelLookup[c].get(t);
      if (val !== undefined) {
        lastKnown[c] = val.toString();
        row.push(val.toString());
      } else {
        // Sample-and-hold (or empty if not yet received)
        row.push(lastKnown[c]);
      }
    }
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

/**
 * Captures the oscilloscope canvas with an overlaid branded telemetry watermark banner
 */
export function captureBrandedSnapshot(
  canvas: HTMLCanvasElement,
  metadata: {
    activeChannelsCount: number;
    timeWindowSec: number;
    platformName?: string;
    footer?: string;
  },
  /** Theme colours (CSS colour strings) so the snapshot matches the active theme. */
  colors: { band: string; rule: string; title: string; text: string; faint: string; font: string } = {
    band: 'rgba(23, 22, 20, 0.88)',
    rule: '#e0a246',
    title: '#f3eee4',
    text: '#8d887e',
    faint: '#716c64',
    font: 'Iosevka, monospace',
  }
): string {
  // Create an offscreen canvas with same dimensions
  const offscreen = document.createElement('canvas');
  offscreen.width = canvas.width;
  offscreen.height = canvas.height;
  const ctx = offscreen.getContext('2d');
  if (!ctx) return canvas.toDataURL('image/png');

  // Copy original canvas render
  ctx.drawImage(canvas, 0, 0);

  // Draw Watermark Overlay Banner at top
  ctx.fillStyle = colors.band;
  ctx.fillRect(0, 0, offscreen.width, 36);

  // Border line under header
  ctx.strokeStyle = colors.rule;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 36);
  ctx.lineTo(offscreen.width, 36);
  ctx.stroke();

  // Branding text
  ctx.fillStyle = colors.title;
  ctx.font = `600 12px ${colors.font}`;
  ctx.fillText('vehicle-analyzer oscilloscope', 14, 23);

  ctx.fillStyle = colors.text;
  ctx.font = `11px ${colors.font}`;
  const timestamp = new Date().toISOString().replace('T', ' ').substring(0, 19) + ' UTC';
  ctx.fillText(
    `${metadata.platformName || 'Honda CL250'} · window ${metadata.timeWindowSec} s · ${metadata.activeChannelsCount} channels · ${timestamp}`,
    250,
    22
  );

  // Bottom footer watermark
  ctx.fillStyle = colors.band;
  ctx.fillRect(0, offscreen.height - 20, offscreen.width, 20);

  ctx.fillStyle = colors.faint;
  ctx.font = `10px ${colors.font}`;
  ctx.fillText(metadata.footer ?? 'vehicle-analyzer snapshot', 14, offscreen.height - 6);

  return offscreen.toDataURL('image/png');
}
