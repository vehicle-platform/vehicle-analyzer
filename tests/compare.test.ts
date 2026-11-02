import { describe, it, expect } from 'vitest';
import {
  DISTANCE_CHANNEL,
  SessionChannel,
  cleanSeries,
  commonChannels,
  compareRideSummaries,
  compareSessions,
  compareToCsv,
  distanceAvailability,
  isPositionChannel,
  makeGrid,
  polylines,
  resample,
  sessionChannel,
  valueRange,
} from '../src/services/compare';
import { parseSeriesResponse, type RideSummary } from '../src/services/sessionClient';

const ch = (id: string, tMs: number[], v: number[], extra: Partial<SessionChannel> = {}): SessionChannel => ({
  sessionId: id,
  channel: 'did.ENGINE_SPEED',
  unit: 'rpm',
  tMs,
  v,
  ...extra,
});

describe('resample', () => {
  it('interpolates linearly and hits exact samples', () => {
    expect(resample([0, 10], [0, 100], [0, 2.5, 10])).toEqual([0, 25, 100]);
  });
  it('is null outside the range (no extrapolation)', () => {
    expect(resample([1, 2], [5, 6], [0, 1.5, 3])).toEqual([null, 5.5, null]);
  });
  it('is null across a gap larger than the threshold', () => {
    const x = [0, 1, 2, 3, 20, 21];
    const r = resample(x, x.map((n) => n * 2), [1.5, 10, 20.5]);
    expect(r).toEqual([3, null, 41]);
  });
  it('handles empty and single-point series', () => {
    expect(resample([], [], [1, 2])).toEqual([null, null]);
    expect(resample([2], [7], [1, 2, 3])).toEqual([null, 7, null]);
  });
});

describe('cleanSeries / makeGrid', () => {
  it('keeps strictly increasing finite points', () => {
    expect(cleanSeries([0, 1, 1, 0.5, 2, NaN, 3], [1, 2, 3, 4, 5, 6, 7])).toEqual({ x: [0, 1, 2, 3], v: [1, 2, 5, 7] });
  });
  it('builds a grid or nothing', () => {
    expect(makeGrid(0, 1, 3)).toEqual([0, 0.5, 1]);
    expect(makeGrid(2, 1)).toEqual([]);
    expect(makeGrid(5, 5)).toEqual([5]);
  });
});

describe('compareSessions on time', () => {
  it('differences over the overlap of different lengths', () => {
    const a = ch('A', [0, 10000], [0, 100]);
    const b = ch('B', [0, 5000], [10, 10]);
    const r = compareSessions(a, b, 'time', 6);
    expect(r.x).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.a[5]).toBe(50);
    expect(r.b.every((v) => v === 10)).toBe(true);
    expect(r.diff).toEqual([10, 0, -10, -20, -30, -40]);
    expect(r.axisUnit).toBe('s');
  });
  it('each session uses its own t0 (offset series overlap from 0)', () => {
    const r = compareSessions(ch('A', [0, 2000], [1, 3]), ch('B', [1000, 3000], [5, 7]), 'time', 3);
    expect(r.x).toEqual([1, 1.5, 2]);
    expect(r.a).toEqual([2, 2.5, 3]);
    expect(r.b).toEqual([5, 5.5, 6]);
    expect(r.diff).toEqual([3, 3, 3]);
  });
  it('no overlap gives empty output', () => {
    const r = compareSessions(ch('A', [0, 1000], [1, 2]), ch('B', [5000, 6000], [1, 2]), 'time');
    expect(r.x).toEqual([]);
    expect(r.diff).toEqual([]);
  });
  it('difference is null where either side is in a gap', () => {
    const a = ch('A', [0, 1000, 2000, 3000, 20000, 21000], [0, 1, 2, 3, 20, 21]);
    const b = ch('B', [0, 21000], [0, 21]);
    const r = compareSessions(a, b, 'time', 22);
    const i = r.x.findIndex((x) => x > 5 && x < 15);
    expect(r.a[i]).toBeNull();
    expect(r.b[i]).not.toBeNull();
    expect(r.diff[i]).toBeNull();
    expect(r.diff[0]).toBe(0);
  });
  it('refuses different channels, different units and position channels', () => {
    expect(() => compareSessions(ch('A', [0], [1]), { ...ch('B', [0], [1]), channel: 'did.OTHER' }, 'time')).toThrow(/Different channels/);
    expect(() => compareSessions(ch('A', [0], [1]), { ...ch('B', [0], [1]), unit: 'km/h' }, 'time')).toThrow(/Units differ/);
    const lat = { ...ch('A', [0, 1], [1, 2]), channel: 'sensor.gps_latitude' };
    expect(() => compareSessions(lat, { ...lat, sessionId: 'B' }, 'time')).toThrow(/Position/);
  });
});

describe('position refusal', () => {
  it('detects latitude/longitude-like names only', () => {
    for (const n of ['sensor.gps_latitude', 'sensor.longitude', 'derived.lat', 'sensor.lon_deg', 'sensor.Lng']) expect(isPositionChannel(n)).toBe(true);
    for (const n of ['did.ENGINE_SPEED', 'derived.trip_distance', 'sensor.imu_accel_x', 'derived.altitude_change', 'derived.flat_spot']) expect(isPositionChannel(n)).toBe(false);
  });
  it('sessionChannel, commonChannels and CSV never take one', () => {
    const res = parseSeriesResponse({ session_id: 's', series: [{ name: 'sensor.gps_latitude', kind: 'sensor', unit: 'deg', t_ms: [0], v: [1] }] });
    expect(() => sessionChannel(res, 's', 'sensor.gps_latitude')).toThrow(/Position/);
    expect(commonChannels(res.series, res.series)).toEqual([]);
    const r = compareSessions(ch('A', [0, 1000], [1, 2]), ch('B', [0, 1000], [1, 2]), 'time', 2);
    expect(() => compareToCsv({ ...r, channel: 'sensor.longitude' })).toThrow(/Position/);
  });
});

describe('distance axis', () => {
  const dist = (kmPerS: number) => ({ tMs: [0, 1000, 2000, 3000, 4000], km: [0, 1, 2, 3, 4].map((k) => k * kmPerS) });
  it('is unavailable without the trip distance channel, with a reason', () => {
    const a = ch('A', [0, 1000], [1, 2]);
    const b = ch('B', [0, 1000], [1, 2], { distance: dist(1) });
    const av = distanceAvailability(a, b);
    expect(av.ok).toBe(false);
    expect(av.reason).toContain('A');
    expect(av.reason).toContain(DISTANCE_CHANNEL);
    expect(distanceAvailability(null, b).ok).toBe(false);
    expect(() => compareSessions(a, b, 'distance')).toThrow(/trip_distance/);
    expect(distanceAvailability(b, b).ok).toBe(true);
  });
  it('compares at equal distance, not equal time', () => {
    // A rides 1 km/s, B rides 2 km/s; value = distance, so the values agree per km.
    const a = ch('A', [0, 1000, 2000, 3000, 4000], [0, 1, 2, 3, 4], { distance: dist(1) });
    const b = ch('B', [0, 1000, 2000, 3000, 4000], [0, 2, 4, 6, 8], { distance: dist(2) });
    const r = compareSessions(a, b, 'distance', 5);
    expect(r.axisUnit).toBe('km');
    expect(r.x).toEqual([0, 1, 2, 3, 4]);
    expect(r.diff).toEqual([0, 0, 0, 0, 0]);
    expect(compareSessions(a, b, 'time', 5).diff[4]).toBe(4);
  });
  it('stationary samples (same distance) do not break the axis', () => {
    const a = ch('A', [0, 1000, 2000, 3000], [5, 6, 7, 8], { distance: { tMs: [0, 1000, 2000, 3000], km: [0, 0, 1, 2] } });
    const r = compareSessions(a, { ...a, sessionId: 'B' }, 'distance', 3);
    expect(r.x).toEqual([0, 1, 2]);
    expect(r.diff).toEqual([0, 0, 0]);
  });
  it('is taken from the response, with the km unit', () => {
    const res = parseSeriesResponse({
      series: [
        { name: 'did.ENGINE_SPEED', kind: 'did', unit: 'rpm', t_ms: [0, 1000], v: [1, 2] },
        { name: DISTANCE_CHANNEL, kind: 'derived', unit: 'km', t_ms: [0, 1000], v: [0, 1] },
      ],
    });
    expect(sessionChannel(res, 's', 'did.ENGINE_SPEED')?.distance?.km).toEqual([0, 1]);
    expect(sessionChannel(res, 's', 'did.MISSING')).toBeNull();
  });
});

describe('commonChannels', () => {
  const mk = (name: string, unit: string) => ({ name, kind: 'did' as const, unit, pointsTotal: 1, downsampled: false, tMs: [0], v: [1] });
  it('needs the same name and unit', () => {
    expect(commonChannels([mk('b', 'x'), mk('a', 'x'), mk('c', 'x')], [mk('a', 'x'), mk('b', 'y'), mk('d', 'x')])).toEqual(['a']);
  });
});

describe('compareRideSummaries', () => {
  const summary = (sessionId: string, signals: RideSummary['signals']): RideSummary => ({
    sessionId,
    rideDefinition: null,
    defsVersion: null,
    signals,
  });
  const a = summary('A', [
    { name: 'derived.trip_distance', status: 'computed', kind: 'scalar', unit: 'km', range: [0, 200], value: 12.3, flag: null },
    { name: 'derived.idle_time', status: 'not_ready', reason: 'ride too short' },
    {
      name: 'derived.operating_point_time',
      status: 'computed',
      kind: 'binned',
      unit: 's',
      range: [0, 200],
      axes: [{ input: 'derived.speed_kmh', unit: 'km/h', edges: [[0, 30]] }],
      cells: [],
      totalS: 1,
      outsideS: 0,
      defsMismatch: false,
    },
  ]);
  const b = summary('B', [
    { name: 'derived.trip_distance', status: 'computed', kind: 'scalar', unit: 'km', range: [0, 200], value: 10, flag: null },
    { name: 'derived.idle_time', status: 'computed', kind: 'scalar', unit: 's', range: [0, 200], value: 5, flag: null },
    { name: 'only.b', status: 'computed', kind: 'scalar', unit: 'x', range: [0, 1], value: 1, flag: null },
  ]);

  it('keeps scalar rows present in both sessions and uses status where not computed', () => {
    const rows = compareRideSummaries(a, b);
    expect(rows.map((row) => row.name)).toEqual(['derived.trip_distance', 'derived.idle_time']);
    expect(rows[0]).toMatchObject({ aValue: 12.3, bValue: 10, unit: 'km' });
    expect(rows[0].diff).toBeCloseTo(-2.3);
    expect(rows[1]).toMatchObject({ aStatus: 'not_ready', bStatus: 'computed', aValue: null, bValue: 5, diff: null });
    expect(compareRideSummaries(null, b)).toEqual([]);
  });
});

describe('compareToCsv', () => {
  it('writes a comment line, the header and empty cells for nulls', () => {
    const a = ch('ride-1', [0, 1000, 2000, 3000, 20000, 21000], [0, 1, 2, 3, 20, 21]);
    const b = ch('ride-2', [0, 21000], [0, 21]);
    const csv = compareToCsv(compareSessions(a, b, 'time', 22));
    const lines = csv.trimEnd().split('\n');
    expect(lines[0]).toBe('# A=ride-1; B=ride-2; channel=did.ENGINE_SPEED; unit=rpm; axis=time (s since session start)');
    expect(lines[1]).toBe('axis,A,B,B_minus_A');
    expect(lines[2]).toBe('0,0,0,0');
    expect(lines.length).toBe(24);
    expect(lines.some((l) => /^[\d.]+,,[\d.]+,$/.test(l))).toBe(true);
    expect(csv).not.toMatch(/lat|lon/i);
  });
  it('keeps the header on one line', () => {
    const r = compareSessions(ch('a\nb', [0, 1000], [1, 2]), ch('c', [0, 1000], [1, 2]), 'time', 2);
    expect(compareToCsv(r).split('\n')[0]).toContain('A=a b;');
  });
  it('appends a second ride-summary block with statuses in place of missing numbers', () => {
    const r = compareSessions(ch('A', [0, 1000], [1, 2]), ch('B', [0, 1000], [2, 3]), 'time', 2);
    const csv = compareToCsv(r, [
      { name: 'derived.trip_distance', unit: 'km', range: [0, 200], aStatus: 'computed', bStatus: 'computed', aValue: 12.3, bValue: 10, diff: -2.3 },
      { name: 'derived.idle_time', unit: 's', range: [0, 200], aStatus: 'not_ready', bStatus: 'computed', aValue: null, bValue: 5, diff: null },
    ]);
    const lines = csv.trimEnd().split('\n');
    expect(lines).toContain('# ride summaries; A=A; B=B');
    expect(lines).toContain('name,A,B,B_minus_A,unit');
    expect(lines).toContain('derived.trip_distance,12.3,10,-2.3,km');
    expect(lines).toContain('derived.idle_time,not_ready,5,,s');
  });
});

describe('drawing helpers', () => {
  it('breaks polylines at nulls and maps to pixels', () => {
    const runs = polylines([0, 1, 2, 3], [0, 10, null, 10], [0, 3], [0, 10], 30, 100);
    expect(runs).toEqual([[[0, 100], [10, 0]], [[30, 0]]]);
  });
  it('finds the value range', () => {
    expect(valueRange([null, 2], [5, null])).toEqual([2, 5]);
    expect(valueRange([null])).toBeNull();
  });
});
