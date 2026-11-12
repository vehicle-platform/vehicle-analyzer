// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

// Defs where W4_CRUISE has no derived signals (the pinned defs give every window some).
vi.mock('../../src/defs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/defs')>();
  return { ...actual, DEFS: { ...actual.DEFS, derivedSignals: actual.DEFS.derivedSignals.filter((signal) => signal.window !== 'W4_CRUISE') } };
});

import { HealthWindows } from '@/components/HealthWindows';

const report = { derived_summary: { health_windows: { rule: 'r', t0_device_ms: 0, windows: {} } } };

afterEach(cleanup);

describe('HealthWindows without derived signals', () => {
  it('renders a short note instead of an empty computed-signals table', () => {
    render(
      <HealthWindows
        serverUrl="http://localhost:8000"
        sessionId="ride-1"
        report={report}
        summary={{ kind: 'loaded', summary: { sessionId: 'ride-1', rideDefinition: 'session', defsVersion: 'v', signals: [] } }}
      />
    );
    const detail = screen.getByLabelText('W4_CRUISE window detail');
    expect(detail.textContent).toContain('No computed signals for this window.');
    expect(screen.queryByRole('table', { name: 'W4_CRUISE computed signals' })).toBeNull();
    expect(screen.getByRole('table', { name: 'W3_WARM_IDLE computed signals' })).toBeTruthy();
  });
});
