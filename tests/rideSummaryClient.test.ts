import { describe, expect, it } from 'vitest';
import {
  NoRideSummaryError,
  SessionClient,
  fetchRideSummary,
  fetchRides,
  parseRideSummary,
  parseRidesResponse,
  rideSummaryRequest,
  ridesRequest,
} from '@/services/sessionClient';

const summary = {
  session_id: 'ride-1',
  ride_definition: 'cl250_ride',
  defs_version: '1.2.0',
  signals: [
    { name: 'derived.trip_distance', status: 'computed', unit: 'km', range: [0, 1000], kind: 'scalar', value: 12.3, flag: 'ok' },
    {
      name: 'derived.operating_point_time',
      status: 'computed',
      unit: 's',
      range: [0, 200],
      kind: 'binned',
      axes: [
        { input: 'derived.speed_kmh', unit: 'km/h', edges: [[0, 30], [30, 60]] },
        { input: 'did.ENGINE_SPEED', unit: 'rpm', edges: [[0, 2000], [2000, 4000]] },
      ],
      cells: [{ index: 0, axes: [0, 0], value: 1.5, flag: null }],
      total_s: 200,
      outside_s: 2,
      defs_mismatch: true,
    },
    { name: 'derived.stopped_time', status: 'not_ready', reason: 'ride too short', pending_inputs: ['derived.speed_kmh'] },
  ],
};

const rides = {
  columns: [{ name: 'derived.trip_distance', unit: 'km' }],
  rows: [
    { session_id: 'ride-1', created_utc: '2026-01-01T10:00:00Z', values: { 'derived.trip_distance': 12.3 }, flags: { 'derived.trip_distance': 'ok' } },
    { session_id: 'ride-2', created_utc: '2026-01-02T10:00:00Z', values: { 'derived.trip_distance': null }, flags: { 'derived.trip_distance': 'missing' } },
  ],
  skipped: 1,
};

describe('parseRideSummary', () => {
  it('maps scalar, binned and non-computed signals', () => {
    const parsed = parseRideSummary(summary);
    expect(parsed).toMatchObject({ sessionId: 'ride-1', rideDefinition: 'cl250_ride', defsVersion: '1.2.0' });
    expect(parsed.signals[0]).toMatchObject({ kind: 'scalar', value: 12.3, unit: 'km' });
    expect(parsed.signals[1]).toMatchObject({ kind: 'binned', totalS: 200, outsideS: 2, defsMismatch: true });
    expect(parsed.signals[2]).toMatchObject({ status: 'not_ready', reason: 'ride too short', pendingInputs: ['derived.speed_kmh'] });
  });

  it('accepts a summary without a ride definition or defs version', () => {
    expect(parseRideSummary({ ...summary, ride_definition: null, defs_version: null }).signals).toHaveLength(3);
  });

  it('rejects an inconsistent binned cell instead of drawing it', () => {
    const bad = { ...summary, signals: [{ ...summary.signals[1], cells: [{ index: 0, axes: [0], value: 1, flag: null }] }] };
    expect(() => parseRideSummary(bad)).toThrow(/axes does not match/);
  });

  it('rejects unknown statuses and non-finite values', () => {
    expect(() => parseRideSummary({ ...summary, signals: [{ name: 'x', status: 'maybe' }] })).toThrow(/unknown status/);
    expect(() => parseRideSummary({ ...summary, signals: [{ ...summary.signals[0], value: Number.NaN }] })).toThrow(/finite number/);
  });
});

describe('parseRideSummary per-gear entries', () => {
  const perGear = {
    name: 'ride_final_drive_ratio',
    status: 'computed',
    unit: 'ratio',
    range: [2, 3.5],
    kind: 'per_gear',
    gears: [
      { gear: 1, value: 2.64, flag: null },
      { gear: 4, value: null, flag: 'no_steady_samples' },
    ],
  };

  it('keeps the server gear rows, null values and flags', () => {
    const parsed = parseRideSummary({ ...summary, signals: [perGear] });
    expect(parsed.signals[0]).toMatchObject({
      name: 'ride_final_drive_ratio',
      kind: 'per_gear',
      unit: 'ratio',
      range: [2, 3.5],
      gears: [
        { gear: 1, value: 2.64, flag: null },
        { gear: 4, value: null, flag: 'no_steady_samples' },
      ],
    });
  });

  it('accepts an empty gears list', () => {
    const parsed = parseRideSummary({ ...summary, signals: [{ ...perGear, gears: [] }] });
    expect(parsed.signals[0]).toMatchObject({ kind: 'per_gear', gears: [] });
  });

  it.each([
    ['gears is not a list', { ...perGear, gears: 'none' }, /gears is not a list/],
    ['gear is not an integer', { ...perGear, gears: [{ gear: 1.5, value: 2.6, flag: null }] }, /gear is not a positive integer/],
    ['gear is below 1', { ...perGear, gears: [{ gear: 0, value: 2.6, flag: null }] }, /gear is not a positive integer/],
    ['a gear is repeated', { ...perGear, gears: [{ gear: 2, value: 2.6, flag: null }, { gear: 2, value: 2.7, flag: null }] }, /gears\[1\]\.gear 2 is repeated/],
    ['an entry is not an object', { ...perGear, gears: [3] }, /gears\[0\] is not an object/],
    ['value is not a number', { ...perGear, gears: [{ gear: 1, value: '2.6', flag: null }] }, /value is not null or a finite number/],
    ['flag is not a string', { ...perGear, gears: [{ gear: 1, value: 2.6, flag: 7 }] }, /flag is not null or a string/],
  ])('keeps the summary and marks one entry unavailable when %s', (_why, signal, error) => {
    const parsed = parseRideSummary({ ...summary, signals: [signal] });
    expect(parsed.signals[0]).toMatchObject({ name: 'ride_final_drive_ratio', status: 'error' });
    expect(parsed.signals[0]).toHaveProperty('message', expect.stringMatching(error));
  });
});

describe('parseRidesResponse', () => {
  it('maps columns, rows and skipped sessions', () => {
    const parsed = parseRidesResponse(rides);
    expect(parsed.columns).toEqual([{ name: 'derived.trip_distance', unit: 'km' }]);
    expect(parsed.rows[1]).toMatchObject({ sessionId: 'ride-2', values: { 'derived.trip_distance': null }, flags: { 'derived.trip_distance': 'missing' } });
    expect(parsed.skipped).toBe(1);
  });

  it('rejects cells that are not in the columns and duplicate columns', () => {
    expect(() => parseRidesResponse({ ...rides, rows: [{ session_id: 'x', created_utc: null, values: {}, flags: {} }] })).toThrow(/values/);
    expect(() => parseRidesResponse({ ...rides, columns: [rides.columns[0], rides.columns[0]] })).toThrow(/duplicate/);
  });

  it('rejects a negative or fractional skipped count', () => {
    expect(() => parseRidesResponse({ ...rides, skipped: -1 })).toThrow(/skipped/);
    expect(() => parseRidesResponse({ ...rides, skipped: 1.5 })).toThrow(/skipped/);
  });
});

describe('ride summary requests', () => {
  const token = 'sekret-token-123';

  it('puts the token in the header only and encodes the session id', () => {
    const req = rideSummaryRequest('http://h/', token, 'ride 1');
    expect(req.url).toBe('http://h/sessions/ride%201/summary');
    expect(req.headers.Authorization).toBe(`Bearer ${token}`);
    expect(req.url).not.toContain(token);

    const ridesReq = ridesRequest('http://h', token, { from: '2026-01-01', to: '2026-02-01T12:00:00+01:00', names: ['derived.a', 'derived.b'] });
    expect(ridesReq.url).toBe('http://h/rides?from=2026-01-01&to=2026-02-01T12%3A00%3A00%2B01%3A00&names=derived.a%2Cderived.b');
    expect(ridesReq.headers.Authorization).toBe(`Bearer ${token}`);
  });

  it('fetches and parses both endpoints through the injected fetch', async () => {
    const urls: string[] = [];
    const fetchFn = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.endsWith('/summary') ? summary : rides), { status: 200 });
    };
    const cfg = { serverUrl: 'http://h', token, fetchFn };
    expect((await fetchRideSummary(cfg, 'ride-1')).signals).toHaveLength(3);
    expect((await fetchRides(cfg, { names: ['derived.trip_distance'] })).rows).toHaveLength(2);
    expect(urls).toEqual(['http://h/sessions/ride-1/summary', 'http://h/rides?names=derived.trip_distance']);
  });

  it('turns the exact 404 detail into NoRideSummaryError', async () => {
    const cfg = {
      serverUrl: 'http://h',
      token,
      fetchFn: async () => new Response(JSON.stringify({ detail: 'session has no ride summary' }), { status: 404 }),
    };
    await expect(fetchRideSummary(cfg, 'ride-1')).rejects.toBeInstanceOf(NoRideSummaryError);
  });

  it('surfaces a 422 detail without the token', async () => {
    const cfg = {
      serverUrl: 'http://h',
      token,
      fetchFn: async () => new Response(JSON.stringify({ detail: 'unknown class-B scalar names: nope' }), { status: 422 }),
    };
    await expect(fetchRides(cfg, { names: ['nope'] })).rejects.toThrow(/unknown class-B scalar names: nope/);
    await expect(fetchRides(cfg, { names: ['nope'] })).rejects.not.toThrow(token);
  });

  it('exposes the same calls on SessionClient', async () => {
    const client = new SessionClient('http://h', token, async (url) =>
      new Response(JSON.stringify(url.endsWith('/summary') ? summary : rides), { status: 200 })
    );
    expect((await client.getRideSummary('ride-1')).sessionId).toBe('ride-1');
    expect((await client.getRides()).skipped).toBe(1);
  });
});
