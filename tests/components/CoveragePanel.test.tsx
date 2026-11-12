// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CoveragePanel } from '@/components/CoveragePanel';
import { DEFS } from '@/defs';
import { buildCoverage } from '@/services/coverage';
import { downloadFile } from '@/services/exportService';
import { jsonResponse } from './helpers';

vi.mock('../../src/services/exportService', () => ({ downloadFile: vi.fn() }));

const baseProps = () => ({
  token: 'test-token',
  onTokenChange: vi.fn(),
  serverUrl: 'http://localhost:8000',
  onServerUrlChange: vi.fn(),
  selectedSessionId: null as string | null,
});

const renderPanel = (over: Partial<ReturnType<typeof baseProps>> = {}) => render(<CoveragePanel {...baseProps()} {...over} />);

const rowCount = () => screen.getByRole('table', { name: 'Signal coverage' }).querySelectorAll('tbody tr').length;

beforeEach(() => {
  vi.mocked(downloadFile).mockClear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('CoveragePanel', () => {
  it('renders every group from the bundled defs', () => {
    renderPanel();
    const total =
      DEFS.vehicle.dids.length +
      DEFS.catalog.filter((entry) => entry.status === 'candidate').length +
      DEFS.identification.length +
      DEFS.sensors.length +
      DEFS.derivedSignals.length;

    expect(screen.getByText(`${total} values from the bundled defs`)).toBeTruthy();
    expect(rowCount()).toBe(total);
    expect(screen.getByRole('button', { name: 'Filter polled DIDs' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter OBD candidates' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter identification' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter sensors' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Filter derived signals' })).toBeTruthy();
    expect(screen.getByText('ENGINE_SPEED')).toBeTruthy();
    expect(screen.getByText(DEFS.identification[0].name)).toBeTruthy();
    expect(screen.getByText(DEFS.sensors[0].name)).toBeTruthy();
    expect(screen.getByText('gear_estimate')).toBeTruthy();
  });

  it('filters by group, class, waiting category and searched name or description', () => {
    renderPanel();

    fireEvent.click(screen.getByRole('button', { name: 'Filter sensors' }));
    expect(rowCount()).toBe(DEFS.sensors.length);
    expect(screen.queryByText('ENGINE_SPEED')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Filter class A' }));
    expect(rowCount()).toBe(0);
    expect(screen.getByText('No values match the filters.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Filter sensors' }));

    expect(rowCount()).toBe(DEFS.derivedSignals.filter((signal) => signal.class === 'A').length);
    fireEvent.click(screen.getByRole('button', { name: 'Filter class A' }));

    const search = screen.getByLabelText('Search signal coverage by name or description');
    fireEvent.change(search, { target: { value: 'imu_accel_x' } });
    expect(rowCount()).toBe(1);
    expect(screen.getByText('imu_accel_x')).toBeTruthy();

    fireEvent.change(search, { target: { value: 'longitudinal acceleration' } });
    expect(screen.getByText('imu_accel_x')).toBeTruthy();
    expect(rowCount()).toBeGreaterThan(1);

    fireEvent.change(search, { target: { value: '' } });
    const unverified = DEFS.vehicle.dids.filter((did) => !did.verified).length;
    fireEvent.change(screen.getByLabelText('Waiting for category'), { target: { value: 'verification' } });
    expect(rowCount()).toBe(unverified);
  });

  it('loads a mocked report and fills the session column', async () => {
    const polled = DEFS.vehicle.dids[0];
    const classA = DEFS.derivedSignals.find((signal) => signal.class === 'A' && signal.pendingInputs.length === 0)!;
    const classB = DEFS.derivedSignals.find((signal) => signal.class === 'B' && signal.record !== undefined)!;
    const report = {
      valid_ratios: { [polled.name.toLowerCase()]: { total_count: 5, valid_count: 4, valid_percent: 80 } },
      imu: {},
      gps: null,
      can_health: {},
      tester_stats: {},
      derived: { signals: { [classA.name]: { status: 'not_implemented', reason: 'no formula' } } },
      derived_summary: { records: { [classB.record!]: { signals: { [classB.name]: { status: 'computed' } } } } },
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: { headers: Record<string, string> }) => jsonResponse(report));
    vi.stubGlobal('fetch', fetchMock);

    renderPanel({ selectedSessionId: 'ride-1' });
    expect(screen.queryByLabelText('Session id')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Load session/ }));

    expect(await screen.findByText('valid (80%)')).toBeTruthy();
    expect(screen.getByText('not_implemented (no formula)')).toBeTruthy();
    expect(screen.getByText('Report loaded for ride-1.')).toBeTruthy();

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('http://localhost:8000/sessions/ride-1/report');
    expect(String(url)).not.toContain('test-token');
    expect(init).toEqual({ headers: { Authorization: 'Bearer test-token', Accept: 'application/json' } });

    fireEvent.change(screen.getByLabelText('Session status'), { target: { value: 'valid' } });
    expect(rowCount()).toBe(1);
    expect(screen.getByText(polled.name)).toBeTruthy();
    expect(screen.queryByText(classA.name)).toBeNull();
  });

  it('shows the session client error message', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            statusText: '',
            json: async () => ({}),
            text: async () => '{}',
          }) as Response
      )
    );

    renderPanel({ selectedSessionId: 'ride-1' });
    fireEvent.click(screen.getByRole('button', { name: /Load session/ }));

    expect((await screen.findByRole('alert')).textContent).toMatch(/Server error \(500\)/);
    expect(screen.queryByText(/Report loaded/)).toBeNull();
  });

  it('exports only the visible rows as CSV', () => {
    renderPanel();
    // the expected rows follow the bundled defs (names and descriptions change with them)
    const term = 'gear_estimate';
    const expected = buildCoverage(DEFS).filter((r) => `${r.name} ${r.description}`.toLowerCase().includes(term)).length;
    expect(expected).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Search signal coverage by name or description'), { target: { value: term } });
    expect(rowCount()).toBe(expected);
    expect(rowCount()).toBeLessThan(buildCoverage(DEFS).length);

    fireEvent.click(screen.getByRole('button', { name: /Export CSV/ }));

    expect(downloadFile).toHaveBeenCalledTimes(1);
    const [content, filename, mime] = vi.mocked(downloadFile).mock.calls[0];
    expect(content.split('\n')).toHaveLength(expected + 1);
    expect(content).toContain('gear_estimate');
    expect(filename).toMatch(/^coverage-v/);
    expect(mime).toBe('text/csv;charset=utf-8');
  });
});
