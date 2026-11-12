import { describe, it, expect } from 'vitest';
import {
  SessionClient,
  buildRequest,
  describeHttpError,
  mapSeriesKey,
  parseSeriesResponse,
  parseSessionList,
  seriesRequest,
  sessionsRequest,
  summarizeReport,
} from '@/services/sessionClient';
import { framesToItems, mergeSamples, replayMatchesSession } from '@/services/replay';
import { CaptureStore } from '@/state/captureStore';
import { availableChannels } from '@/state/channels';
import { didKey } from '@/services/pipeline';
import { DEFS } from '@/defs';

const good = {
  session_id: 's1',
  t0_device_ms: 123456,
  max_points: 2000,
  series: [
    { name: 'did.ENGINE_SPEED', kind: 'did', unit: 'rpm', points_total: 9000, downsampled: true, t_ms: [0, 40], v: [1500, 1520] },
    { name: 'sensor.lean', kind: 'sensor', unit: 'deg', points_total: 2, downsampled: false, t_ms: [0, 20], v: [1, 2] },
  ],
};

describe('parseSeriesResponse', () => {
  it('reads a well-formed response', () => {
    const r = parseSeriesResponse(good);
    expect(r.sessionId).toBe('s1');
    expect(r.t0DeviceMs).toBe(123456);
    expect(r.series).toHaveLength(2);
    expect(r.series[0]).toMatchObject({ name: 'did.ENGINE_SPEED', kind: 'did', unit: 'rpm', downsampled: true, pointsTotal: 9000, tMs: [0, 40], v: [1500, 1520] });
  });

  it('drops malformed series instead of throwing', () => {
    const r = parseSeriesResponse({
      series: [
        { name: 'did.A', kind: 'did', t_ms: [0, 1], v: [1] }, // length mismatch
        { name: 'did.B', kind: 'did', t_ms: [0, 1], v: [1, 'x'] }, // non-number
        { name: 'did.C', kind: 'weird', t_ms: [0], v: [1] }, // unknown kind
        { name: 7, kind: 'did', t_ms: [0], v: [1] },
        null,
        { name: 'derived.ok', kind: 'derived', t_ms: [0], v: [1] },
      ],
    });
    expect(r.series.map((s) => s.name)).toEqual(['derived.ok']);
    expect(r.series[0].unit).toBe('');
  });

  it('survives garbage', () => {
    expect(parseSeriesResponse(null).series).toEqual([]);
    expect(parseSeriesResponse('x').series).toEqual([]);
    expect(parseSeriesResponse({ series: 5 }).series).toEqual([]);
  });
});

describe('session list and report', () => {
  it('keeps rows with a session_id only', () => {
    expect(parseSessionList([{ session_id: 'a', started_at: 1 }, { nope: 1 }, 3]).map((r) => r.session_id)).toEqual(['a']);
    expect(parseSessionList({ error: 1 })).toEqual([]);
  });
  it('summarises scalar fields and ignores nested ones', () => {
    const s = summarizeReport({ a: 1.23456, b: 'x', c: { d: 1 }, e: [1], f: true });
    expect(s.map((r) => r.key)).toEqual(['a', 'b', 'f']);
    expect(summarizeReport(null)).toEqual([]);
  });
});

describe('key mapping', () => {
  it('maps did to the live DID key and sensor/derived to prefixed keys', () => {
    expect(mapSeriesKey('did.ENGINE_SPEED', 'did').key).toBe(didKey('ENGINE_SPEED'));
    expect(mapSeriesKey('sensor.lean', 'sensor')).toMatchObject({ key: 'sensor:lean', group: 'session · sensor' });
    expect(mapSeriesKey('derived.speed_kmh', 'derived')).toMatchObject({ key: 'derived:speed_kmh', group: 'session · derived' });
  });
});

describe('replay items', () => {
  it('merges series into one time-ordered list', () => {
    const items = mergeSamples([
      { key: 'a', t: [0, 0.04, 0.08], v: [1, 2, 3] },
      { key: 'b', t: [0.02, 0.06], v: [10, 20] },
    ]);
    expect(items.map((i) => i.t)).toEqual([0, 0.02, 0.04, 0.06, 0.08]);
    expect(items.map((i) => (i.kind === 'sample' ? i.key : '?')).join('')).toBe('abab' + 'a');
  });
  it('keeps series order on equal times', () => {
    const items = mergeSamples([
      { key: 'a', t: [1], v: [1] },
      { key: 'b', t: [1], v: [2] },
    ]);
    expect(items.map((i) => (i.kind === 'sample' ? i.key : ''))).toEqual(['a', 'b']);
  });
  it('wraps frames with their timestamp', () => {
    const items = framesToItems([{ timestamp: 2.5 } as never]);
    expect(items[0]).toMatchObject({ kind: 'frame', t: 2.5 });
  });
});

describe('request building', () => {
  const TOKEN = 'sekret-token-123';
  it('carries the token in the header only, never in the URL', () => {
    const reqs = [
      sessionsRequest('http://localhost:8000/', TOKEN),
      seriesRequest('http://localhost:8000', TOKEN, 's 1', { signals: ['did.A', 'sensor.b'], maxPoints: 2000, fromMs: 0, toMs: 5000 }),
      buildRequest('http://x', TOKEN, '/sessions/a/report'),
    ];
    for (const r of reqs) {
      expect(r.headers.Authorization).toBe(`Bearer ${TOKEN}`);
      expect(r.url).not.toContain(TOKEN);
      expect(r.url.toLowerCase()).not.toContain('token');
    }
    expect(reqs[0].url).toBe('http://localhost:8000/sessions');
    expect(reqs[1].url).toBe('http://localhost:8000/sessions/s%201/series?signals=did.A%2Csensor.b&max_points=2000&from_ms=0&to_ms=5000');
  });

  it('fetches through the injected fetch with the header and parses the answer', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const c = new SessionClient('http://h', TOKEN, async (url, init) => {
      calls.push({ url, headers: init.headers });
      return new Response(JSON.stringify(good), { status: 200 });
    });
    const r = await c.getSeries('s1');
    expect(r.series).toHaveLength(2);
    expect(calls[0].url).toBe('http://h/sessions/s1/series?max_points=2000');
    expect(calls[0].headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('maps HTTP errors to clear messages without the token', async () => {
    const mk = (status: number, body = '') => new Response(body, { status });
    expect(await describeHttpError(mk(401))).toMatch(/token/);
    expect(await describeHttpError(mk(404))).toMatch(/unknown session/);
    expect(await describeHttpError(mk(422, JSON.stringify({ detail: 'unknown signal x' })))).toContain('unknown signal x');
    const c = new SessionClient('http://h', TOKEN, async () => mk(401));
    await expect(c.listSessions()).rejects.toThrow(/401/);
    await expect(new SessionClient('http://h', TOKEN, async () => Promise.reject(new Error(`boom ${TOKEN}`))).listSessions()).rejects.not.toThrow(TOKEN);
  });
});

describe('store: recorded samples', () => {
  it('ingestSample pushes into history, bumps dataVersion and notifies', () => {
    const store = new CaptureStore(DEFS);
    const v0 = store.dataVersion;
    store.ingestSample('sensor:lean', 0.5, 12);
    store.ingestSample('sensor:lean', 0.6, 13);
    expect(store.history.get('sensor:lean')?.length).toBe(2);
    expect(store.dataVersion).toBe(v0 + 2);
    expect(store.lastTime).toBe(0.6);
  });

  it('lists recorded channels with response units; clear() keeps the metadata, a reset drops it', () => {
    const store = new CaptureStore(DEFS);
    store.setRecordedMeta('sensor:lean', { label: 'lean', group: 'session · sensor', unit: 'deg' });
    store.ingestSample('sensor:lean', 0, 1);
    const ch = availableChannels(store).find((c) => c.key === 'sensor:lean');
    expect(ch).toMatchObject({ label: 'lean', group: 'session · sensor', unit: 'deg' });
    store.clear();
    // A backward replay seek clears the views; the labels must survive it.
    expect(store.history.size).toBe(0);
    expect(store.recordedMeta.get('sensor:lean')?.unit).toBe('deg');
    store.ingestSample('sensor:lean', 0, 2);
    expect(availableChannels(store).find((c) => c.key === 'sensor:lean')).toMatchObject({ unit: 'deg' });
    store.resetRecordedMeta();
    expect(store.recordedMeta.size).toBe(0);
  });

  it('a recorded DID lands on the defs DID channel', () => {
    const store = new CaptureStore(DEFS);
    const d = DEFS.vehicle.dids[0];
    store.ingestSample(didKey(d.name), 0, 1);
    const ch = availableChannels(store).find((c) => c.key === didKey(d.name));
    expect(ch?.unit).toBe(d.unit);
  });
});

describe('replayMatchesSession', () => {
  it('matches only the same recorded session replayed from the server', () => {
    expect(replayMatchesSession('ride-1', 'ride-1', 'server_session')).toBe(true);
    expect(replayMatchesSession('ride-1', 'ride-2', 'server_session')).toBe(false);
    expect(replayMatchesSession(null, 'ride-1', 'server_session')).toBe(false);
    expect(replayMatchesSession(null, null, 'server_session')).toBe(false);
    expect(replayMatchesSession('ride-1', 'ride-1', 'local_file')).toBe(false);
  });
});
