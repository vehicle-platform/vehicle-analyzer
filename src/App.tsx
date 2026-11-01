import { useState, useEffect, useRef, useCallback } from 'react';
import { Header } from './components/Header';
import { TracePanel } from './components/TracePanel';
import { SnifferPanel } from './components/SnifferPanel';
import { OscilloscopePanel } from './components/OscilloscopePanel';
import { UdsPanel } from './components/UdsPanel';
import { SyncPanel } from './components/SyncPanel';
import { AttitudeGauge } from './components/AttitudeGauge';
import { ReplayScrubber } from './components/ReplayScrubber';
import { HealthPanel } from './components/HealthPanel';
import { ClusterPanel } from './components/ClusterPanel';
import { SessionPanel } from './components/SessionPanel';
import { ComparePanel } from './components/ComparePanel';
import { TrackPanel } from './components/TrackPanel';
import { ReplayItem, framesToItems, mergeSamples } from './services/replay';
import { DEFAULT_SERVER_URL, RecordedSeries, mapSeriesKey } from './services/sessionClient';
import { BusRole, CanFrame, CockpitTab, TelemetrySource } from './types/can';
import { DEFS } from './defs';
import { CaptureStore } from './state/captureStore';
import { useCapture } from './state/useCapture';
import { VirtualCanBus } from './services/virtualBus';
import { WebSerialCanAdapter } from './services/webSerialCan';
import { didKey } from './services/pipeline';
import { StreamStatus, WebSocketStreamClient } from './services/streamClient';
import { ThemeContext, useTheme } from './ui/theme';
import { focusPanelFilter, useHotkeys } from './ui/keys';
import { KeyBar, KeyHelp, type HelpGroup } from './ui/KeyBar';
import { readLayout, writeLayout } from './ui/layout';

/** Frames replayed silently to rebuild the views after a backward seek. */
const REPLAY_REBUILD_WINDOW = 2000;
/** Longest real wait between two replayed frames (a gap in the log is not waited out). */
const REPLAY_MAX_GAP_MS = 1000;
const DEFAULT_WS_URL = 'ws://localhost:8000/ws/live';
export const WS_TOKEN_KEY = 'vehicle-analyzer.ws-token';

/** Sources that play through the replay transport. */
const isReplaySource = (s: TelemetrySource) => s === 'local_file' || s === 'server_session';

export type WsStatus = StreamStatus;

export function App() {
  const [store] = useState(() => new CaptureStore(DEFS));
  useCapture(store);

  const [initialLayout] = useState(readLayout);
  const [activeTab, setActiveTab] = useState<CockpitTab>(initialLayout.view);
  const [isRunning, setIsRunning] = useState<boolean>(true);
  const [source, setSource] = useState<TelemetrySource>('virtual');
  const [usbRole, setUsbRole] = useState<BusRole>('vehicle');
  const [wsUrl, setWsUrl] = useState<string>(DEFAULT_WS_URL);
  const [wsStatus, setWsStatus] = useState<WsStatus>('disconnected');
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
  const [wsSource, setWsSource] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string>(DEFAULT_SERVER_URL);
  const [recordedSessionId, setRecordedSessionId] = useState<string | null>(null);
  const [showAttitudeHud, setShowAttitudeHud] = useState<boolean>(initialLayout.hud);
  const [msgPerSec, setMsgPerSec] = useState<number>(0);
  const [sourceError, setSourceError] = useState<string | null>(null);

  useEffect(() => {
    writeLayout({ view: activeTab, hud: showAttitudeHud });
  }, [activeTab, showAttitudeHud]);

  // Time Machine replay
  const [replayFrames, setReplayFrames] = useState<ReplayItem[]>([]);
  const [replayIndex, setReplayIndex] = useState<number>(0);
  const [isReplaying, setIsReplaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  const replayIndexRef = useRef<number>(0);

  const [virtualBus] = useState(() => new VirtualCanBus(DEFS));
  const webSerialRef = useRef<WebSerialCanAdapter | null>(null);
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

  const stopLiveSources = useCallback(() => {
    virtualBus.stop();
    webSerialRef.current?.disconnect();
    webSerialRef.current = null;
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
    [virtualBus, ingest, usbRole, wsUrl, wsToken]
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

  useEffect(() => {
    pauseRef.current = () => {
      setRunning(false);
      setIsReplaying(false);
    };
  }, [setRunning]);

  const handleSourceChange = (s: TelemetrySource) => {
    stopLiveSources();
    setIsReplaying(false);
    setSource(s);
    if (s === 'local_file' || s === 'server_session') {
      setIsRunning(false);
      setActiveTab(s === 'local_file' ? 'sync' : 'session');
      return;
    }
    setIsRunning(true);
    startLiveSource(s);
  };

  const handleClear = () => {
    store.clear();
    rxCounterRef.current = 0;
  };

  // ------------------------------------------------------------ replay

  // replayIndexRef is the source of truth for the replay position; every writer sets
  // it and the state together (a state-to-ref sync effect would lag and rewind it).

  const handleLogLoaded = (frames: CanFrame[]) => {
    stopLiveSources();
    setIsRunning(false);
    setIsReplaying(false);
    store.clear();
    store.resetRecordedMeta();
    setReplayFrames(framesToItems(frames));
    setReplayIndex(0);
    replayIndexRef.current = 0;
    setSource('local_file');
    if (frames.length > 0) ingest(frames[0]);
  };

  /** Recorded session series -> replay items (or pushed at once). Display metadata goes to the store. */
  const handleSessionLoaded = (series: RecordedSeries[], mode: 'replay' | 'all') => {
    stopLiveSources();
    setIsRunning(false);
    setIsReplaying(false);
    store.clear();
    store.resetRecordedMeta();
    rxCounterRef.current = 0;
    const perKey = series.map((sr) => {
      const m = mapSeriesKey(sr.name, sr.kind);
      if (!m.fromDefs) store.setRecordedMeta(m.key, { label: m.label, group: m.group, unit: sr.unit });
      else if (!store.defs.vehicle.dids.some((d) => didKey(d.name) === m.key)) store.setRecordedMeta(m.key, { label: `DID ${m.label}`, group: 'session · DID (not in defs)', unit: sr.unit });
      return { key: m.key, t: sr.tMs.map((ms) => ms / 1000), v: sr.v };
    });
    setSource('server_session');
    if (mode === 'all') {
      for (const s of perKey) for (let i = 0; i < s.t.length; i++) store.ingestSample(s.key, s.t[i], s.v[i]);
      setReplayFrames([]);
      setReplayIndex(0);
      replayIndexRef.current = 0;
      return;
    }
    const items = mergeSamples(perKey);
    setReplayFrames(items);
    setReplayIndex(0);
    replayIndexRef.current = 0;
    if (items.length > 0) ingestItem(items[0]);
  };

  // Each frame is scheduled after the recorded gap to the previous one, divided by the
  // speed; frames closer than a timer tick are emitted together.
  useEffect(() => {
    if (!isReplaying || replayFrames.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const step = () => {
      if (cancelled) return;
      let idx = replayIndexRef.current;
      const startT = replayFrames[idx]?.t ?? 0;
      while (idx + 1 < replayFrames.length) {
        const gapMs = ((replayFrames[idx + 1].t - startT) * 1000) / playbackSpeed;
        if (gapMs > 4) break;
        idx += 1;
        ingestItem(replayFrames[idx]);
      }
      replayIndexRef.current = idx;
      setReplayIndex(idx);
      if (idx + 1 >= replayFrames.length) {
        setIsReplaying(false);
        return;
      }
      const waitMs = Math.min(
        REPLAY_MAX_GAP_MS,
        Math.max(0, ((replayFrames[idx + 1].t - replayFrames[idx].t) * 1000) / playbackSpeed)
      );
      timer = setTimeout(() => {
        if (cancelled) return;
        // Read the index again: a seek during playback moves it.
        const next = replayIndexRef.current + 1;
        if (next >= replayFrames.length) {
          setIsReplaying(false);
          return;
        }
        replayIndexRef.current = next;
        ingestItem(replayFrames[next]);
        step();
      }, waitMs);
    };
    step();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isReplaying, replayFrames, playbackSpeed, ingestItem]);

  // Forward seeks feed the skipped frames; backward seeks rebuild the views from a
  // window before the target, so no view keeps frames from "the future".
  const seekTo = (index: number) => {
    if (index < 0 || index >= replayFrames.length) return;
    const current = replayIndexRef.current;
    if (index > current && index - current <= REPLAY_REBUILD_WINDOW) {
      for (let i = current + 1; i <= index; i++) ingestItem(replayFrames[i]);
    } else if (index !== current) {
      store.clear();
      for (let i = Math.max(0, index - REPLAY_REBUILD_WINDOW); i <= index; i++) ingestItem(replayFrames[i]);
    }
    replayIndexRef.current = index;
    setReplayIndex(index);
  };

  /** Seek the replay transport to the frame nearest a track point time (ms). */
  const seekToTime = (tMs: number) => {
    if (replayFrames.length === 0) return;
    const target = tMs / 1000;
    let lo = 0;
    let hi = replayFrames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (replayFrames[mid].t < target) lo = mid + 1;
      else hi = mid;
    }
    const previous = Math.max(0, lo - 1);
    const index = Math.abs(replayFrames[previous].t - target) <= Math.abs(replayFrames[lo].t - target) ? previous : lo;
    seekTo(index);
  };

  // ------------------------------------------------------------ 1 s sampling

  const isReplayingRef = useRef(isReplaying);
  const playbackSpeedRef = useRef(playbackSpeed);
  useEffect(() => {
    isReplayingRef.current = isReplaying;
    playbackSpeedRef.current = playbackSpeed;
  }, [isReplaying, playbackSpeed]);

  useEffect(() => {
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const wallSec = (now - last) / 1000;
      last = now;
      store.sampleSecond(wallSec * (isReplayingRef.current ? playbackSpeedRef.current : 1));
      setMsgPerSec(Math.round(rxCounterRef.current / wallSec));
      rxCounterRef.current = 0;
    }, 1000);
    return () => clearInterval(interval);
  }, [store]);

  const currentReplayTime = replayFrames[replayIndex]?.t ?? 0;
  const totalReplayDuration = replayFrames[replayFrames.length - 1]?.t ?? 0;
  const canTransmit = source === 'virtual' && isRunning;

  // ------------------------------------------------------------ theme and keys

  const { theme, toggleTheme } = useTheme();
  const [showKeys, setShowKeys] = useState<boolean>(false);
  const mainRef = useRef<HTMLElement>(null);
  const hasReplay = isReplaySource(source) || replayFrames.length > 0;

  // In log replay, space drives the replay transport instead of the live source.
  const togglePause = () => {
    if (isReplaySource(source)) {
      if (replayFrames.length > 0) setIsReplaying(!isReplaying);
    } else {
      setRunning(!isRunning);
    }
  };

  useHotkeys(
    showKeys
      ? { Escape: () => setShowKeys(false), '?': () => setShowKeys(false) }
      : {
          t: () => setActiveTab('trace'),
          s: () => setActiveTab('sniffer'),
          o: () => setActiveTab('oscilloscope'),
          u: () => setActiveTab('uds'),
          h: () => setActiveTab('health'),
          f: () => setActiveTab('cluster'),
          d: () => setActiveTab('sync'),
          e: () => setActiveTab('session'),
          a: () => setActiveTab('compare'),
          g: () => setActiveTab('track'),
          ' ': togglePause,
          c: handleClear,
          x: () => setShowAttitudeHud((v) => !v),
          l: toggleTheme,
          '/': () => focusPanelFilter(mainRef.current),
          '?': () => setShowKeys(true),
        }
  );

  const sourceStatus =
    source === 'virtual'
      ? `virtual bus ${isRunning ? 'running' : 'paused'}`
      : source === 'websocket'
        ? `ws ${wsStatus}${wsSource ? ` (${wsSource})` : ''}${isRunning ? '' : ', paused'}`
        : source === 'webserial'
          ? `usb can ${usbRole} bus${isRunning ? '' : ', paused'}`
          : source === 'server_session'
            ? `session replay ${isReplaying ? 'playing' : 'stopped'}`
            : `log replay ${isReplaying ? 'playing' : 'stopped'}`;

  return (
    <ThemeContext.Provider value={theme}>
      <div className="flex h-screen w-screen flex-col overflow-hidden bg-term-bg text-term-fg">
        <Header
          activeTab={activeTab}
          onTabChange={setActiveTab}
          isRunning={isRunning}
          onTogglePlay={() => setRunning(!isRunning)}
          onClear={handleClear}
          busLoad={store.busLoad}
          msgPerSec={msgPerSec}
          totalRx={store.totalRx}
          source={source}
          onSourceChange={handleSourceChange}
          usbRole={usbRole}
          onUsbRoleChange={setUsbRole}
          wsUrl={wsUrl}
          onWsUrlChange={setWsUrl}
          wsToken={wsToken}
          onWsTokenChange={handleTokenChange}
          wsSource={wsSource}
          wsStatus={wsStatus}
          defsRef={DEFS.ref}
          customDbc={store.customPlatformDbc}
          showAttitudeHud={showAttitudeHud}
          onToggleAttitudeHud={() => setShowAttitudeHud(!showAttitudeHud)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        {sourceError && (
          <div role="alert" className="flex shrink-0 justify-between border-b border-term-rule bg-term-redBg px-[14px] leading-[24px] text-term-red">
            <span>■ {sourceError}</span>
            <button type="button" onClick={() => setSourceError(null)} className="text-term-red hover:text-term-hi">
              dismiss
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <main ref={mainRef} className="min-w-0 flex-1 overflow-hidden">
            {activeTab === 'trace' && (
              <TracePanel
                store={store}
                triggerArmed={triggerArmed}
                onArmTrigger={(id) => {
                  triggerIdRef.current = id;
                  setTriggerArmed(id !== null);
                }}
              />
            )}
            {activeTab === 'sniffer' && <SnifferPanel store={store} />}
            {activeTab === 'oscilloscope' && <OscilloscopePanel store={store} />}
            {activeTab === 'uds' && (
              <UdsPanel
                store={store}
                canTransmit={canTransmit}
                onTransmit={(payload) => virtualBus.injectTesterRequest(payload)}
              />
            )}
            {activeTab === 'health' && <HealthPanel store={store} />}
            {activeTab === 'cluster' && (
              <ClusterPanel store={store} clockRate={isReplaySource(source) ? (isReplaying ? playbackSpeed : 0) : isRunning ? 1 : 0} />
            )}
            {activeTab === 'session' && (
              <SessionPanel
                token={wsToken}
                onTokenChange={handleTokenChange}
                serverUrl={serverUrl}
                onServerUrlChange={setServerUrl}
                onLoad={handleSessionLoaded}
                onSelect={setRecordedSessionId}
                selectedSessionId={recordedSessionId}
              />
            )}
            {activeTab === 'compare' && (
              <ComparePanel token={wsToken} onTokenChange={handleTokenChange} serverUrl={serverUrl} onServerUrlChange={setServerUrl} />
            )}
            {activeTab === 'track' && (
              <TrackPanel
                key={recordedSessionId ?? 'none'}
                token={wsToken}
                onTokenChange={handleTokenChange}
                serverUrl={serverUrl}
                onServerUrlChange={setServerUrl}
                sessionId={recordedSessionId}
                replayTimeSec={currentReplayTime}
                onSeekTime={seekToTime}
              />
            )}
            {activeTab === 'sync' && <SyncPanel store={store} source={source} onLogLoaded={handleLogLoaded} />}
          </main>

          {showAttitudeHud && (
            <aside aria-label="Lean and cornering" className="flex w-hud shrink-0 flex-col overflow-y-auto border-l border-term-rule bg-term-raise">
              <AttitudeGauge store={store} />
            </aside>
          )}
        </div>

        {hasReplay && (
          <ReplayScrubber
            isReplaying={isReplaying}
            onToggleReplay={() => setIsReplaying(!isReplaying)}
            currentIndex={replayIndex}
            totalFrames={replayFrames.length}
            currentTimeSec={currentReplayTime}
            totalDurationSec={totalReplayDuration}
            playbackSpeed={playbackSpeed}
            onSpeedChange={setPlaybackSpeed}
            onScrub={seekTo}
            onStepForward={() => seekTo(replayIndexRef.current + 1)}
            onStepBackward={() => seekTo(replayIndexRef.current - 1)}
            onRestart={() => seekTo(0)}
            itemLabel={source === 'server_session' ? 'sample' : 'frame'}
          />
        )}

        <KeyBar
          keys={[
            { k: '?', label: 'Keys' },
            { k: '/', label: 'Filter' },
            { k: 'space', label: isReplaySource(source) ? (isReplaying ? 'Pause replay' : 'Play replay') : isRunning ? 'Pause' : 'Run' },
            { k: 'C', label: 'Clear' },
            { k: 'X', label: 'HUD' },
            { k: 'L', label: theme === 'dark' ? 'Light' : 'Dark' },
          ]}
          status={
            <>
              <span>
                vehicle bus <span className="text-term-fg">listen-only</span>
              </span>
              <span className={sourceError ? 'text-term-red' : 'text-term-fg'}>{sourceStatus}</span>
            </>
          }
        />

        {showKeys && <KeyHelp groups={HELP} onClose={() => setShowKeys(false)} />}
      </div>
    </ThemeContext.Provider>
  );
}

const HELP: HelpGroup[] = [
  {
    title: 'Views',
    keys: [
      { k: 'T', label: 'CAN trace' },
      { k: 'S', label: 'Sniffer' },
      { k: 'O', label: 'Oscilloscope' },
      { k: 'U', label: 'UDS' },
      { k: 'H', label: 'Health' },
      { k: 'F', label: 'Cluster' },
      { k: 'D', label: 'Defs & logs' },
      { k: 'E', label: 'Recorded sessions' },
      { k: 'A', label: 'Compare two sessions' },
      { k: 'G', label: 'Ride track' },
    ],
  },
  {
    title: 'Capture',
    keys: [
      { k: 'space', label: 'Pause / run the source (play / pause in log replay)' },
      { k: 'C', label: 'Clear captured data' },
      { k: '/', label: 'Focus the filter of this view' },
    ],
  },
  {
    title: 'Display',
    keys: [
      { k: 'X', label: 'Lean & cornering pane' },
      { k: 'L', label: 'Light / dark theme' },
      { k: '?', label: 'This help' },
    ],
  },
];

export default App;
