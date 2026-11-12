// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { HealthPanel } from '@/components/HealthPanel';
import { DEFS } from '@/defs';
import { createStore, ingestFrame, platformMessage } from './helpers';

afterEach(cleanup);

describe('HealthPanel', () => {
  it('renders every D-079 window and a defs heartbeat without hardware', () => {
    const store = createStore();
    const heartbeat = platformMessage((m) => m.signals.some((s) => s.name.endsWith('_MODE')));
    const mode = heartbeat.signals.find((s) => s.name.endsWith('_MODE'))!;
    ingestFrame(store, heartbeat, 1, { [mode.name]: 1 }, 0);
    ingestFrame(store, heartbeat, 1.1, { [mode.name]: 1 }, 1);

    render(<HealthPanel store={store} />);

    expect(screen.getByText('D-079 health windows W1–W5')).toBeTruthy();
    for (const window of DEFS.windows) expect(screen.getByText(window.key)).toBeTruthy();
    expect(screen.getByText('E2E supervisor')).toBeTruthy();
    expect(screen.getByText('Node heartbeats and bus load')).toBeTruthy();
    expect(screen.getByText(heartbeat.name.replace('Heartbeat', ''))).toBeTruthy();
    expect(screen.queryByText('No E2E-protected message seen.')).toBeNull();
  });
});
