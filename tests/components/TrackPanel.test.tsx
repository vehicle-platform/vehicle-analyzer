// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TrackPanel } from '../../src/components/TrackPanel';
import { setThemeColors } from './helpers';

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

  it('survives a zero-size canvas and keeps the bitmap at least one pixel', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 0,
      height: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
    vi.stubGlobal('fetch', loadedFetch());
    render(<TrackPanel {...props()} />);
    await screen.findByText('Dead-reckoned from GNSS speed and heading. Approximate shape, not a map.');
    const canvas = screen.getByRole('img', { name: 'Relative ride track' }) as HTMLCanvasElement;
    expect(canvas.width).toBeGreaterThanOrEqual(1);
    expect(canvas.height).toBeGreaterThanOrEqual(1);
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

/** Recording 2D context + a 400x300 canvas box, so the panel draws and hit-tests in jsdom. */
const stubDrawing = () => {
  vi.stubGlobal(
    'Path2D',
    class {
      moveTo() {}
      lineTo() {}
    }
  );
  const fillRect = vi.fn();
  const noop = vi.fn();
  const ctx = {
    setTransform: noop,
    clearRect: noop,
    stroke: noop,
    beginPath: noop,
    arc: noop,
    fill: noop,
    moveTo: noop,
    lineTo: noop,
    fillText: noop,
    fillRect,
  } as unknown as CanvasRenderingContext2D;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    width: 400,
    height: 300,
    top: 0,
    left: 0,
    right: 400,
    bottom: 300,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
  return { fillRect, lastEnd: () => fillRect.mock.calls[fillRect.mock.calls.length - 1] as number[] };
};

const trackCalls = (fetchMock: ReturnType<typeof vi.fn>) => fetchMock.mock.calls.filter(([url]) => String(url).includes('/track'));
const LOADED = 'Dead-reckoned from GNSS speed and heading. Approximate shape, not a map.';

describe('TrackPanel connection inputs', () => {
  it('does not fetch while the URL or token is edited, only on Refresh', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => (String(input).includes('/track') ? ok(TRACK) : ok(SERIES)));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<TrackPanel {...props()} />);
    await screen.findByText(LOADED);
    const before = fetchMock.mock.calls.length;

    rerender(<TrackPanel {...props({ serverUrl: 'http://localhost:800' })} />);
    rerender(<TrackPanel {...props({ serverUrl: 'http://localhost:8001', token: 'ab' })} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(fetchMock.mock.calls.length).toBe(before);
    expect(screen.getByText(LOADED)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(trackCalls(fetchMock).length).toBe(2));
    expect(String(trackCalls(fetchMock)[1][0]).startsWith('http://localhost:8001/sessions/ride-1/track')).toBe(true);
  });
});

describe('TrackPanel view', () => {
  beforeEach(() => setThemeColors());

  it('keeps the track and the zoom while a colour refetch runs', async () => {
    const { lastEnd } = stubDrawing();
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes('color=')) return new Promise<Response>((resolve) => (release = resolve));
      return ok(url.includes('/track') ? TRACK : SERIES);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<TrackPanel {...props()} />);
    await screen.findByText(LOADED);
    await waitFor(() => expect(screen.getByRole('option', { name: 'sensor.lean_angle' })).toBeTruthy());
    const canvas = screen.getByRole('img', { name: 'Relative ride track' });
    const fitted = lastEnd();

    fireEvent.wheel(canvas, { deltaY: -100, clientX: 40, clientY: 40 });
    await waitFor(() => expect(lastEnd()).not.toEqual(fitted));
    const zoomed = lastEnd();

    fireEvent.change(screen.getByLabelText('Track colour'), { target: { value: 'sensor.lean_angle' } });
    expect(await screen.findByText('loading track...')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'Relative ride track' })).toBe(canvas);

    release(ok({ ...TRACK, color: { name: 'sensor.lean_angle', unit: 'deg' }, segments: [{ ...TRACK.segments[0], color_v: [1, 2, null] }] }));
    await waitFor(() => expect(screen.getByLabelText('Colour legend').textContent).toContain('sensor.lean_angle'));
    expect(lastEnd()).toEqual(zoomed);
  });

  it('registers a non-passive native wheel listener that prevents the page scroll', async () => {
    stubDrawing();
    const add = vi.spyOn(HTMLCanvasElement.prototype, 'addEventListener');
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => ok(String(input).includes('/track') ? TRACK : SERIES)));
    render(<TrackPanel {...props()} />);
    await screen.findByText(LOADED);
    expect(add.mock.calls.some(([type, , options]) => type === 'wheel' && (options as AddEventListenerOptions)?.passive === false)).toBe(true);
    const canvas = screen.getByRole('img', { name: 'Relative ride track' });
    expect(fireEvent.wheel(canvas, { deltaY: -100 })).toBe(false);
  });
});

describe('TrackPanel seek', () => {
  const setup = async (over: Partial<React.ComponentProps<typeof TrackPanel>> = {}) => {
    stubDrawing();
    setThemeColors();
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL | Request) => ok(String(input).includes('/track') ? TRACK : SERIES)));
    const p = props(over);
    render(<TrackPanel {...p} />);
    await screen.findByText(LOADED);
    return { p, canvas: screen.getByRole('img', { name: 'Relative ride track' }) };
  };

  it('seeks to the clicked point when the replay is the same session', async () => {
    const { p, canvas } = await setup();
    // The view is fitted after the first layout pass, so retry the click until it lands.
    await waitFor(() => {
      fireEvent.click(canvas, { clientX: 200, clientY: 150 });
      expect(p.onSeekTime).toHaveBeenCalledWith(100);
    });
    expect(screen.queryByText(/to sync/)).toBeNull();
  });

  it('does not seek and shows a hint when the replay is another session or a log', async () => {
    const { p, canvas } = await setup({ replaySynced: false });
    fireEvent.click(canvas, { clientX: 200, clientY: 150 });
    expect(p.onSeekTime).not.toHaveBeenCalled();
    expect(screen.getByText('Open this session in Recorded sessions (E) to sync.')).toBeTruthy();
  });

  it('pans only with the primary button', async () => {
    const { p, canvas } = await setup();
    fireEvent.pointerDown(canvas, { button: 2, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(canvas, { button: 2, clientX: 160, clientY: 160 });
    fireEvent.pointerUp(canvas, { button: 2 });
    await waitFor(() => {
      fireEvent.click(canvas, { clientX: 200, clientY: 150 });
      expect(p.onSeekTime).toHaveBeenCalledWith(100);
    });
  });
});
