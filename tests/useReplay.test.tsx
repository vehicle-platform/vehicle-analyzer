// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useReplay } from '@/app/useReplay';
import { createStore } from './components/helpers';
import type { CanFrame, TelemetrySource } from '@/types/can';
import type { ReplayItem } from '@/services/replay';
import type { RecordedSeries } from '@/services/sessionClient';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeFrame(t: number, id = 0x100): CanFrame {
  return {
    id,
    idHex: `0x${id.toString(16).toUpperCase().padStart(3, '0')}`,
    bus: 'platform',
    dlc: 2,
    data: [1, 2],
    timestamp: t,
    deltaMs: 0,
    isExtended: false,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

describe('useReplay', () => {
  it('loads logs, seeks forward and backward, and replays frames on timers', () => {
    vi.useFakeTimers();
    const store = createStore();
    const ingested: ReplayItem[] = [];
    const beginReplayLoad = vi.fn();
    const rxCounterRef = { current: 5 };

    const { result } = renderHook(
      ({ source, recId }: { source: TelemetrySource; recId: string | null }) =>
        useReplay({
          store,
          source,
          recordedSessionId: recId,
          ingest: (f) => store.ingest(f),
          ingestItem: (item) => {
            ingested.push(item);
            if (item.kind === 'frame') store.ingest(item.frame);
            else store.ingestSample(item.key, item.t, item.value);
          },
          rxCounterRef,
          beginReplayLoad,
        }),
      { initialProps: { source: 'local_file' as TelemetrySource, recId: null as string | null } }
    );

    const frames = [makeFrame(0.0), makeFrame(0.001), makeFrame(0.05), makeFrame(0.15)];
    act(() => {
      result.current.handleLogLoaded(frames);
    });
    expect(beginReplayLoad).toHaveBeenCalledWith('local_file');
    expect(result.current.replayFrames).toHaveLength(4);
    expect(result.current.replayIndex).toBe(0);

    // Forward seek ingests skipped frames
    act(() => {
      result.current.seekTo(3);
    });
    expect(result.current.replayIndex).toBe(3);
    expect(ingested.length).toBeGreaterThanOrEqual(3);

    // Out-of-bounds seek is ignored
    act(() => {
      result.current.seekTo(-1);
      result.current.seekTo(99);
    });
    expect(result.current.replayIndex).toBe(3);

    // Backward seek clears store and rebuilds window up to target
    const clearSpy = vi.spyOn(store, 'clear');
    act(() => {
      result.current.seekTo(0);
    });
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(result.current.replayIndex).toBe(0);

    // Start playback -> emits closely spaced frames immediately and advances on timers until end
    act(() => {
      result.current.setIsReplaying(true);
    });
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(result.current.replayIndex).toBe(3);
    expect(result.current.isReplaying).toBe(false);
  });

  it('loads recorded session series in all and replay modes and syncs seekToTime', () => {
    const store = createStore();
    const beginReplayLoad = vi.fn();
    const rxCounterRef = { current: 3 };
    const series: RecordedSeries[] = [
      { name: 'CUSTOM_SIG', kind: 'sensor', unit: 'degC', pointsTotal: 3, downsampled: false, tMs: [0, 500, 1000], v: [20, 25, 30] },
      { name: 'UNKNOWN_DID', kind: 'did', unit: 'V', pointsTotal: 2, downsampled: false, tMs: [0, 1000], v: [12.1, 12.4] },
    ];

    const { result } = renderHook(() =>
      useReplay({
        store,
        source: 'server_session',
        recordedSessionId: 'sess-1',
        ingest: (f) => store.ingest(f),
        ingestItem: (item) => {
          if (item.kind === 'sample') store.ingestSample(item.key, item.t, item.value);
        },
        rxCounterRef,
        beginReplayLoad,
      })
    );

    // Load all at once
    act(() => {
      result.current.handleSessionLoaded(series, 'all', 'sess-1');
    });
    expect(beginReplayLoad).toHaveBeenCalledWith('server_session');
    expect(result.current.replayFrames).toHaveLength(0);
    expect(store.recordedMeta.size).toBeGreaterThanOrEqual(2);
    expect(store.history.size).toBeGreaterThanOrEqual(2);

    // Load in replay mode and seek by time (ms)
    act(() => {
      result.current.handleSessionLoaded(series, 'replay', 'sess-1');
    });
    expect(result.current.trackReplaySynced).toBe(true);
    expect(result.current.replayFrames.length).toBe(5);
    act(() => {
      result.current.seekToTime(520);
    });
    expect(result.current.currentReplayTime).toBeCloseTo(0.5, 2);
  });
});
