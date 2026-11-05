import React, { useEffect, useMemo, useRef, useState } from 'react';
import { DEFS } from '../defs';
import type { HealthWindowDef } from '../defs/model';
import { Na, Note, cn } from '../ui/primitives';
import { TD, TH } from '../ui/panel-parts';
import {
  NoRideSummaryError,
  fetchRideSummary,
  type RideSummary as RideSummaryData,
  type RideSummarySignal,
} from '../services/sessionClient';
import { formatRideValue } from '../services/rideSummaryLayout';
import { parseHealthWindows, type HealthWindowInstances } from '../services/healthWindows';

interface HealthWindowsProps {
  token: string;
  serverUrl: string;
  sessionId: string | null;
  /** The report view E already fetched; no second report request. */
  report: unknown;
  /** Last replay sample of this session in ms on the `/series` t0 axis, when E has it. */
  sessionEndMs?: number | null;
}

const TIMELINE_WIDTH = 600;
const TIMELINE_HEIGHT = 12;

const seconds = (ms: number): string => (ms / 1000).toFixed(1);

const conditionText = (window: HealthWindowDef): string => {
  const conditions = window.conditions.map((condition) => `${condition.input} ${condition.op} ${condition.value}`);
  const stable = window.stable.map((entry) => `${entry.input} spread ${entry.maxSpread}`);
  return [...conditions, ...stable].join(' · ') || 'no conditions in defs';
};

const signalText = (signal: RideSummarySignal, defsUnit: string): { value: React.ReactNode; unit: string; flag: string } => {
  if (signal.status !== 'computed') {
    const detail = 'reason' in signal && signal.reason ? signal.reason : 'message' in signal && signal.message ? signal.message : signal.status;
    return { value: <Na />, unit: defsUnit, flag: detail };
  }
  if (signal.kind !== 'scalar') return { value: <Na />, unit: signal.unit, flag: signal.kind };
  return { value: formatRideValue(signal.value, signal.range), unit: signal.unit, flag: signal.flag ?? '—' };
};

const InstanceTable: React.FC<{ windowKey: string; entry: HealthWindowInstances }> = ({ windowKey, entry }) => {
  if (entry.instances.length === 0) return <Note className="py-1">No instance.</Note>;
  return (
    <table className="w-full border-collapse" aria-label={`${windowKey} instances`}>
      <thead>
        <tr>
          <th className={TH}>start s</th>
          <th className={TH}>end s</th>
          <th className={TH}>duration s</th>
          <th className={TH}>close reason</th>
          <th className={TH}>qualifies</th>
        </tr>
      </thead>
      <tbody>
        {entry.instances.map((instance, index) => (
          <tr key={index}>
            <td className={cn(TD, 'text-term-hi')}>{seconds(instance.startMs)}</td>
            <td className={cn(TD, 'text-term-hi')}>{seconds(instance.endMs)}</td>
            <td className={cn(TD, 'text-term-dim')}>{seconds(instance.durationMs)}</td>
            <td className={cn(TD, 'text-term-dim')}>{instance.closeReason}</td>
            <td className={cn(TD, instance.qualifies ? 'text-term-fg' : 'text-term-faint')}>
              {instance.qualifies ? 'yes' : 'no'}
              {instance.firstQualifying ? ' · first' : ''}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

/** D-079 health-window instances from the report, rendered verbatim; nothing is re-computed. */
export const HealthWindows: React.FC<HealthWindowsProps> = ({ token, serverUrl, sessionId, report, sessionEndMs }) => {
  const parsed = useMemo(() => parseHealthWindows(report, DEFS), [report]);
  const [summary, setSummary] = useState<RideSummaryData | null>(null);
  const [summaryNote, setSummaryNote] = useState('Loading computed window signals...');
  const connection = useRef({ serverUrl, token });
  connection.current = { serverUrl, token };
  const hasServer = serverUrl.trim() !== '';

  useEffect(() => {
    if (!sessionId || !hasServer) {
      setSummary(null);
      setSummaryNote('No vehicle-server URL configured.');
      return;
    }
    let cancelled = false;
    setSummary(null);
    setSummaryNote('Loading computed window signals...');
    fetchRideSummary({ serverUrl: connection.current.serverUrl, token: connection.current.token }, sessionId)
      .then((value) => {
        if (!cancelled) {
          setSummary(value);
          setSummaryNote('');
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setSummaryNote(
          error instanceof NoRideSummaryError
            ? 'No stored ride summary for this session.'
            : error instanceof Error
              ? `Ride summary: ${error.message}`
              : 'Ride summary request failed.'
        );
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, hasServer]);

  if (parsed.ok === false) {
    return (
      <div className="px-[14px] py-2">
        {parsed.reason === 'not in report' ? (
          <Note className="py-1">No window instances in this report (older server, or run `vehicle-server derive &lt;id&gt;`).</Note>
        ) : (
          <div role="alert" className="text-term-red">
            ■ health windows: {parsed.reason}
          </div>
        )}
      </div>
    );
  }

  const byKey = new Map(parsed.windows.map((entry) => [entry.key, entry]));
  const unknown = parsed.windows.filter((entry) => entry.unknownInDefs);
  const lastInstanceEnd = parsed.windows.reduce(
    (latest, entry) => entry.instances.reduce((inner, instance) => Math.max(inner, instance.endMs), latest),
    0
  );
  const spanMs = Math.max(1, sessionEndMs !== null && sessionEndMs !== undefined ? sessionEndMs : 0, lastInstanceEnd);
  const signalByName = new Map(summary?.signals.map((signal) => [signal.name, signal]) ?? []);
  const x = (ms: number): number => Math.max(0, Math.min(TIMELINE_WIDTH, (ms / spanMs) * TIMELINE_WIDTH));

  return (
    <section className="border-t border-term-rule px-[14px] py-2" aria-label="Health windows">
      <div className="flex flex-wrap items-baseline gap-[2ch]">
        <span className="font-semibold text-term-hi">Health windows</span>
        <span className="border border-term-ruleHi px-1 text-term-amber">{parsed.rule}</span>
        <span className="ml-auto text-term-faint">
          0–{seconds(spanMs)} s · {parsed.windows.reduce((count, entry) => count + entry.instances.length, 0)} instance(s)
        </span>
      </div>

      <div className="mt-2 space-y-1" role="img" aria-label="Health window timeline">
        {DEFS.windows.map((window) => {
          const entry = byKey.get(window.key);
          return (
            <div key={window.key} className="grid grid-cols-[10ch_minmax(0,1fr)] items-center gap-[1ch]">
              <span className="truncate text-term-dim" title={window.description}>
                {window.key}
              </span>
              <svg viewBox={`0 0 ${TIMELINE_WIDTH} ${TIMELINE_HEIGHT}`} className="h-3 w-full" preserveAspectRatio="none">
                <line x1={0} y1={TIMELINE_HEIGHT / 2} x2={TIMELINE_WIDTH} y2={TIMELINE_HEIGHT / 2} className="stroke-current text-term-rule" />
                {(entry?.instances ?? []).map((instance, index) => {
                  const start = x(instance.startMs);
                  const end = x(instance.endMs);
                  return (
                    <rect
                      key={index}
                      data-testid="health-window-band"
                      data-window={window.key}
                      data-first-qualifying={instance.firstQualifying ? 'true' : undefined}
                      x={start}
                      y={2}
                      width={Math.max(1, end - start)}
                      height={TIMELINE_HEIGHT - 4}
                      className={cn('stroke-current', instance.qualifies ? 'fill-current text-term-amber' : 'fill-none text-term-faint')}
                    >
                      <title>
                        {window.key} {seconds(instance.startMs)}–{seconds(instance.endMs)} s · {seconds(instance.durationMs)} s · {instance.closeReason}
                        {instance.qualifies ? ' · qualifies' : ''}
                        {instance.firstQualifying ? ' · first qualifying' : ''}
                      </title>
                    </rect>
                  );
                })}
                {(entry?.instances ?? [])
                  .filter((instance) => instance.firstQualifying)
                  .map((instance, index) => (
                    <rect
                      key={`first-${index}`}
                      x={x(instance.startMs)}
                      y={0}
                      width={2}
                      height={TIMELINE_HEIGHT}
                      className="fill-current text-term-hi"
                    />
                  ))}
              </svg>
            </div>
          );
        })}
      </div>

      {unknown.length > 0 && (
        <section className="mt-2 border-t border-term-rule pt-1" aria-label="Windows not in the bundled defs">
          <div className="text-term-amber">not in the bundled defs</div>
          <ul className="mt-1">
            {unknown.map((entry) => (
              <li key={entry.key} className="flex gap-[2ch]">
                <span className="text-term-fg">{entry.key}</span>
                <span className="text-term-dim">{entry.instances.length} instance(s), {entry.qualifyingCount} qualifying</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summaryNote && <Note className="mt-1">{summaryNote}</Note>}

      <div className="mt-2 divide-y divide-term-rule">
        {DEFS.windows.map((window) => {
          const entry = byKey.get(window.key);
          const signals = DEFS.derivedSignals.filter((signal) => signal.window === window.key);
          return (
            <section key={window.key} className="py-2" aria-label={`${window.key} window detail`}>
              <div className="flex flex-wrap items-baseline gap-[2ch]">
                <span className="font-semibold text-term-hi">{window.key}</span>
                <span className="min-w-0 truncate text-term-fg">{window.description}</span>
                {entry === undefined && <span className="ml-auto text-term-faint">not evaluated</span>}
              </div>
              <div className="text-term-dim">
                opens on {window.opensOn} · min {seconds(window.minDurationMs)} s · max {seconds(window.maxDurationMs)} s
              </div>
              <div className="text-term-dim">{conditionText(window)}</div>
              {entry === undefined ? (
                <Note className="py-1">not evaluated</Note>
              ) : (
                <div className="mt-1">
                  <InstanceTable windowKey={window.key} entry={entry} />
                </div>
              )}
              {summary && (
                <table className="mt-1 w-full border-collapse" aria-label={`${window.key} computed signals`}>
                  <thead>
                    <tr>
                      <th className={TH}>computed signal</th>
                      <th className={TH}>value</th>
                      <th className={TH}>unit</th>
                      <th className={TH}>flag</th>
                    </tr>
                  </thead>
                  <tbody>
                    {signals.map((signal) => {
                      const value = signalByName.get(signal.name);
                      if (value === undefined) {
                        return (
                          <tr key={signal.name}>
                            <td className={cn(TD, 'text-term-fg')}>{signal.name}</td>
                            <td className={cn(TD, 'text-term-faint')}>not in summary</td>
                            <td className={cn(TD, 'text-term-dim')}>{signal.unit}</td>
                            <td className={cn(TD, 'text-term-faint')}>—</td>
                          </tr>
                        );
                      }
                      const text = signalText(value, signal.unit);
                      return (
                        <tr key={signal.name}>
                          <td className={cn(TD, 'text-term-fg')}>{signal.name}</td>
                          <td className={cn(TD, 'text-term-hi')}>{text.value}</td>
                          <td className={cn(TD, 'text-term-dim')}>{text.unit}</td>
                          <td className={cn(TD, 'text-term-dim')}>{text.flag}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          );
        })}
      </div>
    </section>
  );
};
