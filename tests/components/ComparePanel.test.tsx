// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ComparePanel } from '../../src/components/ComparePanel';
import { DEFS } from '../../src/defs';
import { jsonResponse, setThemeColors } from './helpers';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ComparePanel', () => {
  it('compares two sessions on the time axis without hardware', async () => {
    setThemeColors();
    const did = DEFS.vehicle.dids[0];
    const series = (values: number[]) => ({
      session_id: 'session',
      max_points: 2000,
      series: [{ name: `did.${did.name}`, kind: 'did', unit: did.unit, t_ms: [0, 1000], v: values }],
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/sessions')) return jsonResponse([{ session_id: 'A' }, { session_id: 'B' }]);
      if (url.includes('/sessions/A/series')) return jsonResponse(series([1, 2]));
      if (url.includes('/sessions/B/series')) return jsonResponse(series([2, 3]));
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<ComparePanel token="" onTokenChange={vi.fn()} serverUrl="http://localhost:8000" onServerUrlChange={vi.fn()} />);

    expect(screen.getByText('Pick two sessions (Refresh first) and press Compare.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('2 sessions on the server.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Session A'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Session B'), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: /Compare/ }));

    expect(await screen.findByText(/difference B/)).toBeTruthy();
    expect(screen.getAllByRole('img')).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});


  it('draws both relative tracks on one canvas when toggled', async () => {
    setThemeColors();
    const did = DEFS.vehicle.dids[0];
    const series = (values: number[]) => ({
      session_id: 'session',
      max_points: 2000,
      series: [{ name: `did.${did.name}`, kind: 'did', unit: did.unit, t_ms: [0, 1000], v: values }],
    });
    const track = (id: string) => ({
      session_id: id,
      t0_device_ms: 0,
      method: 'dead_reckoning',
      frame: 'relative_enu_from_first_fix',
      max_points: 2000,
      points_total: 2,
      downsampled: false,
      path_length_m: 1,
      segments_total: 1,
      excluded: { no_fix: 0, stale_fix: 0, untrusted_heading: 0 },
      color: null,
      segments: [
        {
          t_ms: [0, 1000],
          x_m: [0, 1],
          y_m: [0, 1],
          speed_mps: [1, 2],
          heading_deg: [0, 0],
          gap_before_ms: null,
        },
      ],
    });
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/sessions')) return jsonResponse([{ session_id: 'A' }, { session_id: 'B' }]);
      if (url.includes('/sessions/A/series')) return jsonResponse(series([1, 2]));
      if (url.includes('/sessions/B/series')) return jsonResponse(series([2, 3]));
      if (url.includes('/sessions/A/track')) return jsonResponse(track('A'));
      if (url.includes('/sessions/B/track')) return jsonResponse(track('B'));
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      lineWidth: 0,
      lineCap: '',
      lineJoin: '',
      strokeStyle: '',
    } as unknown as CanvasRenderingContext2D);

    render(<ComparePanel token="" onTokenChange={vi.fn()} serverUrl="http://localhost:8000" onServerUrlChange={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText('2 sessions on the server.');
    fireEvent.change(screen.getByLabelText('Session A'), { target: { value: 'A' } });
    fireEvent.change(screen.getByLabelText('Session B'), { target: { value: 'B' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));

    expect(await screen.findByRole('img', { name: 'Compare relative tracks' })).toBeTruthy();
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/track')).length).toBe(2);
    expect(screen.getByText(/each from its own origin/)).toBeTruthy();
  });


const trackBody = (id: string, pathLengthM: number) => ({
  session_id: id,
  t0_device_ms: 0,
  method: 'dead_reckoning',
  frame: 'relative_enu_from_first_fix',
  max_points: 2000,
  points_total: 2,
  downsampled: false,
  path_length_m: pathLengthM,
  segments_total: 1,
  excluded: { no_fix: 0, stale_fix: 0, untrusted_heading: 0 },
  color: null,
  segments: [{ t_ms: [0, 1000], x_m: [0, 1], y_m: [0, 1], speed_mps: [1, 2], heading_deg: [0, 0], gap_before_ms: null }],
});

describe('ComparePanel tracks overlay', () => {
  const panelProps = (over: Partial<React.ComponentProps<typeof ComparePanel>> = {}) => ({
    token: '',
    onTokenChange: vi.fn(),
    serverUrl: 'http://localhost:8000',
    onServerUrlChange: vi.fn(),
    ...over,
  });
  const pickSessions = async (a: string, b: string) => {
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await screen.findByText('3 sessions on the server.');
    fireEvent.change(screen.getByLabelText('Session A'), { target: { value: a } });
    fireEvent.change(screen.getByLabelText('Session B'), { target: { value: b } });
  };
  const sessionsList = () => jsonResponse([{ session_id: 'A' }, { session_id: 'B' }, { session_id: 'C' }]);

  it('ignores a slower older track response that arrives after a newer one', async () => {
    setThemeColors();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const pending = new Map<string, (r: Response) => void>();
    const fetchMock = vi.fn((input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/sessions')) return Promise.resolve(sessionsList());
      const id = /\/sessions\/(\w+)\/track/.exec(url)?.[1];
      if (id) return new Promise<Response>((resolve) => pending.set(`${id}#${pending.size}`, resolve));
      return Promise.resolve(jsonResponse({}));
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<ComparePanel {...panelProps()} />);
    await pickSessions('A', 'B');
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    await waitFor(() => expect(pending.size).toBe(2));
    fireEvent.change(screen.getByLabelText('Session B'), { target: { value: 'C' } });
    await waitFor(() => expect(pending.size).toBe(4));
    rerender(<ComparePanel {...panelProps()} />);

    // Newer request (A, C) answers first, then the stale one (A, B) with another path length.
    pending.get('A#2')?.(jsonResponse(trackBody('A', 10)));
    pending.get('C#3')?.(jsonResponse(trackBody('C', 20)));
    expect(await screen.findByText(/path A 10 m, B 20 m/)).toBeTruthy();
    pending.get('A#0')?.(jsonResponse(trackBody('A', 111)));
    pending.get('B#1')?.(jsonResponse(trackBody('B', 222)));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/path A 10 m, B 20 m/)).toBeTruthy();
    expect(screen.queryByText(/222/)).toBeNull();
  });

  it('does not refetch the tracks while the URL or token is edited', async () => {
    setThemeColors();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/sessions')) return sessionsList();
      const id = /\/sessions\/(\w+)\/track/.exec(url)?.[1];
      return id ? jsonResponse(trackBody(id, 5)) : jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(<ComparePanel {...panelProps()} />);
    await pickSessions('A', 'B');
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    await screen.findByText(/path A 5 m, B 5 m/);
    const trackFetches = () => fetchMock.mock.calls.filter(([url]) => String(url).includes('/track')).length;
    expect(trackFetches()).toBe(2);

    rerender(<ComparePanel {...panelProps({ serverUrl: 'http://localhost:80', token: 'x' })} />);
    await new Promise((r) => setTimeout(r, 20));
    expect(trackFetches()).toBe(2);
    expect(screen.getByText(/path A 5 m, B 5 m/)).toBeTruthy();
  });

  it('draws at the canvas CSS size times the device pixel ratio, with the shared track layer', async () => {
    setThemeColors();
    vi.stubGlobal('devicePixelRatio', 2);
    vi.stubGlobal(
      'Path2D',
      class {
        moveTo() {}
        lineTo() {}
      }
    );
    const noop = vi.fn();
    const setTransform = vi.fn();
    const fillRect = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      setTransform,
      clearRect: noop,
      stroke: noop,
      beginPath: noop,
      arc: noop,
      fill: noop,
      fillRect,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 220, top: 0, left: 0, right: 300, bottom: 220, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/sessions')) return sessionsList();
        const id = /\/sessions\/(\w+)\/track/.exec(url)?.[1];
        return id ? jsonResponse(trackBody(id, 5)) : jsonResponse({});
      })
    );
    render(<ComparePanel {...panelProps()} />);
    await pickSessions('A', 'B');
    fireEvent.click(screen.getByRole('button', { name: 'Tracks' }));
    const canvas = (await screen.findByRole('img', { name: 'Compare relative tracks' })) as HTMLCanvasElement;
    await waitFor(() => expect(fillRect).toHaveBeenCalled());
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(440);
    expect(setTransform).toHaveBeenCalledWith(2, 0, 0, 2, 0, 0);
    // Two tracks, one end marker each.
    expect(fillRect).toHaveBeenCalledTimes(2);
  });
});
