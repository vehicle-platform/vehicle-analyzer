import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { RestSchemaError } from '@/services/schemas/restCommon';
import { parseReport, parseSeriesResponse, parseSessionListResult } from '@/services/schemas/session';
import { parseRideSummary, parseRidesResponse } from '@/services/schemas/summary';
import { parseTrackResponse } from '@/services/schemas/track';
import { parseBringupResult } from '@/services/schemas/bringup';
import { SessionClient } from '@/services/sessionClient';

const series = { name: 'did.ENGINE_SPEED', kind: 'did', unit: 'rpm', points_total: 5, downsampled: true, t_ms: [0, 40], v: [1500, 1520] };

describe('series schema', () => {
  it('maps a valid series and strips unknown fields', () => {
    const r = parseSeriesResponse({ session_id: 's', t0_device_ms: 5, max_points: 9, extra: 1, series: [{ ...series, junk: true }] });
    expect(r).toEqual({
      sessionId: 's',
      t0DeviceMs: 5,
      maxPoints: 9,
      rejected: 0,
      series: [{ name: 'did.ENGINE_SPEED', kind: 'did', unit: 'rpm', pointsTotal: 5, downsampled: true, tMs: [0, 40], v: [1500, 1520] }],
    });
    expect(r.series[0]).not.toHaveProperty('junk');
  });

  it('drops and counts a series with a missing field, a wrong type or a length mismatch', () => {
    const { v: _v, ...noV } = series;
    const r = parseSeriesResponse({
      series: [series, noV, { ...series, name: 7 }, { ...series, v: [1] }, { ...series, kind: 'x' }, { ...series, t_ms: [0, 'a'] }, null],
    });
    expect(r.series).toHaveLength(1);
    expect(r.rejected).toBe(6);
  });

  it('defaults optional fields and counts a garbage root', () => {
    const r = parseSeriesResponse({ series: [{ name: 'a', kind: 'sensor', t_ms: [1], v: [2], unit: 4, downsampled: 'yes' }] });
    expect(r.series[0]).toMatchObject({ unit: '', downsampled: false, pointsTotal: 1 });
    expect(parseSeriesResponse(null)).toMatchObject({ series: [], rejected: 1 });
    expect(parseSeriesResponse({ series: 5 })).toMatchObject({ series: [], rejected: 1 });
    expect(parseSeriesResponse({})).toMatchObject({ series: [], rejected: 0 });
  });

  it('never throws on arbitrary JSON', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        const r = parseSeriesResponse(v);
        expect(r.rejected).toBeGreaterThanOrEqual(0);
        expect(Array.isArray(r.series)).toBe(true);
      })
    );
  });
});

describe('session list and report schemas', () => {
  it('keeps unknown row fields, stringifies a numeric id and counts bad rows', () => {
    const r = parseSessionListResult([{ session_id: 7, status: 'ok' }, { session_id: 'b' }, { nope: 1 }, 3, { session_id: null }]);
    expect(r.rows).toEqual([{ session_id: '7', status: 'ok' }, { session_id: 'b' }]);
    expect(r.rejected).toBe(3);
  });
  it('accepts {sessions: [...]} and counts a root that is not a list', () => {
    expect(parseSessionListResult({ sessions: [{ session_id: 'a' }] })).toEqual({ rows: [{ session_id: 'a' }], rejected: 0 });
    expect(parseSessionListResult({ error: 1 })).toEqual({ rows: [], rejected: 1 });
  });
  it('requires the report to be an object', () => {
    expect(parseReport({ status: 'ok', n: { a: 1 } })).toEqual({ status: 'ok', n: { a: 1 } });
    expect(() => parseReport([1])).toThrow(RestSchemaError);
    expect(() => parseReport('x')).toThrow(/session report/);
    expect(() => parseReport(null)).toThrow(RestSchemaError);
  });
});

const scalar = { name: 'derived.trip', status: 'computed', kind: 'scalar', unit: 'km', range: [0, 9], value: 1.5, flag: null };
const summary = { session_id: 'r1', ride_definition: null, defs_version: '1', signals: [scalar] };

describe('ride summary schema', () => {
  it('maps a valid summary and strips unknown fields', () => {
    const r = parseRideSummary({ ...summary, extra: 1, signals: [{ ...scalar, extra: 2 }] });
    expect(r).toEqual({ sessionId: 'r1', rideDefinition: null, defsVersion: '1', signals: [{ ...scalar }] });
  });
  it('rejects a missing field, a wrong type and an unknown kind with a typed error', () => {
    const { unit: _u, ...noUnit } = scalar;
    for (const [bad, re] of [
      [{ ...summary, signals: [noUnit] }, /signals\[0\]\.unit is not a string/],
      [{ ...summary, signals: [{ ...scalar, range: [5, 1] }] }, /range is not a finite range/],
      [{ ...summary, signals: [{ ...scalar, kind: 'weird' }] }, /kind is neither/],
      [{ ...summary, session_id: 4 }, /session_id/],
      [{ ...summary, signals: 'x' }, /signals is not a list/],
      [null, /root/],
    ] as const) {
      const run = () => parseRideSummary(bad);
      expect(run).toThrow(RestSchemaError);
      expect(run).toThrow(re);
    }
  });
  it('exposes the endpoint and every issue on the error', () => {
    try {
      parseRideSummary({ session_id: '', signals: 1 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RestSchemaError);
      expect((e as RestSchemaError).endpoint).toBe('ride summary');
      expect((e as RestSchemaError).issues.length).toBeGreaterThan(1);
    }
  });
  it('rejects out-of-range bins and accepts the optional fields of an unavailable signal', () => {
    const binned = {
      name: 'b', status: 'computed', kind: 'binned', unit: 's', range: [0, 1],
      axes: [{ input: 'x', unit: 'u', edges: [[0, 1]] }], cells: [{ index: 0, axes: [1], value: 1, flag: null }], total_s: 1, outside_s: 0,
    };
    expect(() => parseRideSummary({ ...summary, signals: [binned] })).toThrow(/out-of-range bin/);
    const ok = parseRideSummary({ ...summary, signals: [{ ...binned, cells: [{ index: 0, axes: [0], value: null, flag: 'x' }] }, { name: 'u', status: 'missing_inputs', missing: ['a'], pending_inputs: ['b'] }] });
    expect(ok.signals[0]).toMatchObject({ defsMismatch: false, totalS: 1 });
    expect(ok.signals[1]).toEqual({ name: 'u', status: 'missing_inputs', missing: ['a'], pendingInputs: ['b'] });
    expect(() => parseRideSummary({ ...summary, signals: [{ name: 'u', status: 'error', missing: 'a' }] })).toThrow(/missing is not a list of strings/);
  });
});

const rides = {
  columns: [{ name: 'a', unit: 'km' }],
  rows: [{ session_id: 's', created_utc: null, values: { a: 1, extra: 3 }, flags: { a: 'ok' } }],
  skipped: 0,
};

describe('rides schema', () => {
  it('keeps only the cells of the returned columns', () => {
    expect(parseRidesResponse(rides).rows[0]).toEqual({ sessionId: 's', createdUtc: null, values: { a: 1 }, flags: { a: 'ok' } });
  });
  it('rejects wrong types and missing fields', () => {
    expect(() => parseRidesResponse({ ...rides, rows: [{ ...rides.rows[0], values: { a: '1' } }] })).toThrow(/rows\[0\]\.values\.a is not null or a finite number/);
    expect(() => parseRidesResponse({ ...rides, rows: [{ ...rides.rows[0], flags: { a: 4 } }] })).toThrow(/flags\.a is not null or a string/);
    expect(() => parseRidesResponse({ columns: rides.columns, rows: [] })).toThrow(/skipped/);
    expect(() => parseRidesResponse({ ...rides, rows: [{ ...rides.rows[0], session_id: undefined }] })).toThrow(/session_id/);
  });
});

const track = {
  session_id: 't', t0_device_ms: 0, method: 'dead_reckoning', frame: 'relative_enu_from_first_fix', max_points: 9, points_total: 1,
  downsampled: false, path_length_m: 1, segments_total: 1, excluded: { no_fix: 0, stale_fix: 0, untrusted_heading: 0 }, color: null,
  segments: [{ t_ms: [0], x_m: [0], y_m: [0], speed_mps: [0], heading_deg: [0], gap_before_ms: null, extra: 1 }],
};

describe('track schema', () => {
  it('maps a valid track and strips unknown fields', () => {
    const r = parseTrackResponse(track);
    expect(r.segments[0]).toEqual({ tMs: [0], xM: [0], yM: [0], speedMps: [0], headingDeg: [0], colorV: null, gapBeforeMs: null });
  });
  it('rejects a missing field and a wrong type with a typed error', () => {
    const { excluded: _e, ...noExcluded } = track;
    expect(() => parseTrackResponse(noExcluded)).toThrow(RestSchemaError);
    expect(() => parseTrackResponse({ ...track, downsampled: 'no' })).toThrow(/downsampled is not a boolean/);
    expect(() => parseTrackResponse({ ...track, segments: [{ ...track.segments[0], gap_before_ms: undefined }] })).toThrow(/gap_before_ms/);
  });
});

const bringup = { session_id: 'b', gate: 'B0', verdict: 'pass', checks: [{ id: 'c', status: 'pass', measured: { x: 1 }, expected: 'e', source: 's', note: 'n' }], needs_you: [], warnings: ['w'] };

describe('bring-up schema', () => {
  it('maps a valid result, defaults missing text and a missing measured value', () => {
    const r = parseBringupResult({ ...bringup, extra: 1, checks: [{ id: 'c', status: 'warn' }] });
    expect(r.checks[0]).toEqual({ id: 'c', status: 'warn', measured: null, expected: '', source: '', note: '' });
    expect(r).toMatchObject({ sessionId: 'b', needsYou: [], warnings: ['w'] });
  });
  it('rejects an unknown gate/verdict/status, a missing list and a wrong type', () => {
    expect(() => parseBringupResult({ ...bringup, gate: 'X9' })).toThrow(/gate/);
    expect(() => parseBringupResult({ ...bringup, verdict: 'maybe' })).toThrow(/verdict/);
    expect(() => parseBringupResult({ ...bringup, checks: [{ id: 'c', status: 'meh' }] })).toThrow(/unknown status/);
    expect(() => parseBringupResult({ ...bringup, needs_you: undefined })).toThrow(/needs_you/);
    expect(() => parseBringupResult({ ...bringup, session_id: 5 })).toThrow(RestSchemaError);
  });
});

describe('REST clients at the boundary', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) }) as Response;
  it('listSessionsChecked reports the dropped rows, getReport throws a typed error', async () => {
    const list = new SessionClient('http://h', 't', async () => ok([{ session_id: 'a' }, 4]));
    expect(await list.listSessionsChecked()).toEqual({ rows: [{ session_id: 'a' }], rejected: 1 });
    const report = new SessionClient('http://h', 't', async () => ok([1, 2]));
    await expect(report.getReport('a')).rejects.toBeInstanceOf(RestSchemaError);
  });
  it('getSeries reports the dropped series', async () => {
    const c = new SessionClient('http://h', 't', async () => ok({ series: [series, { name: 1 }] }));
    expect((await c.getSeries('a')).rejected).toBe(1);
  });
});

describe('arbitrary JSON', () => {
  it('strict parsers only ever throw RestSchemaError', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        for (const p of [parseRideSummary, parseRidesResponse, parseTrackResponse, parseBringupResult, parseReport]) {
          try {
            p(v);
          } catch (e) {
            expect(e).toBeInstanceOf(RestSchemaError);
          }
        }
      })
    );
  });
});
