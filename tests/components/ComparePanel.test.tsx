// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ComparePanel } from '../../src/components/ComparePanel';
import { DEFS } from '../../src/defs';
import { jsonResponse, setThemeColors } from './helpers';

afterEach(() => {
  cleanup();
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
