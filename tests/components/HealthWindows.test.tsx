// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HealthWindows as HealthWindowsView } from '@/components/HealthWindows';
import { RideSummary, useRideSummary } from '@/components/RideSummary';
import { jsonResponse } from './helpers';

const instance = {
  start_ms: 3_000,
  end_ms: 30_000,
  duration_ms: 27_000,
  close_reason: 'condition',
  qualifies: true,
  first_qualifying: true,
};

const report = {
  derived_summary: {
    health_windows: {
      rule: 'provisional: Claude’s reading of D-079',
      t0_device_ms: 0,
      windows: {
        W1_KEY_ON: { qualifying_count: 0, instances: [] },
        W2_CRANK: {
          qualifying_count: 1,
          instances: [{ ...instance, start_ms: 3_500, end_ms: 6_500, duration_ms: 3_000, close_reason: 'max_duration', qualifies: true, first_qualifying: false }],
        },
        W3_WARM_IDLE: {
          qualifying_count: 1,
          instances: [instance, { ...instance, start_ms: 40_000, end_ms: 45_000, duration_ms: 5_000, qualifies: false, first_qualifying: false }],
        },
        W99_UNKNOWN: { qualifying_count: 1, instances: [{ ...instance, qualifies: false, first_qualifying: false }] },
      },
    },
  },
};

const summary = {
  session_id: 'ride-1',
  ride_definition: 'session',
  defs_version: 'v0.0.0-test',
  signals: [
    { name: 'window_warm_idle_rpm_spread', status: 'computed', unit: 'rpm', range: [0, 500], kind: 'scalar', value: 100, flag: null },
    { name: 'window_warm_idle_count', status: 'computed', unit: 'count', range: [0, 10], kind: 'scalar', value: 1, flag: null },
    { name: 'window_key_on_rest_voltage', status: 'not_ready', reason: 'no key-on window' },
  ],
};

/** Test harness: the parent (SessionPanel) owns the /summary fetch and feeds the card. */
const HealthWindows: React.FC<{ token: string; serverUrl: string; sessionId: string | null; report: unknown; sessionEndMs?: number | null }> = ({
  token,
  ...rest
}) => {
  const { state } = useRideSummary(token, rest.serverUrl, rest.sessionId);
  return <HealthWindowsView {...rest} summary={state} />;
};

const props = (over: Partial<React.ComponentProps<typeof HealthWindows>> = {}) => ({
  token: '',
  serverUrl: 'http://localhost:8000',
  sessionId: 'ride-1',
  report,
  sessionEndMs: 60_000,
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HealthWindows', () => {
  it('says the report has no block when the key is missing', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(summary)));
    render(<HealthWindows {...props({ report: { derived_summary: {} } })} />);
    expect(screen.getByText('No window instances in this report (older server, or run `vehicle-server derive <id>`).')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows a malformed block as a message, never a crash', () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(summary)));
    render(
      <HealthWindows
        {...props({
          report: { derived_summary: { health_windows: { rule: 'r', t0_device_ms: 0, windows: { W3_WARM_IDLE: { qualifying_count: 1, instances: [{ ...instance, end_ms: 1 }] } } } } },
        })}
      />
    );
    expect(screen.getByRole('alert').textContent).toContain('health windows: malformed:');
    expect(screen.getByRole('alert').textContent).toContain('end_ms is before start_ms');
  });

  it('draws the rule badge, bands, first-qualifying mark, unknown list and not-evaluated row', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(summary)));
    render(<HealthWindows {...props()} />);

    expect(screen.getByText(/provisional: Claude’s reading of D-079/)).toBeTruthy();
    expect(await screen.findByText('100.00')).toBeTruthy();
    expect(screen.getByRole('table', { name: 'W3_WARM_IDLE instances' }).textContent).toContain('condition');
    expect(screen.getByRole('table', { name: 'W3_WARM_IDLE computed signals' }).textContent).toContain('rpm');

    expect(screen.getAllByTestId('health-window-band')).toHaveLength(3);
    expect(document.querySelectorAll('[data-first-qualifying="true"]')).toHaveLength(1);
    expect(screen.getByLabelText('Windows not in the bundled defs').textContent).toContain('W99_UNKNOWN');
    expect(screen.getByLabelText('W4_CRUISE window detail').textContent).toContain('not evaluated');
  });

  it('uses the report instance end as the timeline span when E has no session samples', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(summary)));
    render(<HealthWindows {...props({ sessionEndMs: null })} />);
    expect(await screen.findByText(/100.00/)).toBeTruthy();
    expect(screen.getByLabelText('Health windows').textContent).toContain('0–45.0 s');
  });

  it('makes one /summary request when the ride summary and the health windows are both shown', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => jsonResponse(summary));
    vi.stubGlobal('fetch', fetchMock);
    const Both: React.FC = () => {
      const { state, retry } = useRideSummary('', 'http://localhost:8000', 'ride-1');
      return (
        <>
          <RideSummary serverUrl="http://localhost:8000" sessionId="ride-1" state={state} onRetry={retry} />
          <HealthWindowsView serverUrl="http://localhost:8000" sessionId="ride-1" report={report} summary={state} sessionEndMs={60_000} />
        </>
      );
    };
    render(<Both />);
    expect((await screen.findAllByText('100.00')).length).toBeGreaterThan(0);
    const summaryCalls = fetchMock.mock.calls.filter(([input]) => String(input).includes('/summary'));
    expect(summaryCalls).toHaveLength(1);
  });
});
