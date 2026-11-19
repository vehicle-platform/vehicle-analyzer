import React from 'react';
import { CaptureStore } from '../state/captureStore';
import { evaluateWindow, WindowState } from '../services/windows';
import { isE2EValid } from '../services/e2e';
import { formatSignal, formatValue } from '../services/format';
import { frameKey } from '../services/capture';
import { FaultCell, Na, Note, Pane, TextMeter, Toolbar, cn } from '../ui/primitives';
import { GutterMark, TD, TH } from '../ui/panel-parts';

interface HealthPanelProps {
  store: CaptureStore;
}

/** Condition result: holds dim, failing `no` amber, unobservable `n/a` faint. */
const HoldText: React.FC<{ h: boolean | null }> = ({ h }) =>
  h === null ? <span className="text-term-faint">n/a</span> : h ? <span className="text-term-dim">holds</span> : <span className="text-term-amber">no</span>;

const ValueText: React.FC<{ v: number | string | null | undefined }> = ({ v }) => (v === undefined || v === null ? <Na /> : <>{formatValue(v)}</>);

/** Verdict on the pane title row, per the token state rules. */
function verdict(s: WindowState): React.ReactNode {
  const w = s.def;
  const isCondition = w.opensOn === 'condition';
  const eventOnly = w.conditions.length === 0 && w.stable.length === 0;
  if (eventOnly) return <span className="text-term-faint">event: {w.opensOn}</span>;
  if (isCondition && s.qualified) return <span className="text-term-hi">entry met</span>;
  if (s.conditionsHold === true)
    return <span className="text-term-amber">{isCondition ? `holding ${s.heldForSec.toFixed(1)} s` : `holds, needs ${w.opensOn}`}</span>;
  if (s.conditionsHold === null) return <span className="text-term-faint">– not observable</span>;
  return <span className="text-term-amber">! not met</span>;
}

/** One D-079 window, styled like the mockup's W3_WARM_IDLE pane. */
const WindowPane: React.FC<{ s: WindowState }> = ({ s }) => {
  const w = s.def;
  return (
    <Pane title={w.key} aside={verdict(s)} className="border-r">
      <div className="text-term-faint">
        {w.record}
        {w.recordDid !== undefined && ` 0x${w.recordDid.toString(16).toUpperCase()}`}, opens on {w.opensOn}, {w.minDurationMs / 1000}–{w.maxDurationMs / 1000} s
      </div>
      <p className="mb-[6px] mt-[2px] text-term-dim">{w.description}</p>
      <div className="mt-[6px] grid grid-cols-[1fr_auto_5ch] gap-x-3">
        {s.conditions.length === 0 && s.stable.length === 0 && (
          <span className="col-span-3 text-term-faint">No condition: opened by the {w.opensOn} event alone.</span>
        )}
        {s.conditions.map((c, i) => (
          <React.Fragment key={i}>
            <span className="truncate" title={c.input.note ? `${c.text} (${c.input.note})` : c.text}>
              {c.text}
              {c.input.note && <span className="text-term-faint"> ({c.input.note})</span>}
            </span>
            <span className="text-right">
              <ValueText v={c.value} />
            </span>
            <span className="text-right">
              <HoldText h={c.holds} />
            </span>
          </React.Fragment>
        ))}
        {s.stable.map((st, i) => (
          <React.Fragment key={`s${i}`}>
            <span className="truncate">
              {st.input.label} spread ≤ {st.maxSpread} over {w.minDurationMs / 1000} s
            </span>
            <span className="text-right">
              <ValueText v={st.spread} />
            </span>
            <span className="text-right">
              <HoldText h={st.holds} />
            </span>
          </React.Fragment>
        ))}
      </div>
    </Pane>
  );
};

/** Error count: red when above zero, faint otherwise. */
const Count: React.FC<{ n: number | undefined }> = ({ n }) => <span className={(n ?? 0) > 0 ? 'text-term-red' : 'text-term-faint'}>{n ?? 0}</span>;

export const HealthPanel: React.FC<HealthPanelProps> = ({ store }) => {
  const defs = store.defs;
  const now = store.lastTime;
  const windows = defs.windows.map((w) => evaluateWindow(defs, w, store.history, now));
  const e2e = store.pipeline.getE2EStats();
  const heartbeats = store.pipeline
    .catalog('platform')
    .filter((m) => m.signals.some((s) => s.name.endsWith('NODE_MODE')))
    .map((m) => ({ msg: m, frame: store.framesByKey.get(frameKey('platform', m.id)) }));
  const buses = [...store.busLoad.entries()].sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="flex h-full select-none flex-col bg-term-bg">
      <Toolbar>
        <span className="font-semibold text-term-hi">D-079 health windows W1–W5</span>
        <span className="text-term-amber">! provisional values</span>
        <span className="ml-auto text-term-dim">derived/cl250_derived.yaml · defs {defs.ref}</span>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto">
        <p className="border-b border-term-rule px-[14px] py-[6px] italic text-term-dim">
          Window records are computed on rt-core and read as ride-summary DIDs. This view checks each window's entry condition against the inputs the
          analyzer can observe; it does not compute the records.
        </p>

        {/* Columns separated by rules; the wrapper hides the last column's right rule. */}
        <div className="overflow-hidden">
          <div className="-mr-px grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))]">
            {windows.map((s) => (
              <WindowPane key={s.def.key} s={s} />
            ))}
          </div>
        </div>

        <div className="overflow-hidden">
          <div className="-mr-px grid grid-cols-[repeat(auto-fit,minmax(520px,1fr))]">
            <Pane title="E2E supervisor" aside="platform bus" className="border-r">
              {e2e.length === 0 ? (
                <span className="text-term-faint">No E2E-protected message seen.</span>
              ) : (
                <table className="-mx-2 w-[calc(100%+16px)] border-collapse">
                  <thead>
                    <tr>
                      <th className={TH}>message</th>
                      <th className={TH}>status</th>
                      <th className={cn(TH, 'text-right')}>ok</th>
                      <th className={cn(TH, 'text-right')}>crc</th>
                      <th className={cn(TH, 'text-right')}>seq</th>
                      <th className={cn(TH, 'text-right')}>rep</th>
                      <th className={cn(TH, 'text-right')}>timeout</th>
                    </tr>
                  </thead>
                  <tbody>
                    {e2e.map((m) => {
                      const ok = isE2EValid(m.status);
                      return (
                        <tr key={m.id}>
                          <td className={cn(TD, ok ? '' : 'text-term-red')}>
                            <span className={ok ? 'text-term-hi' : ''}>0x{m.id.toString(16).toUpperCase().padStart(3, '0')}</span> {m.name}
                          </td>
                          <td className={TD}>{ok ? <span className="text-term-dim">{m.status.toLowerCase()}</span> : <FaultCell>{m.status}</FaultCell>}</td>
                          <td className={cn(TD, 'text-right')}>{m.counts.OK ?? 0}</td>
                          <td className={cn(TD, 'text-right')}>
                            <Count n={m.counts.WRONG_CRC} />
                          </td>
                          <td className={cn(TD, 'text-right')}>
                            <Count n={m.counts.WRONG_SEQUENCE} />
                          </td>
                          <td className={cn(TD, 'text-right')}>
                            <Count n={m.counts.REPEATED} />
                          </td>
                          <td className={cn(TD, 'text-right')}>
                            <Count n={m.counts.NO_NEW_DATA} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
              <Note className="text-term-faint">CRC-8/SAE-J1850 over DataID + payload, counter step 1, timeout 3 × cycle time (docs/e2e-profile.md).</Note>
            </Pane>

            <Pane title="Node heartbeats and bus load" className="border-r">
              <table className="-mx-2 w-[calc(100%+16px)] border-collapse">
                <thead>
                  <tr>
                    <th className={cn(TH, 'w-[22px] pr-0')} aria-label="mark" />
                    <th className={TH}>node</th>
                    <th className={TH}>mode</th>
                    <th className={cn(TH, 'text-right')}>errors</th>
                    <th className={cn(TH, 'text-right')}>uptime s</th>
                    <th className={cn(TH, 'text-right')}>age ms</th>
                  </tr>
                </thead>
                <tbody>
                  {heartbeats.map(({ msg, frame }) => {
                    // v0.29.0: heartbeat signals are prefixed per node (RT_CORE_NODE_MODE, CONN_UPTIME, ...).
                    const sig = (n: string) => msg.signals.find((s) => s.name.endsWith(n));
                    const v = frame?.decodedSignals ?? {};
                    const ageMs = frame ? (now - frame.timestamp) * 1000 : null;
                    const late = ageMs !== null && msg.cycleTimeMs ? ageMs > 3 * msg.cycleTimeMs : true;
                    return (
                      <tr key={msg.id}>
                        <td className={cn(TD, 'pr-0')}>
                          <GutterMark fault={late} />
                        </td>
                        <td className={cn(TD, late && 'text-term-red')}>{msg.name.replace('Heartbeat', '')}</td>
                        <td className={TD}>{frame ? formatSignal(sig('NODE_MODE'), v[sig('NODE_MODE')?.name ?? '']) : <span className="text-term-red">not seen</span>}</td>
                        <td className={cn(TD, 'text-right')}>{frame ? formatValue(v[sig('ERROR_COUNT')?.name ?? '']) : <Na />}</td>
                        <td className={cn(TD, 'text-right')}>{frame ? formatValue(v[sig('UPTIME')?.name ?? '']) : <Na />}</td>
                        <td className={cn(TD, 'text-right', late ? 'text-term-red' : 'text-term-faint')}>{ageMs !== null ? ageMs.toFixed(0) : <Na />}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="mt-3 flex flex-col">
                {buses.map(([bus, l]) => (
                  <span key={bus} className="flex items-center gap-[2ch] whitespace-nowrap">
                    <TextMeter label={bus.padEnd(8, ' ')} pct={l.loadPct} />
                    <span className="text-term-dim">
                      peak <span className="text-term-fg">{l.peakPct.toFixed(1)}%</span> · <span className="text-term-fg">{l.framesPerSec.toFixed(0)}</span> fr/s
                    </span>
                  </span>
                ))}
              </div>
              <Note className="text-term-faint">Late = no heartbeat for 3 × the cycle time.</Note>
            </Pane>
          </div>
        </div>
      </div>
    </div>
  );
};
