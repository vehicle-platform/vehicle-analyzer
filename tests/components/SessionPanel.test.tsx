// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SessionPanel } from '../../src/components/SessionPanel';
import { jsonResponse } from './helpers';

function installStorage(): Storage {
  const values = new Map<string, string>();
  const storage = {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key: string) => values.get(key) ?? null,
    key: (index: number) => [...values.keys()][index] ?? null,
    removeItem: (key: string) => values.delete(key),
    setItem: (key: string, value: string) => values.set(key, value),
  } as Storage;
  Object.defineProperty(window, 'localStorage', { configurable: true, value: storage });
  return storage;
}

beforeEach(() => {
  installStorage();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('SessionPanel', () => {
  it('lists sessions from the read-only client without hardware', async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/sessions')) return jsonResponse([{ session_id: 'ride-1', started_at: 1 }]);
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(
      <SessionPanel
        token=""
        onTokenChange={vi.fn()}
        serverUrl="http://localhost:8000"
        onServerUrlChange={vi.fn()}
        onLoad={vi.fn()}
      />
    );

    expect(screen.getByText('recorded sessions')).toBeTruthy();
    expect(screen.getByText('No sessions loaded. Enter the URL and token, then Refresh.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));

    expect(await screen.findByText('ride-1')).toBeTruthy();
    expect(screen.getByText('1 session on the server.')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


const ROWS = [
  { session_id: 'ride-1', status: 'ok', created_utc: '2026-01-15T10:00:00Z', loss_percent: 0.5 },
  { session_id: 'ride-2', status: 'warn', created_utc: '2026-01-15T12:00:00Z', loss_percent: 2 },
  { session_id: 'ride-3', status: 'warn', created_utc: '2026-01-16T09:00:00Z', loss_percent: 1 },
];

function renderPanel() {
  return render(
    <SessionPanel
      token=""
      onTokenChange={vi.fn()}
      serverUrl="http://localhost:8000"
      onServerUrlChange={vi.fn()}
      onLoad={vi.fn()}
    />
  );
}

async function loadRows() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/sessions')) return jsonResponse(ROWS);
      return jsonResponse({});
    })
  );
  renderPanel();
  fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
  await screen.findByText('ride-1');
}

describe('SessionPanel filters', () => {
  it('filters by session id and by status values from the data', async () => {
    await loadRows();

    expect(screen.getByRole('button', { name: /ok/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /warn/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /fail/ })).toBeNull();

    fireEvent.change(screen.getByLabelText('Filter sessions by id'), { target: { value: 'RIDE-2' } });
    expect(screen.getByText('ride-2')).toBeTruthy();
    expect(screen.queryByText('ride-1')).toBeNull();
    expect(screen.queryByText('ride-3')).toBeNull();

    fireEvent.change(screen.getByLabelText('Filter sessions by id'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /warn/ }));
    expect(screen.getByText('ride-2')).toBeTruthy();
    expect(screen.getByText('ride-3')).toBeTruthy();
    expect(screen.queryByText('ride-1')).toBeNull();
  });

  it('filters created_utc by whole UTC days and remembers the filter', async () => {
    await loadRows();

    fireEvent.change(screen.getByLabelText('Created from (UTC)'), { target: { value: '2026-01-15' } });
    fireEvent.change(screen.getByLabelText('Created to (UTC)'), { target: { value: '2026-01-15' } });
    expect(screen.getByText('ride-1')).toBeTruthy();
    expect(screen.getByText('ride-2')).toBeTruthy();
    expect(screen.queryByText('ride-3')).toBeNull();

    fireEvent.change(screen.getByLabelText('Filter sessions by id'), { target: { value: 'ride-2' } });
    expect(JSON.parse(window.localStorage.getItem('vehicle-analyzer.session-filter.v1') ?? '{}').text).toBe('ride-2');

    cleanup();
    renderPanel();
    expect((screen.getByLabelText('Filter sessions by id') as HTMLInputElement).value).toBe('ride-2');
  });
});

describe('SessionPanel ride summary', () => {
  it('shows the ride summary card for the selected session', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/sessions')) return jsonResponse([{ session_id: 'ride-1' }]);
        if (url.endsWith('/summary')) {
          return jsonResponse({
            session_id: 'ride-1',
            ride_definition: 'cl250_ride',
            defs_version: '1.2.0',
            signals: [{ name: 'derived.trip_distance', status: 'computed', unit: 'km', range: [0, 200], kind: 'scalar', value: 12.3, flag: 'ok' }],
          });
        }
        return jsonResponse({});
      })
    );
    renderPanel();
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    fireEvent.click(await screen.findByText('ride-1'));

    expect(await screen.findByText('12.30')).toBeTruthy();
    expect(screen.getByText('ride summary')).toBeTruthy();
  });
});
