import { describe, expect, it } from 'vitest';
import {
  chartPoints,
  defaultColumns,
  lineRuns,
  mapPoints,
  pointText,
  selectedColumns,
  toggleColumn,
  xDomain,
  yDomain,
} from '@/services/rideHistoryLayout';
import type { RidesRow } from '@/services/sessionClient';

const columns = [
  { name: 'derived.trip_distance', unit: 'km' },
  { name: 'derived.idle_time', unit: 's' },
];
const rows: RidesRow[] = [
  { sessionId: 'ride-1', createdUtc: '2026-01-01T10:00:00Z', values: { 'derived.trip_distance': 10 }, flags: { 'derived.trip_distance': 'ok' } },
  { sessionId: 'ride-2', createdUtc: '2026-01-02T10:00:00Z', values: { 'derived.trip_distance': null }, flags: { 'derived.trip_distance': 'missing' } },
  { sessionId: 'ride-3', createdUtc: '2026-01-03T10:00:00Z', values: { 'derived.trip_distance': 30 }, flags: { 'derived.trip_distance': 'ok' } },
];

describe('ride history layout', () => {
  it('keeps only response columns, defaults to the first and caps the selection', () => {
    expect(selectedColumns(columns, ['nope', 'derived.idle_time'])).toEqual(['derived.idle_time']);
    expect(defaultColumns(columns)).toEqual(['derived.trip_distance']);
    expect(toggleColumn(['a'], 'b')).toEqual(['a', 'b']);
    expect(toggleColumn(['a', 'b', 'c', 'd'], 'e')).toEqual(['a', 'b', 'c', 'd']);
    expect(toggleColumn(['a'], 'a')).toEqual(['a']);
  });

  it('builds order and time points and keeps invalid time x as null', () => {
    expect(chartPoints(rows, 'derived.trip_distance', 'order').map((point) => point.x)).toEqual([0, 1, 2]);
    expect(chartPoints(rows, 'derived.trip_distance', 'time').map((point) => point.x)).toEqual([
      Date.parse('2026-01-01T10:00:00Z'),
      Date.parse('2026-01-02T10:00:00Z'),
      Date.parse('2026-01-03T10:00:00Z'),
    ]);
    expect(chartPoints([{ ...rows[0], createdUtc: null }], 'derived.trip_distance', 'time')[0].x).toBeNull();
  });

  it('breaks line runs at null values and finds domains', () => {
    const points = chartPoints(rows, 'derived.trip_distance', 'order');
    expect(lineRuns(points).map((run) => run.map((point) => point.sessionId))).toEqual([['ride-1'], ['ride-3']]);
    expect(xDomain(points)).toEqual([0, 2]);
    expect(yDomain(points)).toEqual([9, 31]);
    expect(yDomain([{ ...points[0], value: null }])).toBeNull();
    expect(xDomain([{ ...points[0], x: null }])).toEqual([0, 1]);
  });

  it('maps points into the SVG box and formats the hover text', () => {
    const points = chartPoints(rows, 'derived.trip_distance', 'order');
    const mapped = mapPoints(points, [0, 2], [0, 40], 100, 20, 5);
    expect(mapped[0]).toMatchObject({ px: 5, py: 12.5 });
    expect(mapped[1]).toMatchObject({ px: 95, py: 7.5 });
    expect(pointText(points[0], 'km', [0, 40])).toBe('ride-1 · 10.000 km');
    expect(pointText(points[1], 'km', [0, 40])).toBe('ride-2 · – km');
  });
});
