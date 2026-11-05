// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RideSummary } from '../../src/components/RideSummary';
import { jsonResponse } from './helpers';

const fail = (status: number, body: unknown) =>
  ({
    ok: false,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const summary = {
  session_id: 'ride-1',
  ride_definition: 'cl250_ride',
  defs_version: '1.2.0',
  signals: [
    { name: 'derived.trip_distance', status: 'computed', unit: 'km', range: [0, 200], kind: 'scalar', value: 12.345, flag: 'ok' },
    {
      name: 'derived.idle_time',
      status: 'computed',
      unit: 's',
      range: [0, 200],
      kind: 'binned',
      axes: [{ input: 'derived.speed_kmh', unit: 'km/h', edges: [[0, 30], [30, 60]] }],
      cells: [
        { index: 0, axes: [0], value: 12, flag: null },
        { index: 1, axes: [1], value: 3, flag: null },
      ],
      total_s: 200,
      outside_s: 1,
    },
    {
      name: 'derived.operating_point_time',
      status: 'computed',
      unit: 's',
      range: [0, 200],
      kind: 'binned',
      axes: [
        { input: 'derived.speed_kmh', unit: 'km/h', edges: [[0, 30], [30, 60]] },
        { input: 'did.ENGINE_SPEED', unit: 'rpm', edges: [[0, 2000], [2000, 4000], [4000, 6000]] },
      ],
      cells: [{ index: 0, axes: [1, 2], value: 8, flag: null }],
      total_s: 200,
      outside_s: 0,
      defs_mismatch: true,
    },
    { name: 'derived.stopped_time', status: 'not_ready', reason: 'ride too short', pending_inputs: ['derived.speed_kmh'] },
  ],
};

const props = (over: Partial<React.ComponentProps<typeof RideSummary>> = {}) => ({
  token: '',
  serverUrl: 'http://localhost:8000',
  sessionId: 'ride-1',
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RideSummary states', () => {
  it('says when no server or no session is selected', () => {
    const { rerender } = render(<RideSummary {...props({ serverUrl: '' })} />);
    expect(screen.getByText('No vehicle-server URL configured.')).toBeTruthy();
    rerender(<RideSummary {...props({ sessionId: null })} />);
    expect(screen.getByText('No recorded session selected.')).toBeTruthy();
  });

  it('shows the loading state', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    render(<RideSummary {...props()} />);
    expect(screen.getByText('Loading ride summary...')).toBeTruthy();
  });

  it('shows the no-summary state, not a generic error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(404, { detail: 'session has no ride summary' })));
    render(<RideSummary {...props()} />);
    expect(await screen.findByText('No stored ride summary for this session.')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a readable error and retries', async () => {
    const fetchMock = vi.fn(async () => fail(500, {}));
    vi.stubGlobal('fetch', fetchMock);
    render(<RideSummary {...props()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Server error \(500\)/);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });
});

describe('RideSummary loaded state', () => {
  it('draws scalars, a one-axis bar chart, a two-axis heat grid and the mismatch warning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(summary)));
    render(<RideSummary {...props()} />);

    expect(await screen.findByText('12.35')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Ride summary scalars' }).textContent).toContain('derived.trip_distance');
    expect(screen.getByRole('img', { name: 'derived.idle_time bins' })).toBeTruthy();
    expect(screen.getByRole('img', { name: 'derived.operating_point_time heat grid' })).toBeTruthy();
    expect(screen.getByText('! stored bin edges differ from the pinned defs')).toBeTruthy();
    expect(screen.getByText('ride cl250_ride')).toBeTruthy();
    expect(screen.getByText('defs 1.2.0')).toBeTruthy();
    expect(screen.getByText('3 computed')).toBeTruthy();
  });

  it('collapses the non-computed signals and shows status and reason', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(summary)));
    render(<RideSummary {...props()} />);
    expect(await screen.findByText('not available (1)')).toBeTruthy();
    fireEvent.click(screen.getByText('not available (1)'));
    expect(screen.getByText('not_ready')).toBeTruthy();
    expect(screen.getByText(/ride too short/)).toBeTruthy();
  });

  it('draws per-gear values in gear order with the response unit, flag and range precision', async () => {
    const perGearSummary = {
      ...summary,
      signals: [
        {
          name: 'ride_final_drive_ratio',
          status: 'computed',
          unit: 'ratio',
          range: [2, 3.5],
          kind: 'per_gear',
          gears: [
            { gear: 4, value: null, flag: 'no_steady_samples' },
            { gear: 1, value: 2.64, flag: null },
          ],
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(perGearSummary)));
    render(<RideSummary {...props()} />);

    expect(await screen.findByText('ride_final_drive_ratio')).toBeTruthy();
    const table = screen.getByRole('table', { name: 'ride_final_drive_ratio per gear' });
    expect(table.textContent).toContain('gear 1');
    expect(table.textContent).toContain('2.6400');
    expect(table.textContent).toContain('ratio');
    expect(table.textContent).toContain('gear 4');
    expect(table.textContent).toContain('no_steady_samples');
    expect(table.textContent?.indexOf('gear 1')).toBeLessThan(table.textContent?.indexOf('gear 4') ?? -1);
  });

  it('keeps the card and shows a malformed per-gear entry as unavailable', async () => {
    const malformed = {
      ...summary,
      signals: [
        {
          name: 'ride_final_drive_ratio',
          status: 'computed',
          unit: 'ratio',
          range: [2, 3.5],
          kind: 'per_gear',
          gears: [{ gear: 1.5, value: 2.64, flag: null }],
        },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(malformed)));
    render(<RideSummary {...props()} />);

    expect(await screen.findByText('ride cl250_ride')).toBeTruthy();
    expect(screen.getByText('not available (1)')).toBeTruthy();
    fireEvent.click(screen.getByText('not available (1)'));
    expect(screen.getByText('ride_final_drive_ratio')).toBeTruthy();
    expect(screen.getByText(/malformed per_gear/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says so when a per-gear signal stored no gear', async () => {
    const empty = {
      ...summary,
      signals: [{ name: 'ride_final_drive_ratio', status: 'computed', unit: 'ratio', range: [2, 3.5], kind: 'per_gear', gears: [] }],
    };
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(empty)));
    render(<RideSummary {...props()} />);

    expect(await screen.findByText('No gear stored for this ride.')).toBeTruthy();
    expect(screen.queryByRole('table', { name: 'ride_final_drive_ratio per gear' })).toBeNull();
  });

  it('fetches once per selected session, not per render or URL keystroke', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(summary));
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<RideSummary {...props()} />);
    await screen.findByText('12.35');
    view.rerender(<RideSummary {...props({ serverUrl: 'http://localhost:8001' })} />);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    view.rerender(<RideSummary {...props({ sessionId: 'ride-2' })} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toContain('/sessions/ride-2/summary');
  });
});
