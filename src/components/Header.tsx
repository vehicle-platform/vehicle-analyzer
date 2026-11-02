import React from 'react';
import { BusRole, CockpitTab, TelemetrySource } from '../types/can';
import type { BusLoad } from '../state/captureStore';
import type { WsStatus } from '../App';
import { RadioList, TermButton, TextMeter, cn } from '../ui/primitives';
import type { Theme } from '../ui/theme';

interface HeaderProps {
  activeTab: CockpitTab;
  onTabChange: (tab: CockpitTab) => void;
  isRunning: boolean;
  onTogglePlay: () => void;
  onClear: () => void;
  busLoad: Map<string, BusLoad>;
  msgPerSec: number;
  totalRx: number;
  source: TelemetrySource;
  onSourceChange: (source: TelemetrySource) => void;
  usbRole: BusRole;
  onUsbRoleChange: (role: BusRole) => void;
  wsUrl: string;
  onWsUrlChange: (url: string) => void;
  wsToken: string;
  onWsTokenChange: (token: string) => void;
  /** Producer named by the server heartbeat ("mock", "none", ...); null before the first one. */
  wsSource: string | null;
  wsStatus: WsStatus;
  defsRef: string;
  customDbc: string | null;
  showAttitudeHud: boolean;
  onToggleAttitudeHud: () => void;
  theme: Theme;
  onToggleTheme: () => void;
}

/** Tabs with their single-key shortcut (the shortcuts themselves are bound in App). */
export const TABS: { id: CockpitTab; key: string; label: string }[] = [
  { id: 'trace', key: 'T', label: 'CAN trace' },
  { id: 'sniffer', key: 'S', label: 'Sniffer' },
  { id: 'oscilloscope', key: 'O', label: 'Oscilloscope' },
  { id: 'uds', key: 'U', label: 'UDS' },
  { id: 'health', key: 'H', label: 'Health' },
  { id: 'cluster', key: 'F', label: 'Cluster' },
  { id: 'sync', key: 'D', label: 'Defs & logs' },
  { id: 'session', key: 'E', label: 'Sessions' },
  { id: 'compare', key: 'A', label: 'Compare' },
  { id: 'track', key: 'G', label: 'Ride track' },
  { id: 'rides', key: 'N', label: 'Ride history' },
];

const SOURCES: { value: TelemetrySource; label: string; title: string }[] = [
  { value: 'virtual', label: 'Virtual bus', title: 'Simulated CL250 vehicle bus + platform bus' },
  { value: 'local_file', label: 'Log replay', title: 'Replay an .asc or .csv log' },
  { value: 'server_session', label: 'Session', title: 'Recorded vehicle-server session (read-only HTTP)' },
  { value: 'websocket', label: 'WS live', title: 'vehicle-server live stream' },
  { value: 'webserial', label: 'USB CAN', title: 'SLCAN adapter, opened listen-only' },
];

/** Cells per bus-load bar; the header must fit 1366 px with two buses. */
const METER_CELLS = 14;

const Group: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className }) => (
  <div className={cn('flex shrink-0 items-center gap-3 whitespace-nowrap border-r border-term-rule px-[14px] last:border-r-0', className)}>
    {children}
  </div>
);

export const Header: React.FC<HeaderProps> = (p) => {
  const buses = [...p.busLoad.entries()].sort(([a], [b]) => a.localeCompare(b));
  const replay = p.source === 'local_file' || p.source === 'server_session';

  return (
    <header className="shrink-0 select-none">
      {/* Row 1: identity, source, meters, actions */}
      <div className="flex h-strip items-stretch overflow-hidden border-b border-term-rule bg-term-raise">
        <Group>
          <span className="font-semibold tracking-[.01em] text-term-hi">
            vehicle<span className="text-term-amber">-</span>analyzer
          </span>
          {p.customDbc ? (
            <span
              className="border border-term-amber px-[6px] leading-[18px] text-term-amber"
              title={`Platform bus decoded with ${p.customDbc} (not vehicle-defs)`}
            >
              ! custom DBC: {p.customDbc}
            </span>
          ) : (
            <span className="border border-term-ruleHi px-[6px] leading-[18px] text-term-dim" title="Pinned vehicle-defs tag">
              defs {p.defsRef}
            </span>
          )}
        </Group>

        <Group className="gap-2 px-[6px]">
          <RadioList label="Source" options={SOURCES} value={p.source} onChange={p.onSourceChange} />
          {p.source === 'webserial' && (
            <label className="flex items-center gap-[6px] text-term-dim" title="Bus the adapter is plugged into; it picks the DBC used for decoding">
              adapter on
              <select value={p.usbRole} onChange={(e) => p.onUsbRoleChange(e.target.value as BusRole)} className="term-select">
                <option value="vehicle">vehicle bus (DLC)</option>
                <option value="platform">platform bus</option>
              </select>
            </label>
          )}
          {p.source === 'websocket' && (
            <label className="flex items-center gap-[6px]">
              <input
                value={p.wsUrl}
                onChange={(e) => p.onWsUrlChange(e.target.value)}
                aria-label="WebSocket URL"
                spellCheck={false}
                className="term-input w-52"
              />
              <input
                type="password"
                value={p.wsToken}
                onChange={(e) => p.onWsTokenChange(e.target.value)}
                placeholder="token"
                aria-label="vehicle-server API token"
                autoComplete="off"
                className="term-input w-28"
              />
              <span
                className={
                  p.wsStatus === 'connected' ? 'text-term-fg' : p.wsStatus === 'connecting' ? 'text-term-amber' : 'text-term-red'
                }
              >
                {p.wsStatus === 'connected' ? 'connected' : p.wsStatus === 'connecting' ? '! connecting' : `■ ${p.wsStatus}`}
                {p.wsStatus === 'connected' && p.wsSource ? <span className={p.wsSource === 'mock' ? 'text-term-amber' : 'text-term-dim'}> · source {p.wsSource}</span> : null}
              </span>
            </label>
          )}
        </Group>

        <Group className="ml-auto min-w-0 shrink gap-[14px] overflow-hidden">
          {buses.length === 0 ? (
            <TextMeter label="bus" pct={null} cells={METER_CELLS} title="No frames yet" />
          ) : (
            buses.map(([bus, l]) => (
              <TextMeter
                key={bus}
                label={bus}
                pct={l.loadPct}
                cells={METER_CELLS}
                title={`${bus} bus load. Peak ${l.peakPct.toFixed(1)} %, from frame bits without stuff bits (lower bound)`}
              />
            ))
          )}
          <span>
            <span className="text-term-hi">{p.msgPerSec}</span> <span className="text-term-dim">fr/s</span>
          </span>
          <span>
            <span className="text-term-hi">{p.totalRx.toLocaleString('en-US')}</span> <span className="text-term-dim">total</span>
          </span>
        </Group>

        <Group className="gap-1 px-2">
          <TermButton
            boxed
            hotkey="space"
            onClick={p.onTogglePlay}
            disabled={replay}
            title={replay ? 'Use the replay controls below (space plays and pauses the replay)' : p.isRunning ? 'Pause the live source' : 'Resume the live source'}
          >
            {p.isRunning ? 'Pause' : 'Run'}
          </TermButton>
          <TermButton hotkey="C" onClick={p.onClear} title="Clear captured data">
            Clear
          </TermButton>
          <TermButton toggled={p.showAttitudeHud} onClick={p.onToggleAttitudeHud} title="Lean angle and cornering pane (X)">
            HUD
          </TermButton>
          <TermButton hotkey="L" onClick={p.onToggleTheme} title={`Switch to the ${p.theme === 'dark' ? 'light' : 'dark'} theme`}>
            {p.theme === 'dark' ? 'light' : 'dark'}
          </TermButton>
        </Group>
      </div>

      {/* Row 2: tabs */}
      <nav role="tablist" aria-label="Views" className="flex h-tabs items-stretch border-b border-term-rule pl-[6px]">
        {TABS.map((t) => {
          const on = p.activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => p.onTabChange(t.id)}
              className={cn(
                'flex items-center gap-[6px] whitespace-nowrap px-3',
                on ? 'bg-term-amber font-semibold text-term-bg' : 'text-term-dim hover:text-term-fg'
              )}
            >
              <span className={on ? 'text-term-bg' : 'text-term-amber'}>{t.key}</span>
              {t.label}
            </button>
          );
        })}
        <span className="ml-auto flex items-center px-[14px] text-term-dim">Honda CL250, passive observer, listen-only</span>
      </nav>
    </header>
  );
};
