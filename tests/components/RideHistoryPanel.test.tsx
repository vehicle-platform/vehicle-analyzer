// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RideHistoryPanel } from '@/components/RideHistoryPanel';
import { jsonResponse } from './helpers';

const response = {
  columns: [
    { name: 'derived.trip_distance', unit: 'km' },
    { name: 'derived.idle_time', unit: 's' },
  ],
  rows: [
    { session_id: 'ride-1', created_utc: '2026-01-01T10:00:00Z', values: { 'derived.trip_distance': 10, 'derived.idle_time': 1 }, flags: { 'derived.trip_distance': 'ok', 'derived.idle_time': 'ok' } },
    { session_id: 'ride-2', created_utc: '2026-01-02T10:00:00Z', values: { 'derived.trip_distance': 20, 'derived.idle_time': null }, flags: { 'derived.trip_distance': 'ok', 'derived.idle_time': 'missing' } },
    { session_id: 'ride-3', created_utc: '2026-01-03T10:00:00Z', values: { 'derived.trip_distance': null, 'derived.idle_time': 3 }, flags: { 'derived.trip_distance': 'missing', 'derived.idle_time': 'ok' } },
    { session_id: 'ride-4', created_utc: '2026-01-04T10:00:00Z', values: { 'derived.trip_distance': 40, 'derived.idle_time': 4 }, flags: { 'derived.trip_distance': 'ok', 'derived.idle_time': 'ok' } },
    { session_id: 'ride-5', created_utc: '2026-01-05T10:00:00Z', values: { 'derived.trip_distance': 50, 'derived.idle_time': 5 }, flags: { 'derived.trip_distance': 'ok', 'derived.idle_time': 'ok' } },
  ],
  skipped: 1,
};

const fail = (status: number, body: unknown) =>
  ({
    ok: false,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const props = (over: Partial<React.ComponentProps<typeof RideHistoryPanel>> = {}) => ({
  token: '',
  onTokenChange: vi.fn(),
  serverUrl: 'http://localhost:8000',
  onServerUrlChange: vi.fn(),
  onOpenSession: vi.fn(),
  ...over,
});

const load = async () => {
  fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
  await screen.findByText('5 rides · 1 skipped.');
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('RideHistoryPanel states', () => {
  it('says when no server is configured', async () => {
    render(<RideHistoryPanel {...props({ serverUrl: '' })} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/No vehicle-server URL configured/);
  });

  it('shows a readable error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(500, {})));
    render(<RideHistoryPanel {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Server error \(500\)/);
  });

  it('shows the empty state before loading and when the server has no columns', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({ columns: [], rows: [], skipped: 0 })));
    render(<RideHistoryPanel {...props()} />);
    expect(screen.getByText(/Refresh to load the ride table/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('The server returned no scalar columns.')).toBeTruthy();
  });
});

describe('RideHistoryPanel loaded state', () => {
  it('builds the column picker from the response and defaults to the first column', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(response)));
    render(<RideHistoryPanel {...props()} />);
    await load();

    expect(screen.getByRole('button', { name: /derived\.trip_distance/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /derived\.idle_time/ })).toBeTruthy();
    expect(screen.getByText('columns 1/4')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'derived.trip_distance ride history' })).toBeTruthy();
    expect(screen.queryByRole('img', { name: 'derived.idle_time ride history' })).toBeNull();
  });

  it('adds a second chart and breaks lines at null values', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(response)));
    render(<RideHistoryPanel {...props()} />);
    await load();
    const chart = screen.getByRole('img', { name: 'derived.trip_distance ride history' });
    expect(chart.querySelectorAll('polyline')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /derived\.idle_time/ }));
    expect(screen.getByText('columns 2/4')).toBeTruthy();
    expect(screen.getByRole('img', { name: 'derived.idle_time ride history' })).toBeTruthy();
  });

  it('sends the optional date range and switches the x axis', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(response));
    vi.stubGlobal('fetch', fetchMock);
    render(<RideHistoryPanel {...props()} />);
    fireEvent.change(screen.getByLabelText('Rides from (UTC)'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('Rides to (UTC)'), { target: { value: '2026-01-05' } });
    await load();
    expect(String(fetchMock.mock.calls[0][0])).toContain('from=2026-01-01&to=2026-01-05');

    fireEvent.click(screen.getByRole('radio', { name: 'created_utc' }));
    await waitFor(() => expect(screen.getByText('2026-01-01 10:00')).toBeTruthy());
    expect(screen.getByText('2026-01-05 10:00')).toBeTruthy();
  });

  it('opens a session when a point is clicked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(response)));
    const onOpenSession = vi.fn();
    render(<RideHistoryPanel {...props({ onOpenSession })} />);
    await load();
    fireEvent.click(screen.getByRole('button', { name: /ride-2/ }));
    expect(onOpenSession).toHaveBeenCalledWith('ride-2');
  });
});
