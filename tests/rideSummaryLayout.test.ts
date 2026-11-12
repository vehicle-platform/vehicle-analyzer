import { describe, expect, it } from 'vitest';
import {
  barRects,
  cellAt,
  formatRideValue,
  heatOpacity,
  maxCellValue,
  precisionForAxis,
  precisionForRange,
} from '@/services/rideSummaryLayout';
import type { RideSummaryBinned } from '@/services/sessionClient';

const binned: RideSummaryBinned = {
  name: 'derived.operating_point_time',
  status: 'computed',
  kind: 'binned',
  unit: 's',
  range: [0, 200],
  axes: [
    { input: 'derived.speed_kmh', unit: 'km/h', edges: [[0, 30], [30, 60]] },
    { input: 'did.ENGINE_SPEED', unit: 'rpm', edges: [[0, 2000], [2000, 4000], [4000, 6000]] },
  ],
  cells: [
    { index: 0, axes: [0, 0], value: 12, flag: null },
    { index: 1, axes: [1, 2], value: 3, flag: 'low' },
  ],
  totalS: 200,
  outsideS: 1,
  defsMismatch: false,
};

describe('ride summary layout', () => {
  it('derives precision from the range only', () => {
    expect(precisionForRange([0, 2000])).toBe(1);
    expect(precisionForRange([0, 200])).toBe(2);
    expect(precisionForRange([0, 1])).toBe(4);
    expect(precisionForRange([5, 5])).toBe(3);
    expect(formatRideValue(12.345, [0, 200])).toBe('12.35');
    expect(formatRideValue(null, [0, 200])).toBe('–');
  });

  it('derives edge precision from the axis range, not the signal range', () => {
    expect(precisionForAxis([[0, 3000], [3000, 6000], [6000, 9000], [9000, 12000]])).toBe(0);
    expect(precisionForAxis([[0, 0.25], [0.25, 0.5], [0.5, 1]])).toBe(4);
    expect(precisionForAxis([[-10, 10]])).toBe(3);
    expect(precisionForAxis([[-1000, -500], [-500, 0]])).toBe(1);
    expect(precisionForAxis([])).toBe(3);
  });

  it('scales bars to the largest value and keeps nulls empty', () => {
    expect(barRects([2, null, 4], 100, 40, 0)).toEqual([
      { index: 0, x: 0, y: 20, width: 100 / 3, height: 20, value: 2 },
      { index: 1, x: 100 / 3, y: 40, width: 100 / 3, height: 0, value: null },
      { index: 2, x: 200 / 3, y: 0, width: 100 / 3, height: 40, value: 4 },
    ]);
    expect(barRects([], 100, 40)).toEqual([]);
    expect(barRects([1], 0, 40)).toEqual([]);
  });

  it('looks cells up by their axis indices and scales heat opacity', () => {
    expect(cellAt(binned, [0, 0])?.value).toBe(12);
    expect(cellAt(binned, [1, 2])?.flag).toBe('low');
    expect(cellAt(binned, [9, 9])).toBeUndefined();
    expect(maxCellValue(binned)).toBe(12);
    expect(heatOpacity(null, 12)).toBe(0);
    expect(heatOpacity(0, 12)).toBe(0);
    expect(heatOpacity(6, 12)).toBeCloseTo(0.575);
    expect(heatOpacity(12, 12)).toBe(1);
  });
});
