import type { RefObject } from 'react';
import { TracePanel } from '@/components/TracePanel';
import { SnifferPanel } from '@/components/SnifferPanel';
import { OscilloscopePanel } from '@/components/OscilloscopePanel';
import { UdsPanel } from '@/components/UdsPanel';
import { SyncPanel } from '@/components/SyncPanel';
import { HealthPanel } from '@/components/HealthPanel';
import { ClusterPanel } from '@/components/ClusterPanel';
import { SessionPanel } from '@/components/SessionPanel';
import { ComparePanel } from '@/components/ComparePanel';
import { TrackPanel } from '@/components/TrackPanel';
import { RideHistoryPanel } from '@/components/RideHistoryPanel';
import { CoveragePanel } from '@/components/CoveragePanel';
import type { CaptureStore } from '@/state/captureStore';
import type { RecordedSeries } from '@/services/sessionClient';
import type { CanFrame, CockpitTab, TelemetrySource } from '@/types/can';

export interface MainWorkspaceProps {
  mainRef: RefObject<HTMLElement>;
  store: CaptureStore;
  activeTab: CockpitTab;
  setActiveTab: (tab: CockpitTab) => void;
  source: TelemetrySource;
  triggerArmed: boolean;
  onArmTrigger: (id: number | null) => void;
  canTransmit: boolean;
  onTransmit: (payload: number[]) => { ok: boolean; error?: string };
  clockRate: number;
  token: string;
  onTokenChange: (token: string) => void;
  serverUrl: string;
  onServerUrlChange: (url: string) => void;
  recordedSessionId: string | null;
  onSelectSession: (id: string | null) => void;
  replaySessionId: string | null;
  onSessionLoaded: (series: RecordedSeries[], mode: 'replay' | 'all', sessionId: string) => void;
  onLogLoaded: (frames: CanFrame[]) => void;
  replayTimeSec: number;
  onSeekTime: (tMs: number) => void;
  replaySynced: boolean;
  onOpenSession: (sessionId: string) => void;
}

/** The active view of the cockpit; each tab mounts its panel only while selected. */
export function MainWorkspace({ mainRef, ...p }: MainWorkspaceProps) {
  const server = { token: p.token, onTokenChange: p.onTokenChange, serverUrl: p.serverUrl, onServerUrlChange: p.onServerUrlChange };
  return (
    <main ref={mainRef} className="min-w-0 flex-1 overflow-hidden">
      {p.activeTab === 'trace' && <TracePanel store={p.store} triggerArmed={p.triggerArmed} onArmTrigger={p.onArmTrigger} />}
      {p.activeTab === 'sniffer' && <SnifferPanel store={p.store} />}
      {p.activeTab === 'oscilloscope' && <OscilloscopePanel store={p.store} />}
      {p.activeTab === 'uds' && <UdsPanel store={p.store} canTransmit={p.canTransmit} onTransmit={p.onTransmit} />}
      {p.activeTab === 'health' && <HealthPanel store={p.store} />}
      {p.activeTab === 'cluster' && <ClusterPanel store={p.store} clockRate={p.clockRate} />}
      {p.activeTab === 'session' && (
        <SessionPanel
          {...server}
          onLoad={p.onSessionLoaded}
          onSelect={p.onSelectSession}
          selectedSessionId={p.recordedSessionId}
          // Replay times are /series `t_ms / 1000` (same t0 as the report window instances).
          sessionEndMs={p.replaySessionId !== null && p.replaySessionId === p.recordedSessionId ? Math.round(p.store.lastTime * 1000) : null}
        />
      )}
      {p.activeTab === 'compare' && <ComparePanel {...server} />}
      {p.activeTab === 'track' && (
        <TrackPanel
          key={p.recordedSessionId ?? 'none'}
          {...server}
          sessionId={p.recordedSessionId}
          replayTimeSec={p.replayTimeSec}
          onSeekTime={p.onSeekTime}
          replaySynced={p.replaySynced}
        />
      )}
      {p.activeTab === 'rides' && <RideHistoryPanel {...server} onOpenSession={p.onOpenSession} />}
      {p.activeTab === 'coverage' && <CoveragePanel {...server} selectedSessionId={p.recordedSessionId} />}
      {p.activeTab === 'sync' && <SyncPanel store={p.store} source={p.source} onLogLoaded={p.onLogLoaded} />}
    </main>
  );
}
