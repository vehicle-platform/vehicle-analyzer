// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TrackPanel } from '../../src/components/TrackPanel';

const TRACK = {
  session_id: 'ride-1',
  t0_device_ms: 8600,
  method: 'dead_reckoning',
  frame: 'relative_enu_from_first_fix',
  max_points: 2000,
  points_total: 3,
  downsampled: false,
  path_length_m: 12.5,
  segments_total: 1,
  excluded: { no_fix: 0, stale_fix: 0, untrusted_heading: 0 },
  color: null,
  segments: [
    {
      t_ms: [0, 100, 200],
      x_m: [0, 1, 2],
      y_m: [0, 1, 2],
      speed_mps: [1, 2, 3],
      heading_deg: [0, 45, 90],
      gap_before_ms: null,
    },
  ],
};

const ok = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const fail = (status: number, body: unknown) =>
  ({
    ok: false,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const SERIES = {
  session_id: 'ride-1',
  t0_device_ms: 8600,
  max_points: 10,
  series: [
    { name: 'sensor.gps_ground_speed', kind: 'sensor', unit: 'm/s', t_ms: [0], v: [1] },
    { name: 'sensor.lean_angle', kind: 'sensor', unit: 'deg', t_ms: [0], v: [1] },
    { name: 'sensor.gps_latitude', kind: 'sensor', unit: 'deg', t_ms: [0], v: [1] },
  ],
};

const props = (over: Partial<React.ComponentProps<typeof TrackPanel>> = {}) => ({
  token: '',
  onTokenChange: vi.fn(),
  serverUrl: 'http://localhost:8000',
  onServerUrlChange: vi.fn(),
  sessionId: 'ride-1',
  replayTimeSec: 0,
  onSeekTime: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('TrackPanel states', () => {
  it('says when no server is configured', () => {
    render(<TrackPanel {...props({ serverUrl: '', sessionId: null })} />);
    expect(screen.getByText(/No vehicle-server URL configured/)).toBeTruthy();
  });

  it('says when no recorded session is selected', () => {
    render(<TrackPanel {...props({ sessionId: null })} />);
    expect(screen.getByText('No recorded session selected. Pick one in Sessions (E).')).toBeTruthy();
  });

  it('shows the no-GPS state, not a generic error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/track')) return fail(404, { detail: 'session has no GPS' });
        return ok(SERIES);
      })
    );
    render(<TrackPanel {...props()} />);
    expect(await screen.findByText('No GPS in this session.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a readable error for a failed request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes('/track')) return fail(500, {});
        return ok(SERIES);
      })
    );
    render(<TrackPanel {...props()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Server error \(500\)/);
  });
});

describe('TrackPanel loaded state', () => {
  const loadedFetch = (color?: string) =>
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('/track')) {
        if (!color) return ok(TRACK);
        return ok({
          ...TRACK,
          color: { name: color, unit: 'deg' },
          segments: [{ ...TRACK.segments[0], color_v: [1, 2, null] }],
        });
      }
      return ok(SERIES);
    });

  it('draws the relative track, legend, caption and only offers session series names', async () => {
    const fetchMock = loadedFetch();
    vi.stubGlobal('fetch', fetchMock);
    render(<TrackPanel {...props()} />);

    expect(await screen.findByText('Dead-reckoned from GNSS speed and heading. Approximate shape, not a map.')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Relative ride track' })).toBeTruthy();
    expect(screen.getByLabelText('Colour legend').textContent).toContain('speed');
    expect(screen.getByText(/12.5 m path/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('option', { name: 'sensor.lean_angle' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'sensor.gps_latitude' })).toBeNull();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/track'))).toBe(true);
  });

  it('refetches with color= and shows the response name/unit in the legend', async () => {
    const fetchMock = loadedFetch('sensor.lean_angle');
    vi.stubGlobal('fetch', fetchMock);
    render(<TrackPanel {...props()} />);
    await screen.findByText('Dead-reckoned from GNSS speed and heading. Approximate shape, not a map.');
    await waitFor(() => expect(screen.getByRole('option', { name: 'sensor.lean_angle' })).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Track colour'), { target: { value: 'sensor.lean_angle' } });

    await waitFor(() => expect(screen.getByLabelText('Colour legend').textContent).toContain('sensor.lean_angle'));
    expect(screen.getByLabelText('Colour legend').textContent).toContain('deg');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('color=sensor.lean_angle'))).toBe(true);
  });
});
