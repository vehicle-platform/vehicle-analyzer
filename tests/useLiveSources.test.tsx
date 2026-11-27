// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import type { CanFrame } from '@/types/can';
import type { StreamStatus } from '@/services/streamClient';
import { createStore } from './components/helpers';

const mocks = vi.hoisted(() => ({
  virtualStart: vi.fn(),
  virtualStop: vi.fn(),
  webSerialConnect: vi.fn(),
  webSerialDisconnect: vi.fn(),
  webSerialCtor: vi.fn(),
  desktopConnect: vi.fn(),
  desktopDisconnect: vi.fn(),
  desktopIsDesktop: vi.fn(() => false),
  wsConnect: vi.fn(),
  wsDisconnect: vi.fn(),
  wsCtor: vi.fn(),
}));

vi.mock('@/services/virtualBus', () => ({
  VirtualCanBus: class {
    start = mocks.virtualStart;
    stop = mocks.virtualStop;
  },
}));

vi.mock('@/services/webSerialCan', () => ({
  WebSerialCanAdapter: class {
    constructor(role: string) {
      mocks.webSerialCtor(role);
    }
    connect = mocks.webSerialConnect;
    disconnect = mocks.webSerialDisconnect;
  },
}));

vi.mock('@/services/desktopCan', () => ({
  isDesktop: () => mocks.desktopIsDesktop(),
  DesktopCanAdapter: class {
    connect = mocks.desktopConnect;
    disconnect = mocks.desktopDisconnect;
  },
}));

vi.mock('@/services/streamClient', () => ({
  WebSocketStreamClient: class {
    constructor(opts: unknown) {
      mocks.wsCtor(opts);
    }
    connect = mocks.wsConnect;
    disconnect = mocks.wsDisconnect;
  },
}));

import { DEFAULT_WS_URL, WS_TOKEN_KEY, isReplaySource, useLiveSources } from '@/app/useLiveSources';

function makeFrame(id = 0x021, t = 1.0): CanFrame {
  return {
    id,
    idHex: `0x${id.toString(16).toUpperCase().padStart(3, '0')}`,
    bus: 'platform',
    dlc: 4,
    data: [1, 2, 3, 4],
    timestamp: t,
    deltaMs: 0,
    isExtended: false,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

beforeEach(() => {
  sessionStorage.clear();
  vi.clearAllMocks();
  mocks.webSerialConnect.mockResolvedValue(undefined);
  mocks.webSerialDisconnect.mockResolvedValue(undefined);
  mocks.desktopConnect.mockResolvedValue(undefined);
  mocks.desktopDisconnect.mockResolvedValue(undefined);
  mocks.desktopIsDesktop.mockReturnValue(false);
});

afterEach(() => {
  cleanup();
});

describe('useLiveSources', () => {
  it('starts virtual bus on mount, stops on unmount, and classifies replay sources', () => {
    expect(isReplaySource('local_file')).toBe(true);
    expect(isReplaySource('server_session')).toBe(true);
    expect(isReplaySource('virtual')).toBe(false);
    expect(isReplaySource('websocket')).toBe(false);

    const store = createStore();
    const { result, unmount } = renderHook(() => useLiveSources(store));

    expect(result.current.source).toBe('virtual');
    expect(result.current.wsUrl).toBe(DEFAULT_WS_URL);
    expect(result.current.isRunning).toBe(true);
    expect(mocks.virtualStart).toHaveBeenCalledTimes(1);

    unmount();
    expect(mocks.virtualStop).toHaveBeenCalledTimes(1);
  });

  it('ingests frames and samples and fires pause-on-trigger once on matching CAN ID', () => {
    const store = createStore();
    const { result } = renderHook(() => useLiveSources(store));
    const onPause = vi.fn();
    result.current.pauseRef.current = onPause;

    act(() => {
      result.current.armTrigger(0x081);
    });
    expect(result.current.triggerArmed).toBe(true);

    // Non-matching frame increments counter but keeps trigger armed
    act(() => {
      result.current.ingest(makeFrame(0x021, 1.0));
    });
    expect(result.current.rxCounterRef.current).toBe(1);
    expect(result.current.triggerArmed).toBe(true);
    expect(onPause).not.toHaveBeenCalled();

    // Matching frame via ingestItem disarms trigger and calls pauseRef
    act(() => {
      result.current.ingestItem({ kind: 'frame', t: 2.0, frame: makeFrame(0x081, 2.0) });
    });
    expect(result.current.rxCounterRef.current).toBe(2);
    expect(result.current.triggerArmed).toBe(false);
    expect(onPause).toHaveBeenCalledTimes(1);

    // Sample item routes directly to store.ingestSample
    const sampleSpy = vi.spyOn(store, 'ingestSample');
    act(() => {
      result.current.ingestItem({ kind: 'sample', key: 'did.COOLANT_TEMP', t: 3.0, value: 88.5 });
    });
    expect(sampleSpy).toHaveBeenCalledWith('did.COOLANT_TEMP', 3.0, 88.5);
  });

  it('reads and persists wsToken via sessionStorage and tolerates storage errors', () => {
    sessionStorage.setItem(WS_TOKEN_KEY, 'initial-token');
    const store = createStore();
    const { result } = renderHook(() => useLiveSources(store));

    expect(result.current.wsToken).toBe('initial-token');
    act(() => {
      result.current.handleTokenChange('updated-token');
    });
    expect(result.current.wsToken).toBe('updated-token');
    expect(sessionStorage.getItem(WS_TOKEN_KEY)).toBe('updated-token');

    const setSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    act(() => {
      result.current.handleTokenChange('in-memory-only');
    });
    expect(result.current.wsToken).toBe('in-memory-only');
    setSpy.mockRestore();
  });

  it('connects and disconnects WebSerial and surfaces connection errors', async () => {
    const store = createStore();
    const { result } = renderHook(() => useLiveSources(store));

    act(() => {
      result.current.setUsbRole('platform');
    });
    act(() => {
      result.current.startLiveSource('webserial');
    });
    expect(mocks.webSerialCtor).toHaveBeenCalledWith('platform');
    expect(mocks.webSerialConnect).toHaveBeenCalledWith(115200, result.current.ingest);

    act(() => {
      result.current.stopLiveSources();
    });
    expect(mocks.webSerialDisconnect).toHaveBeenCalledTimes(1);

    // Unhappy path: connect rejects -> sets sourceError and stops running
    mocks.webSerialConnect.mockRejectedValueOnce(new Error('port busy'));
    act(() => {
      result.current.startLiveSource('webserial');
    });
    await waitFor(() => {
      expect(result.current.sourceError).toBe('USB CAN: port busy');
      expect(result.current.isRunning).toBe(false);
    });
  });

  it('connects and disconnects Desktop CAN adapter and surfaces refusals', async () => {
    mocks.desktopIsDesktop.mockReturnValue(true);
    const store = createStore();
    const { result } = renderHook(() => useLiveSources(store));

    expect(result.current.desktopHost).toBe(true);
    act(() => {
      result.current.setDesktopKind('socketcan');
      result.current.setDesktopName('  can0  ');
      result.current.setUsbRole('vehicle');
    });
    act(() => {
      result.current.startLiveSource('desktop');
    });
    expect(mocks.desktopConnect).toHaveBeenCalledWith(
      { kind: 'socketcan', name: 'can0', bitrate: 500000, bus: 'vehicle' },
      result.current.ingest
    );

    act(() => {
      result.current.stopLiveSources();
    });
    expect(mocks.desktopDisconnect).toHaveBeenCalledTimes(1);

    mocks.desktopConnect.mockRejectedValueOnce(new Error('not listen-only'));
    act(() => {
      result.current.startLiveSource('desktop');
    });
    await waitFor(() => {
      expect(result.current.sourceError).toBe('Native CAN: not listen-only');
      expect(result.current.isRunning).toBe(false);
    });
  });

  it('connects WebSocket stream, updates status/heartbeat, and respects setRunning for replay vs live', () => {
    const store = createStore();
    const { result } = renderHook(() => useLiveSources(store));

    act(() => {
      result.current.setWsUrl('ws://127.0.0.1:8000/ws/live');
      result.current.handleTokenChange('tok-123');
    });
    act(() => {
      result.current.startLiveSource('websocket');
    });
    expect(mocks.wsConnect).toHaveBeenCalledTimes(1);

    const opts = mocks.wsCtor.mock.calls[0][0] as {
      url: string;
      token: string;
      onFrame: (f: CanFrame) => void;
      onStatusChange: (s: StreamStatus) => void;
      onHeartbeat: (hb: { source: string }) => void;
    };
    expect(opts.url).toBe('ws://127.0.0.1:8000/ws/live');
    expect(opts.token).toBe('tok-123');

    act(() => {
      opts.onStatusChange('connected');
      opts.onHeartbeat({ source: 'mqtt' });
      opts.onFrame(makeFrame(0x021, 5.0));
    });
    expect(result.current.wsStatus).toBe('connected');
    expect(result.current.wsSource).toBe('mqtt');
    expect(result.current.rxCounterRef.current).toBe(1);

    act(() => {
      result.current.stopLiveSources();
    });
    expect(mocks.wsDisconnect).toHaveBeenCalledTimes(1);

    // setRunning on live source starts/stops; on replay source it does neither
    mocks.virtualStart.mockClear();
    mocks.virtualStop.mockClear();
    act(() => {
      result.current.setRunning(false);
    });
    expect(mocks.virtualStop).toHaveBeenCalledTimes(1);
    act(() => {
      result.current.setRunning(true);
    });
    expect(mocks.virtualStart).toHaveBeenCalledTimes(1);

    mocks.virtualStart.mockClear();
    mocks.virtualStop.mockClear();
    act(() => {
      result.current.setSource('local_file');
    });
    act(() => {
      result.current.setRunning(false);
      result.current.setRunning(true);
    });
    expect(mocks.virtualStart).not.toHaveBeenCalled();
    expect(mocks.virtualStop).not.toHaveBeenCalled();
  });
});
