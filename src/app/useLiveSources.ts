import { useCallback, useEffect, useRef, useState } from 'react';
import type { CaptureStore } from '@/state/captureStore';
import { DEFS } from '@/defs';
import type { BusRole, CanFrame, DesktopAdapterKind, TelemetrySource } from '@/types/can';
import { VirtualCanBus } from '@/services/virtualBus';
import { WebSerialCanAdapter } from '@/services/webSerialCan';
import { DesktopCanAdapter, isDesktop } from '@/services/desktopCan';
import { StreamStatus, WebSocketStreamClient } from '@/services/streamClient';
import type { ReplayItem } from '@/services/replay';

export const DEFAULT_WS_URL = 'ws://localhost:8000/ws/live';
export const WS_TOKEN_KEY = 'vehicle-analyzer.ws-token';

/** Sources that play through the replay transport. */
export const isReplaySource = (s: TelemetrySource) => s === 'local_file' || s === 'server_session';

/**
 * The live capture sources (virtual bus, Web Serial, native CAN, WebSocket stream), the
 * pause-on-trigger arming and the frame ingest path. The bus stays listen-only: nothing here transmits.
 */
export function useLiveSources(store: CaptureStore) {
  const [isRunning, setIsRunning] = useState<boolean>(true);
  const [source, setSource] = useState<TelemetrySource>('virtual');
  const [usbRole, setUsbRole] = useState<BusRole>('vehicle');
  const [desktopKind, setDesktopKind] = useState<DesktopAdapterKind>('slcan');
  const [desktopName, setDesktopName] = useState<string>('');
  const [wsUrl, setWsUrl] = useState<string>(DEFAULT_WS_URL);
  const [wsStatus, setWsStatus] = useState<StreamStatus>('disconnected');
  const [wsSource, setWsSource] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [msgPerSec, setMsgPerSec] = useState<number>(0);
  const desktopHost = isDesktop();

  // Per-tab convenience only: the token stays in sessionStorage, never in the URL or the repo.
  const [wsToken, setWsToken] = useState<string>(() => {
    try {
      return sessionStorage.getItem(WS_TOKEN_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const handleTokenChange = (t: string) => {
    setWsToken(t);
    try {
      sessionStorage.setItem(WS_TOKEN_KEY, t);
    } catch {
      // storage blocked: the token lives for this page only
    }
  };

  const [virtualBus] = useState(() => new VirtualCanBus(DEFS));
  const webSerialRef = useRef<WebSerialCanAdapter | null>(null);
  const desktopRef = useRef<DesktopCanAdapter | null>(null);
  const webSocketRef = useRef<WebSocketStreamClient | null>(null);
  const rxCounterRef = useRef<number>(0);

  // Pause-on-trigger (fires on the first matching frame after arming).
  const triggerIdRef = useRef<number | null>(null);
  const [triggerArmed, setTriggerArmed] = useState<boolean>(false);
  const pauseRef = useRef<() => void>(() => undefined);

  const ingest = useCallback(
    (frame: CanFrame) => {
      store.ingest(frame);
      rxCounterRef.current += 1;
      if (triggerIdRef.current !== null && frame.id === triggerIdRef.current) {
        triggerIdRef.current = null;
        setTriggerArmed(false);
        pauseRef.current();
      }
    },
    [store]
  );

  const ingestItem = useCallback(
    (item: ReplayItem) => {
      if (item.kind === 'frame') ingest(item.frame);
      else store.ingestSample(item.key, item.t, item.value);
    },
    [ingest, store]
  );

  const armTrigger = (id: number | null) => {
    triggerIdRef.current = id;
    setTriggerArmed(id !== null);
  };

  const stopLiveSources = useCallback(() => {
    virtualBus.stop();
    void webSerialRef.current?.disconnect();
    webSerialRef.current = null;
    void desktopRef.current?.disconnect();
    desktopRef.current = null;
    webSocketRef.current?.disconnect();
    webSocketRef.current = null;
  }, [virtualBus]);

  const startLiveSource = useCallback(
    (s: TelemetrySource) => {
      setSourceError(null);
      if (s === 'virtual') {
        virtualBus.start(ingest);
      } else if (s === 'webserial') {
        const adapter = new WebSerialCanAdapter(usbRole);
        webSerialRef.current = adapter;
        adapter.connect(115200, ingest).catch((err: Error) => {
          setSourceError(`USB CAN: ${err.message}`);
          setIsRunning(false);
        });
      } else if (s === 'desktop') {
        const adapter = new DesktopCanAdapter();
        desktopRef.current = adapter;
        // Bit rate: both buses are classic CAN 500 kbit/s in the defs (D-009, D-019); the
        // DBC bundle carries no machine-readable bit rate yet, SLCAN needs one.
        adapter
          .connect({ kind: desktopKind, name: desktopName.trim(), bitrate: 500000, bus: usbRole }, ingest)
          .catch((err: Error) => {
            setSourceError(`Native CAN: ${err.message}`);
            setIsRunning(false);
          });
      } else if (s === 'websocket') {
        setWsSource(null);
        const client = new WebSocketStreamClient({
          url: wsUrl,
          token: wsToken,
          onFrame: ingest,
          onStatusChange: setWsStatus,
          onHeartbeat: (hb) => setWsSource(hb.source),
        });
        webSocketRef.current = client;
        client.connect();
      }
    },
    [virtualBus, ingest, usbRole, desktopKind, desktopName, wsUrl, wsToken]
  );

  // Start the default virtual source once; stop everything on unmount.
  useEffect(() => {
    virtualBus.start(ingest);
    return () => virtualBus.stop();
  }, [virtualBus, ingest]);

  const setRunning = useCallback(
    (next: boolean) => {
      setIsRunning(next);
      if (isReplaySource(source)) return;
      if (next) startLiveSource(source);
      else stopLiveSources();
    },
    [source, startLiveSource, stopLiveSources]
  );

  return {
    virtualBus,
    desktopHost,
    isRunning,
    setIsRunning,
    setRunning,
    source,
    setSource,
    usbRole,
    setUsbRole,
    desktopKind,
    setDesktopKind,
    desktopName,
    setDesktopName,
    wsUrl,
    setWsUrl,
    wsStatus,
    wsSource,
    wsToken,
    handleTokenChange,
    sourceError,
    setSourceError,
    msgPerSec,
    setMsgPerSec,
    rxCounterRef,
    triggerArmed,
    armTrigger,
    pauseRef,
    ingest,
    ingestItem,
    stopLiveSources,
    startLiveSource,
  };
}
