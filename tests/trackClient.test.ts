import { describe, expect, it, vi } from 'vitest';
import {
  NoGpsInSessionError,
  TrackClient,
  parseTrackResponse,
  trackRequest,
} from '@/services/trackClient';

const good = {
  session_id: 'ride-1',
  t0_device_ms: 8600,
  method: 'dead_reckoning',
  frame: 'relative_enu_from_first_fix',
  max_points: 2000,
  points_total: 3,
  downsampled: false,
  path_length_m: 12.5,
  segments_total: 1,
  excluded: { no_fix: 1, stale_fix: 2, untrusted_heading: 0 },
  color: { name: 'sensor.gps_ground_speed', unit: 'm/s' },
  segments: [
    {
      t_ms: [0, 100, 200],
      x_m: [0, 1, 2],
      y_m: [0, 1, 2],
      speed_mps: [1, 2, 3],
      heading_deg: [0, 45, 90],
      color_v: [1, null, 3],
      gap_before_ms: null,
    },
  ],
};

const okResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const errorResponse = (status: number, body: unknown, statusText = '') =>
  ({
    ok: false,
    status,
    statusText,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

describe('parseTrackResponse', () => {
  it('reads a well-formed relative track', () => {
    const track = parseTrackResponse(good);
    expect(track).toMatchObject({
      sessionId: 'ride-1',
      t0DeviceMs: 8600,
      method: 'dead_reckoning',
      frame: 'relative_enu_from_first_fix',
      pathLengthM: 12.5,
      segmentsTotal: 1,
      excluded: { noFix: 1, staleFix: 2, untrustedHeading: 0 },
      color: { name: 'sensor.gps_ground_speed', unit: 'm/s' },
    });
    expect(track.segments[0]).toMatchObject({ tMs: [0, 100, 200], xM: [0, 1, 2], colorV: [1, null, 3], gapBeforeMs: null });
  });

  it('accepts a track without a colour series', () => {
    const { color: _color, ...noColor } = good;
    const segments = [{ ...good.segments[0], color_v: undefined }];
    const track = parseTrackResponse({ ...noColor, color: null, segments });
    expect(track.color).toBeNull();
    expect(track.segments[0].colorV).toBeNull();
  });

  it('accepts a colour series without a unit', () => {
    const track = parseTrackResponse({ ...good, color: { name: 'sensor.lean_angle', unit: null } });
    expect(track.color).toEqual({ name: 'sensor.lean_angle', unit: null });
  });

  it('rejects inconsistent or non-finite data', () => {
    const bad = (patch: Record<string, unknown>) => () => parseTrackResponse({ ...good, ...patch });
    expect(bad({ method: 'gps' })).toThrow(/method/);
    expect(bad({ frame: 'absolute' })).toThrow(/frame/);
    expect(bad({ segments_total: 2 })).toThrow(/segments_total/);
    expect(bad({ path_length_m: Number.NaN })).toThrow(/path_length_m/);
    expect(
      bad({ segments: [{ ...good.segments[0], x_m: [0, 1] }] })
    ).toThrow(/different lengths/);
    expect(
      bad({ segments: [{ ...good.segments[0], speed_mps: [1, 2, Number.POSITIVE_INFINITY] }] })
    ).toThrow(/non-finite/);
    expect(
      bad({ segments: [{ ...good.segments[0], t_ms: [0, 200, 100] }] })
    ).toThrow(/sorted/);
    expect(
      bad({ segments: [{ ...good.segments[0], color_v: [1, 2] }] })
    ).toThrow(/color_v/);
    expect(bad({ excluded: { no_fix: 0 } })).toThrow(/stale_fix/);
    expect(bad({ color: { name: 'x' } })).toThrow(/color/);
  });

  it('rejects a missing color_v when a colour was requested', () => {
    const segments = [{ ...good.segments[0], color_v: undefined }];
    expect(() => parseTrackResponse({ ...good, segments })).toThrow(/color_v/);
  });
});

describe('trackRequest', () => {
  it('puts the token in the header and the colour in the query', () => {
    const req = trackRequest('http://localhost:8000/', 'secret', 'ride/1', {
      maxPoints: 10,
      minHeadingSpeedMps: 2.5,
      color: 'sensor.lean_angle',
      fromMs: 100,
      toMs: 200,
    });
    expect(req.url).toBe(
      'http://localhost:8000/sessions/ride%2F1/track?max_points=10&min_heading_speed_mps=2.5&color=sensor.lean_angle&from_ms=100&to_ms=200'
    );
    expect(req.headers.Authorization).toBe('Bearer secret');
    expect(req.url).not.toContain('secret');
  });
});

describe('TrackClient', () => {
  it('returns the parsed track and never puts the token in the URL', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => okResponse(good));
    const client = new TrackClient('http://localhost:8000', 'secret', fetchMock);
    const track = await client.getTrack('ride-1', { color: 'sensor.gps_ground_speed' });
    expect(track.sessionId).toBe('ride-1');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/sessions/ride-1/track?color=sensor.gps_ground_speed');
    expect(String(url)).not.toContain('secret');
    expect(init.headers.Authorization).toBe('Bearer secret');
  });

  it('maps 404 session has no GPS to a state error, not a generic failure', async () => {
    const client = new TrackClient('http://localhost:8000', '', async () =>
      errorResponse(404, { detail: 'session has no GPS' }, 'Not Found')
    );
    await expect(client.getTrack('ride-1')).rejects.toBeInstanceOf(NoGpsInSessionError);
  });

  it('keeps unknown session, auth and network errors readable', async () => {
    const notFound = new TrackClient('http://localhost:8000', '', async () =>
      errorResponse(404, { detail: 'unknown session: nope' }, 'Not Found')
    );
    await expect(notFound.getTrack('nope')).rejects.toThrow(/unknown session/);
    const unauthorized = new TrackClient('http://localhost:8000', '', async () => errorResponse(401, {}, 'Unauthorized'));
    await expect(unauthorized.getTrack('ride-1')).rejects.toThrow(/Unauthorized/);
    const offline = new TrackClient('http://localhost:8000', '', async () => {
      throw new Error('offline');
    });
    await expect(offline.getTrack('ride-1')).rejects.toThrow(/Cannot reach the server/);
  });

  it('rejects a non-JSON answer', async () => {
    const client = new TrackClient('http://localhost:8000', '', async () =>
      ({ ok: true, status: 200, statusText: 'OK', json: async () => { throw new Error('nope'); }, text: async () => 'nope' }) as unknown as Response
    );
    await expect(client.getTrack('ride-1')).rejects.toThrow(/not JSON/);
  });
});
