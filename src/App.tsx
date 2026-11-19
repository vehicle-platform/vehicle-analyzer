import { useState, useEffect, useRef } from 'react';
import { Header } from './components/Header';
import { AttitudeGauge } from './components/AttitudeGauge';
import { ReplayScrubber } from './components/ReplayScrubber';
import { MainWorkspace } from './app/MainWorkspace';
import { HELP, describeSource } from './app/help';
import { WS_TOKEN_KEY, isReplaySource, useLiveSources } from './app/useLiveSources';
import { useReplay } from './app/useReplay';
import { useSampling } from './app/useSampling';
import { DEFAULT_SERVER_URL } from './services/sessionClient';
import { CockpitTab, TelemetrySource } from './types/can';
import { DEFS } from './defs';
import { CaptureStore } from './state/captureStore';
import { useCapture } from './state/useCapture';
import { StreamStatus } from './services/streamClient';
import { ThemeContext, useTheme } from './ui/theme';
import { focusPanelFilter, useHotkeys } from './ui/keys';
import { KeyBar, KeyHelp } from './ui/KeyBar';
import { readLayout, writeLayout } from './ui/layout';

export { WS_TOKEN_KEY };
export type WsStatus = StreamStatus;

export function App() {
  const [store] = useState(() => new CaptureStore(DEFS));
  useCapture(store);

  const [initialLayout] = useState(readLayout);
  const [activeTab, setActiveTab] = useState<CockpitTab>(initialLayout.view);
  const [showAttitudeHud, setShowAttitudeHud] = useState<boolean>(initialLayout.hud);
  const [serverUrl, setServerUrl] = useState<string>(DEFAULT_SERVER_URL);
  const [recordedSessionId, setRecordedSessionId] = useState<string | null>(null);
  const [showKeys, setShowKeys] = useState<boolean>(false);
  const mainRef = useRef<HTMLElement>(null);

  useEffect(() => {
    writeLayout({ view: activeTab, hud: showAttitudeHud });
  }, [activeTab, showAttitudeHud]);

  const live = useLiveSources(store);
  const { source, isRunning, setIsRunning, setSource, stopLiveSources, setRunning, rxCounterRef } = live;

  const replay = useReplay({
    store,
    source,
    recordedSessionId,
    ingest: live.ingest,
    ingestItem: live.ingestItem,
    rxCounterRef,
    beginReplayLoad: (next) => {
      stopLiveSources();
      setIsRunning(false);
      setSource(next);
    },
  });
  const { isReplaying, setIsReplaying, playbackSpeed, replayFrames, replayIndexRef, seekTo } = replay;

  const { pauseRef } = live;
  useEffect(() => {
    pauseRef.current = () => {
      setRunning(false);
      setIsReplaying(false);
    };
  }, [pauseRef, setRunning, setIsReplaying]);

  const handleSourceChange = (s: TelemetrySource) => {
    stopLiveSources();
    setIsReplaying(false);
    setSource(s);
    if (isReplaySource(s)) {
      setIsRunning(false);
      setActiveTab(s === 'local_file' ? 'sync' : 'session');
      return;
    }
    setIsRunning(true);
    live.startLiveSource(s);
  };

  const handleClear = () => {
    store.clear();
    rxCounterRef.current = 0;
  };

  const openRecordedSession = (sessionId: string) => {
    setRecordedSessionId(sessionId);
    setActiveTab('session');
  };

  useSampling(store, isReplaying, playbackSpeed, rxCounterRef, live.setMsgPerSec);

  // ------------------------------------------------------------ theme and keys

  const { theme, toggleTheme } = useTheme();
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
          n: () => setActiveTab('rides'),
          i: () => setActiveTab('coverage'),
          ' ': togglePause,
          c: handleClear,
          x: () => setShowAttitudeHud((v) => !v),
          l: toggleTheme,
          '/': () => focusPanelFilter(mainRef.current),
          '?': () => setShowKeys(true),
        }
  );

  const sourceStatus = describeSource({ ...live, isReplaying });

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
          msgPerSec={live.msgPerSec}
          totalRx={store.totalRx}
          source={source}
          onSourceChange={handleSourceChange}
          usbRole={live.usbRole}
          onUsbRoleChange={live.setUsbRole}
          desktop={live.desktopHost ? { kind: live.desktopKind, name: live.desktopName, onKindChange: live.setDesktopKind, onNameChange: live.setDesktopName } : undefined}
          wsUrl={live.wsUrl}
          onWsUrlChange={live.setWsUrl}
          wsToken={live.wsToken}
          onWsTokenChange={live.handleTokenChange}
          wsSource={live.wsSource}
          wsStatus={live.wsStatus}
          defsRef={DEFS.ref}
          customDbc={store.customPlatformDbc}
          showAttitudeHud={showAttitudeHud}
          onToggleAttitudeHud={() => setShowAttitudeHud(!showAttitudeHud)}
          theme={theme}
          onToggleTheme={toggleTheme}
        />

        {live.sourceError && (
          <div role="alert" className="flex shrink-0 justify-between border-b border-term-rule bg-term-redBg px-[14px] leading-[24px] text-term-red">
            <span>■ {live.sourceError}</span>
            <button type="button" onClick={() => live.setSourceError(null)} className="text-term-red hover:text-term-hi">
              dismiss
            </button>
          </div>
        )}

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <MainWorkspace
            mainRef={mainRef}
            store={store}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            source={source}
            triggerArmed={live.triggerArmed}
            onArmTrigger={live.armTrigger}
            canTransmit={source === 'virtual' && isRunning}
            onTransmit={(payload) => live.virtualBus.injectTesterRequest(payload)}
            clockRate={isReplaySource(source) ? (isReplaying ? playbackSpeed : 0) : isRunning ? 1 : 0}
            token={live.wsToken}
            onTokenChange={live.handleTokenChange}
            serverUrl={serverUrl}
            onServerUrlChange={setServerUrl}
            recordedSessionId={recordedSessionId}
            onSelectSession={setRecordedSessionId}
            replaySessionId={replay.replaySessionId}
            onSessionLoaded={replay.handleSessionLoaded}
            onLogLoaded={replay.handleLogLoaded}
            replayTimeSec={replay.currentReplayTime}
            onSeekTime={replay.seekToTime}
            replaySynced={replay.trackReplaySynced}
            onOpenSession={openRecordedSession}
          />

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
            currentIndex={replay.replayIndex}
            totalFrames={replayFrames.length}
            currentTimeSec={replay.currentReplayTime}
            totalDurationSec={replay.totalReplayDuration}
            playbackSpeed={playbackSpeed}
            onSpeedChange={replay.setPlaybackSpeed}
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
            { k: 'N', label: 'Ride history' },
          ]}
          status={
            <>
              <span>
                vehicle bus <span className="text-term-fg">listen-only</span>
              </span>
              <span className={live.sourceError ? 'text-term-red' : 'text-term-fg'}>{sourceStatus}</span>
            </>
          }
        />

        {showKeys && <KeyHelp groups={HELP} onClose={() => setShowKeys(false)} />}
      </div>
    </ThemeContext.Provider>
  );
}

export default App;
