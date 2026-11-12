// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ClusterPanel } from '@/components/ClusterPanel';
import { createStore, ingestFrame, platformMessage } from './helpers';

afterEach(cleanup);

describe('ClusterPanel', () => {
  it('renders the tach and readouts from defs without hardware', () => {
    const store = createStore();
    const engine = platformMessage((m) => m.signals.some((s) => s.unit === 'rpm'));
    const rpm = engine.signals.find((s) => s.unit === 'rpm')!;
    const values = Object.fromEntries(engine.signals.filter((s) => s.name.endsWith('_VALID')).map((s) => [s.name, 1]));
    values[rpm.name] = 3000;
    ingestFrame(store, engine, 1, values);

    render(<ClusterPanel store={store} clockRate={0} />);

    expect(screen.getByText('Engine & speed')).toBeTruthy();
    expect(screen.getByText('Lean & warnings')).toBeTruthy();
    expect(screen.getByText('Nodes')).toBeTruthy();
    expect(screen.getByRole('img', { name: new RegExp(`Engine speed 3000 ${rpm.unit}`) })).toBeTruthy();
  });
});
