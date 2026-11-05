import React, { useEffect, useRef, useState } from 'react';
import { Na, Note, TermButton, cn } from '../ui/primitives';
import { Empty, TH, TD } from '../ui/panel-parts';
import {
  NoRideSummaryError,
  type PerGearSummary,
  type RideSummary as RideSummaryData,
  type RideSummaryBinned,
  type RideSummarySignal,
  type RideSummaryUnavailable,
  fetchRideSummary,
} from '../services/sessionClient';
import {
  barRects,
  cellAt,
  formatRideValue,
  heatOpacity,
  maxCellValue,
  precisionForAxis,
} from '../services/rideSummaryLayout';

interface RideSummaryProps {
  token: string;
  serverUrl: string;
  sessionId: string | null;
}

type SummaryState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'error'; message: string }
  | { kind: 'loaded'; summary: RideSummaryData };

const unavailableDetail = (signal: RideSummaryUnavailable): string => {
  const parts = [signal.reason, signal.message];
  if (signal.pendingInputs && signal.pendingInputs.length > 0) parts.push(`pending: ${signal.pendingInputs.join(', ')}`);
  if (signal.missing && signal.missing.length > 0) parts.push(`missing: ${signal.missing.join(', ')}`);
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join(' · ');
};

const edgeText = (edge: [number, number], precision: number): string =>
  `${edge[0].toFixed(precision)}–${edge[1].toFixed(precision)}`;

const BinnedChart: React.FC<{ signal: RideSummaryBinned }> = ({ signal }) => {
  const range = signal.range;
  if (signal.axes.length === 1) {
    const axis = signal.axes[0];
    const edgePrecision = precisionForAxis(axis.edges);
    const values = axis.edges.map((_, index) => cellAt(signal, [index])?.value ?? null);
    const bars = barRects(values, 320, 56, 3);
    return (
      <div className="max-w-[440px]">
        <div className="text-term-dim">
          {axis.input} [{axis.unit}]
        </div>
        <svg viewBox="0 0 320 56" className="h-14 w-full border-b border-term-rule" preserveAspectRatio="none" role="img" aria-label={`${signal.name} bins`}>
          {bars.map((bar) => (
            <rect key={bar.index} x={bar.x} y={bar.y} width={bar.width} height={bar.height} className="fill-current text-term-amber">
              <title>
                {edgeText(axis.edges[bar.index], edgePrecision)} {axis.unit}: {formatRideValue(bar.value, range)}
              </title>
            </rect>
          ))}
        </svg>
        <div className="flex text-[10px] text-term-faint">
          {axis.edges.map((edge, index) => (
            <span key={index} className="min-w-0 flex-1 truncate text-center" title={`${edgeText(edge, edgePrecision)} ${axis.unit}`}>
              {edgeText(edge, edgePrecision)}
            </span>
          ))}
        </div>
      </div>
    );
  }

  const [vertical, horizontal] = signal.axes;
  const verticalPrecision = precisionForAxis(vertical.edges);
  const horizontalPrecision = precisionForAxis(horizontal.edges);
  const max = maxCellValue(signal);
  return (
    <div className="max-w-[440px]">
      <div className="text-term-dim">
        {horizontal.input} [{horizontal.unit}]
      </div>
      <div
        className="grid items-center gap-[1px] text-[10px] text-term-faint"
        style={{ gridTemplateColumns: `minmax(64px, auto) repeat(${horizontal.edges.length}, minmax(20px, 1fr))` }}
        role="img"
        aria-label={`${signal.name} heat grid`}
      >
        <span />
        {horizontal.edges.map((edge, index) => (
          <span key={index} className="truncate text-center" title={`${edgeText(edge, horizontalPrecision)} ${horizontal.unit}`}>
            {edgeText(edge, horizontalPrecision)}
          </span>
        ))}
        {vertical.edges.map((verticalEdge, row) => (
          <React.Fragment key={row}>
            <span className="truncate pr-1" title={`${edgeText(verticalEdge, verticalPrecision)} ${vertical.unit}`}>
              {edgeText(verticalEdge, verticalPrecision)}
            </span>
            {horizontal.edges.map((_, column) => {
              const cell = cellAt(signal, [row, column]);
              const value = cell?.value ?? null;
              const opacity = heatOpacity(value, max);
              return (
                <span
                  key={column}
                  className={cn('block h-5 min-w-5 border border-term-bg', opacity > 0 ? 'bg-term-amber' : 'bg-term-rule')}
                  style={{ opacity: opacity > 0 ? opacity : 1 }}
                  title={`${edgeText(verticalEdge, verticalPrecision)} / ${edgeText(horizontal.edges[column], horizontalPrecision)}: ${formatRideValue(value, range)} ${signal.unit}${cell?.flag ? ` · ${cell.flag}` : ''}`}
                />
              );
            })}
          </React.Fragment>
        ))}
      </div>
      <div className="mt-1 text-term-dim">
        ↑ {vertical.input} [{vertical.unit}]
      </div>
    </div>
  );
};

const SignalList: React.FC<{ summary: RideSummaryData }> = ({ summary }) => {
  const scalars = summary.signals.filter((signal): signal is Extract<RideSummarySignal, { kind: 'scalar' }> => signal.status === 'computed' && signal.kind === 'scalar');
  const binned = summary.signals.filter((signal): signal is RideSummaryBinned => signal.status === 'computed' && signal.kind === 'binned');
  const perGear = summary.signals.filter((signal): signal is PerGearSummary => signal.status === 'computed' && signal.kind === 'per_gear');
  const unavailable = summary.signals.filter((signal): signal is RideSummaryUnavailable => signal.status !== 'computed');
  const hasContent = summary.signals.length > 0;

  if (!hasContent) return <Empty>No stored signals in this ride summary.</Empty>;

  return (
    <>
      {scalars.length > 0 && (
        <table className="w-full border-collapse" aria-label="Ride summary scalars">
          <thead>
            <tr>
              <th className={TH}>name</th>
              <th className={TH}>value</th>
              <th className={TH}>unit</th>
              <th className={TH}>flag</th>
            </tr>
          </thead>
          <tbody>
            {scalars.map((signal) => (
              <tr key={signal.name}>
                <td className={cn(TD, 'text-term-fg')}>{signal.name}</td>
                <td className={cn(TD, 'text-term-hi')} title={`range ${signal.range[0]}…${signal.range[1]}`}>
                  {formatRideValue(signal.value, signal.range)}
                </td>
                <td className={cn(TD, 'text-term-dim')}>{signal.unit}</td>
                <td className={cn(TD, 'text-term-dim')}>{signal.flag ?? <Na />}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {perGear.map((signal) => (
        <section key={signal.name} className="border-t border-term-rule px-[14px] py-2" aria-label={`${signal.name} summary`}>
          <div className="flex items-baseline gap-[2ch]">
            <span className="text-term-fg">{signal.name}</span>
            <span className="text-term-faint">{signal.unit}</span>
            <span className="ml-auto text-term-dim">range {signal.range[0]}…{signal.range[1]}</span>
          </div>
          {signal.gears.length === 0 ? (
            <Note className="py-1">No gear stored for this ride.</Note>
          ) : (
          <table className="w-full border-collapse" aria-label={`${signal.name} per gear`}>
            <thead>
              <tr>
                <th className={TH}>gear</th>
                <th className={TH}>value</th>
                <th className={TH}>unit</th>
                <th className={TH}>flag</th>
              </tr>
            </thead>
            <tbody>
              {[...signal.gears].sort((a, b) => a.gear - b.gear).map((gear) => (
                <tr key={gear.gear}>
                  <td className={cn(TD, 'text-term-fg')}>gear {gear.gear}</td>
                  <td className={cn(TD, 'text-term-hi')} title={`range ${signal.range[0]}…${signal.range[1]}`}>
                    {formatRideValue(gear.value, signal.range)}
                  </td>
                  <td className={cn(TD, 'text-term-dim')}>{signal.unit}</td>
                  <td className={cn(TD, 'text-term-dim')}>{gear.flag ?? <Na />}</td>
                </tr>
              ))}
            </tbody>
          </table>
          )}
        </section>
      ))}

      {binned.map((signal) => (
        <section key={signal.name} className="border-t border-term-rule px-[14px] py-2" aria-label={`${signal.name} summary`}>
          <div className="flex items-baseline gap-[2ch]">
            <span className="text-term-fg">{signal.name}</span>
            <span className="text-term-faint">{signal.unit}</span>
            <span className="ml-auto text-term-dim">
              total {formatRideValue(signal.totalS, [0, 600])}s · outside {formatRideValue(signal.outsideS, [0, 600])}s
            </span>
          </div>
          {signal.defsMismatch && <Note className="text-term-amber">! stored bin edges differ from the pinned defs</Note>}
          <BinnedChart signal={signal} />
        </section>
      ))}

      {unavailable.length > 0 && (
        <details className="border-t border-term-rule px-[14px] py-2">
          <summary className="cursor-pointer text-term-dim">not available ({unavailable.length})</summary>
          <ul className="mt-1 space-y-1">
            {unavailable.map((signal) => (
              <li key={signal.name} className="flex gap-[2ch]">
                <span className="min-w-0 truncate text-term-fg">{signal.name}</span>
                <span className="text-term-faint">{signal.status}</span>
                <span className="min-w-0 truncate text-term-dim">{unavailableDetail(signal)}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
};

/** Stored class-B ride summary of the selected session (RS-5). */
export const RideSummary: React.FC<RideSummaryProps> = ({ token, serverUrl, sessionId }) => {
  const [state, setState] = useState<SummaryState>({ kind: 'idle' });
  const [nonce, setNonce] = useState(0);
  const connection = useRef({ serverUrl, token });
  connection.current = { serverUrl, token };
  const hasServer = serverUrl.trim() !== '';

  useEffect(() => {
    if (!sessionId || !hasServer) {
      setState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    fetchRideSummary({ serverUrl: connection.current.serverUrl, token: connection.current.token }, sessionId)
      .then((summary) => {
        if (!cancelled) setState({ kind: 'loaded', summary });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setState(error instanceof NoRideSummaryError ? { kind: 'none' } : { kind: 'error', message: error instanceof Error ? error.message : 'Request failed.' });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, hasServer, nonce]);

  if (!sessionId) return <Empty>No recorded session selected.</Empty>;
  if (!hasServer) return <Empty>No vehicle-server URL configured.</Empty>;
  if (state.kind === 'idle' || state.kind === 'loading') return <Empty>Loading ride summary...</Empty>;
  if (state.kind === 'none') return <Empty>No stored ride summary for this session.</Empty>;
  if (state.kind === 'error') {
    return (
      <div className="px-[14px] py-2">
        <div role="alert" className="text-term-red">
          ■ {state.message}
        </div>
        <TermButton className="mt-1" onClick={() => setNonce((value) => value + 1)}>
          Retry
        </TermButton>
      </div>
    );
  }

  if (state.summary.sessionId !== sessionId) return <Empty>Loading ride summary...</Empty>;
  const { summary } = state;
  return (
    <div>
      <div className="flex flex-wrap gap-x-[2ch] px-[14px] py-1 text-term-faint">
        <span>ride {summary.rideDefinition ?? '–'}</span>
        <span>defs {summary.defsVersion ?? '–'}</span>
        <span className="ml-auto">{summary.signals.filter((signal) => signal.status === 'computed').length} computed</span>
      </div>
      <SignalList summary={summary} />
    </div>
  );
};
