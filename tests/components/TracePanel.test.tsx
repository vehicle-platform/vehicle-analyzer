// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { TracePanel } from '@/components/TracePanel';
import { createStore, ingestFrame, platformMessage } from './helpers';

afterEach(cleanup);

describe('TracePanel', () => {
  it('renders a defs frame and filters it without hardware', () => {
    const store = createStore();
    const message = platformMessage((m) => m.signals.length > 0);
    const frame = ingestFrame(store, message, 1, {});

    render(<TracePanel store={store} triggerArmed={false} onArmTrigger={vi.fn()} />);

    expect(screen.getByText(message.name)).toBeTruthy();
    expect(screen.getByText(frame.idHex)).toBeTruthy();

    const filter = screen.getByLabelText('Filter frames');
    fireEvent.change(filter, { target: { value: 'no-such-frame' } });
    expect(screen.getByText('No frame matches the filter.')).toBeTruthy();

    fireEvent.change(filter, { target: { value: message.name } });
    expect(screen.getByText(frame.idHex)).toBeTruthy();
  });
});
