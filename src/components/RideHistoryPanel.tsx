import React, { useMemo, useState } from 'react';
import { Note, Segmented, TermButton, TermInput, Toolbar } from '../ui/primitives';
import { Empty, ListHead } from '../ui/panel-parts';
import { useHotkeys } from '../ui/keys';
import { fetchRides, type RidesColumn, type RidesResponse } from '../services/sessionClient';
import { formatRideValue } from '../services/rideSummaryLayout';
import {
  MAX_HISTORY_COLUMNS,
  chartPoints,
  defaultColumns,
  lineRuns,
  mapPoints,
  pointText,
  selectedColumns,
  toggleColumn,
  xDomain,
  yDomain,
  type RideHistoryAxis,
} from '../services/rideHistoryLayout';

interface RideHistoryPanelProps {
  token: string;
  onTokenChange: (token: string) => void;
  serverUrl: string;
  onServerUrlChange: (url: string) => void;
  onOpenSession: (sessionId: string) => void;
}

const W = 900;
const H = 84;

const HistoryChart: React.FC<{
  response: RidesResponse;
  column: RidesColumn;
  axis: RideHistoryAxis;
  onOpenSession: (sessionId: string) => void;
}> = ({ response, column, axis, onOpenSession }) => {
  const points = useMemo(() => chartPoints(response.rows, column.name, axis), [response.rows, column.name, axis]);
  const xd = useMemo(() => xDomain(points), [points]);
  const yd = useMemo(() => yDomain(points), [points]);
  const runs = useMemo(() => lineRuns(points).map((run) => mapPoints(run, xd, yd ?? [0, 1], W, H)), [points, xd, yd]);
  const circles = useMemo(() => (yd ? mapPoints(points, xd, yd, W, H) : []), [points, xd, yd]);
  const first = axis === 'order' ? 1 : new Date(xd[0]).toISOString().slice(0, 16).replace('T', ' ');
  const last = axis === 'order' ? Math.max(1, response.rows.length) : new Date(xd[1]).toISOString().slice(0, 16).replace('T', ' ');
  return (
    <section className="border-b border-term-rule px-[14px] py-2" aria-label={`${column.name} ride history`}>
      <div className="flex items-baseline gap-[2ch]">
        <span className="text-term-fg">{column.name}</span>
        <span className="text-term-faint">{column.unit}</span>
        <span className="ml-auto text-term-dim">{points.filter((point) => point.value !== null).length}/{points.length} rides</span>
      </div>
      {yd === null ? (
        <Empty>No values for this column.</Empty>
      ) : (
        <>
          <svg viewBox={`0 0 ${W} ${H}`} className="h-[84px] w-full border-b border-term-rule" preserveAspectRatio="none" role="img" aria-label={`${column.name} ride history`}>
            {runs.map((run, index) =>
              run.length === 1 ? (
                <circle key={`single${index}`} cx={run[0].px} cy={run[0].py} r={2.5} className="fill-current text-term-amber" />
              ) : (
                <polyline key={`line${index}`} points={run.map((point) => `${point.px},${point.py}`).join(' ')} fill="none" className="stroke-current text-term-amber" strokeWidth={1.4} vectorEffect="non-scaling-stroke" />
              )
            )}
            {circles.map((point, index) => (
              <circle
                key={`${point.sessionId}-${index}`}
                cx={point.px}
                cy={point.py}
                r={3.5}
                className="cursor-pointer fill-current text-term-hi hover:text-term-amber"
                role="button"
                tabIndex={0}
                aria-label={`${pointText(point, column.unit, yd)}${point.flag ? ` · ${point.flag}` : ''}`}
                onClick={() => onOpenSession(point.sessionId)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    onOpenSession(point.sessionId);
                  }
                }}
              >
                <title>{`${pointText(point, column.unit, yd)}${point.flag ? ` · ${point.flag}` : ''}`}</title>
              </circle>
            ))}
          </svg>
          <div className="flex justify-between text-term-faint">
            <span>{first}</span>
            <span>
              y {formatRideValue(yd[0], yd)} .. {formatRideValue(yd[1], yd)} {column.unit}
            </span>
            <span>{last}</span>
          </div>
        </>
      )}
    </section>
  );
};

/** Cross-session scalar history from GET /rides (RS-7). Columns come from the response. */
export const RideHistoryPanel: React.FC<RideHistoryPanelProps> = ({ token, onTokenChange, serverUrl, onServerUrlChange, onOpenSession }) => {
  const [response, setResponse] = useState<RidesResponse | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [axis, setAxis] = useState<RideHistoryAxis>('order');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');

  const refresh = async () => {
    if (!serverUrl.trim()) {
      setError('No vehicle-server URL configured.');
      setResponse(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await fetchRides({ serverUrl, token }, { from: from || undefined, to: to || undefined });
      setResponse(next);
      setSelected((previous) => {
        const valid = selectedColumns(next.columns, previous);
        return valid.length > 0 ? valid : defaultColumns(next.columns);
      });
      setStatus(`${next.rows.length} ride${next.rows.length === 1 ? '' : 's'}${next.skipped > 0 ? ` · ${next.skipped} skipped` : ''}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  useHotkeys({ r: () => void refresh() });

  const columns = response?.columns ?? [];
  const choose = (name: string) => setSelected((previous) => toggleColumn(previous, name, MAX_HISTORY_COLUMNS));

  return (
    <div className="flex h-full select-none flex-col overflow-y-auto bg-term-bg">
      <Toolbar>
        <TermInput value={serverUrl} onChange={(e) => onServerUrlChange(e.target.value)} aria-label="vehicle-server URL" spellCheck={false} className="w-64" />
        <TermInput type="password" value={token} onChange={(e) => onTokenChange(e.target.value)} placeholder="token" aria-label="vehicle-server API token" autoComplete="off" className="w-32 min-w-0" />
        <TermInput type="date" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Rides from (UTC)" className="w-[142px] min-w-0" />
        <span className="text-term-dim">–</span>
        <TermInput type="date" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Rides to (UTC)" className="w-[142px] min-w-0" />
        <TermButton hotkey="R" boxed onClick={() => void refresh()} disabled={busy}>
          Refresh
        </TermButton>
        <span className="ml-auto text-term-dim">{busy ? 'working...' : 'read-only HTTP, token in the Authorization header only'}</span>
      </Toolbar>

      {error && (
        <div role="alert" className="shrink-0 border-b border-term-rule bg-term-redBg px-[14px] leading-[24px] text-term-red">
          ■ {error}
        </div>
      )}
      {status && !error && <div className="shrink-0 border-b border-term-rule px-[14px] leading-[24px] text-term-fg">{status}</div>}

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-term-rule px-[14px] py-[6px]">
        <span className="text-term-dim">
          columns {selected.length}/{MAX_HISTORY_COLUMNS}
        </span>
        <div className="flex flex-wrap gap-1" aria-label="History columns">
          {columns.map((column) => {
            const on = selected.includes(column.name);
            return (
              <TermButton
                key={column.name}
                toggled={on}
                disabled={!on && selected.length >= MAX_HISTORY_COLUMNS}
                onClick={() => choose(column.name)}
                title={`${column.name} [${column.unit}]`}
              >
                {column.name}
              </TermButton>
            );
          })}
        </div>
        <Segmented<RideHistoryAxis>
          label="Ride x-axis"
          value={axis}
          onChange={setAxis}
          options={[
            { value: 'order', label: 'ride order' },
            { value: 'time', label: 'created_utc' },
          ]}
        />
      </div>

      {columns.length === 0 ? (
        <Empty>{response ? 'The server returned no scalar columns.' : 'Refresh to load the ride table. 1–4 scalar columns, no hard-coded signals.'}</Empty>
      ) : (
        <>
          <ListHead aside={`${response?.rows.length ?? 0} rides`}>ride history</ListHead>
          {selected.map((name) => {
            const column = columns.find((value) => value.name === name);
            return column ? <HistoryChart key={name} response={response!} column={column} axis={axis} onOpenSession={onOpenSession} /> : null;
          })}
          <Note className="px-[14px] py-2">
            {axis === 'order' ? 'x = ride order from the server table.' : 'x = created_utc.'} Gaps break the line; hover a dot for session, value and flag; click it to open the session in Recorded sessions (E).
            {response && response.skipped > 0 ? ` ${response.skipped} session${response.skipped === 1 ? '' : 's'} without a stored summary skipped.` : ''}
          </Note>
        </>
      )}
    </div>
  );
};
