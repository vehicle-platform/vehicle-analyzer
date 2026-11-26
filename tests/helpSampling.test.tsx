// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { HELP, describeSource } from '@/app/help';
import { useSampling } from '@/app/useSampling';
import { createStore } from './components/helpers';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('app/help', () => {
  it('describes every telemetry source in running, paused, and replay states', () => {
    expect(HELP.length).toBeGreaterThanOrEqual(3);
    const base = {
      source: 'virtual',
      isRunning: true,
      isReplaying: false,
      wsStatus: 'connected',
      wsSource: 'mock',
      usbRole: 'vehicle',
      desktopKind: 'slcan',
    };
    expect(describeSource(base)).toBe('virtual bus running');
    expect(describeSource({ ...base, isRunning: false })).toBe('virtual bus paused');
    expect(describeSource({ ...base, source: 'websocket' })).toBe('ws connected (mock)');
    expect(describeSource({ ...base, source: 'websocket', wsSource: null, isRunning: false })).toBe('ws connected, paused');
    expect(describeSource({ ...base, source: 'webserial' })).toBe('usb can vehicle bus');
    expect(describeSource({ ...base, source: 'desktop', isRunning: false })).toBe('native slcan vehicle bus, paused');
    expect(describeSource({ ...base, source: 'server_session', isReplaying: true })).toBe('session replay playing');
    expect(describeSource({ ...base, source: 'server_session', isReplaying: false })).toBe('session replay stopped');
    expect(describeSource({ ...base, source: 'local_file', isReplaying: true })).toBe('log replay playing');
    expect(describeSource({ ...base, source: 'local_file', isReplaying: false })).toBe('log replay stopped');
  });
});

describe('app/useSampling', () => {
  it('samples the store every second with replay speed scaling and resets rxCounterRef', () => {
    vi.useFakeTimers();
    const store = createStore();
    const sampleSpy = vi.spyOn(store, 'sampleSecond');
    const setMsgPerSec = vi.fn();
    const rxCounterRef = { current: 50 };

    const Probe = ({ replaying, speed }: { replaying: boolean; speed: number }) => {
      useSampling(store, replaying, speed, rxCounterRef, setMsgPerSec);
      return null;
    };

    const { rerender } = render(<Probe replaying={false} speed={2} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(sampleSpy).toHaveBeenCalledTimes(1);
    expect(sampleSpy.mock.calls[0][0]).toBeCloseTo(1.0, 1);
    expect(setMsgPerSec).toHaveBeenCalledWith(50);
    expect(rxCounterRef.current).toBe(0);

    rxCounterRef.current = 120;
    rerender(<Probe replaying={true} speed={2} />);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(sampleSpy).toHaveBeenCalledTimes(2);
    expect(sampleSpy.mock.calls[1][0]).toBeCloseTo(2.0, 1);
    expect(setMsgPerSec).toHaveBeenCalledWith(120);
  });
});
