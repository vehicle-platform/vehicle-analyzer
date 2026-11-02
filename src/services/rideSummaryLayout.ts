import type { RideSummaryBinned, RideSummaryCell, RideSummaryRange } from './sessionClient';

/** Decimals for a value, derived only from the response range. */
export function precisionForRange(range: RideSummaryRange): number {
  const span = Math.abs(range[1] - range[0]);
  if (!Number.isFinite(span) || span === 0) return 3;
  return Math.min(6, Math.max(0, 4 - Math.floor(Math.log10(span))));
}

export function formatRideValue(value: number | null, range: RideSummaryRange): string {
  if (value === null || !Number.isFinite(value)) return '–';
  return value.toFixed(precisionForRange(range));
}

export type RideBarRect = {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  value: number | null;
};

/** Bars scaled to the largest non-negative value; nulls stay empty slots. */
export function barRects(values: (number | null)[], width: number, height: number, gap = 2): RideBarRect[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || values.length === 0) return [];
  const usable = width - gap * Math.max(0, values.length - 1);
  if (usable <= 0) return [];
  const barWidth = usable / values.length;
  let max = 0;
  for (const value of values) if (value !== null && Number.isFinite(value) && value > max) max = value;
  return values.map((value, index) => {
    const known = value !== null && Number.isFinite(value) && value > 0;
    const barHeight = known && max > 0 ? (value / max) * height : 0;
    return { index, x: index * (barWidth + gap), y: height - barHeight, width: barWidth, height: barHeight, value };
  });
}

export function cellAt(binned: RideSummaryBinned, indices: number[]): RideSummaryCell | undefined {
  return binned.cells.find((cell) => cell.axes.length === indices.length && cell.axes.every((value, i) => value === indices[i]));
}

/** 0 for null/zero cells, 0.15..1 for positive values, so the grid stays visible. */
export function heatOpacity(value: number | null, max: number): number {
  if (value === null || !Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  return 0.15 + 0.85 * Math.min(1, value / max);
}

export function maxCellValue(binned: RideSummaryBinned): number {
  let max = 0;
  for (const cell of binned.cells) if (cell.value !== null && Number.isFinite(cell.value) && cell.value > max) max = cell.value;
  return max;
}
