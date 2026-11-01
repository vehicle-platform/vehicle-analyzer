import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Note, Segmented, TermButton, TermInput, Toolbar, cn } from '../ui/primitives';
import { Empty, GutterMark, ListHead } from '../ui/panel-parts';
import { useHotkeys } from '../ui/keys';
import { RecordedSeries, SessionClient, SessionRow, sessionRowInfo, summarizeReport } from '../services/sessionClient';
import {
  SessionFilter,
  SessionSort,
  defaultSessionFilter,
  filterSessions,
  loadSessionFilter,
  saveSessionFilter,
  sessionStatuses,
} from '../services/sessionFilter';

interface SessionPanelProps {
  /** Shared with the WS live token (same sessionStorage key, owned by App). */
  token: string;
  onTokenChange: (token: string) => void;
  serverUrl: string;
  onServerUrlChange: (url: string) => void;
  /** Hands the fetched series to App: 'replay' = play from the start, 'all' = push everything at once. */
  onLoad: (series: RecordedSeries[], mode: 'replay' | 'all') => void;
  /** Reports the selected/opened session so the Track view can use it. */
  onSelect?: (id: string | null) => void;
  selectedSessionId?: string | null;
}

/** Browser for recorded vehicle-server sessions (read-only HTTP, token in the Authorization header only). */
export const SessionPanel: React.FC<SessionPanelProps> = ({ token, onTokenChange, serverUrl, onServerUrlChange, onLoad, onSelect, selectedSessionId }) => {
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [selected, setSelected] = useState<string | null>(selectedSessionId ?? null);
  const [report, setReport] = useState<{ key: string; value: string }[] | null>(null);
  const [status, setStatus] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<boolean>(false);
  const [filter, setFilter] = useState<SessionFilter>(() => loadSessionFilter());

  useEffect(() => {
    saveSessionFilter(filter);
  }, [filter]);

  useEffect(() => {
    if (selectedSessionId !== undefined) setSelected(selectedSessionId);
  }, [selectedSessionId]);

  const client = useMemo(() => new SessionClient(serverUrl, token), [serverUrl, token]);
  const visible = useMemo(() => filterSessions(sessions, filter), [sessions, filter]);
  const statuses = useMemo(() => sessionStatuses(sessions, filter.statuses), [sessions, filter.statuses]);

  const run = useCallback(async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }, []);

  const refresh = () =>
    run(async () => {
      const rows = await client.listSessions();
      setSessions(rows);
      setStatus(`${rows.length} session${rows.length === 1 ? '' : 's'} on the server.`);
    });

  const select = (id: string) => {
    setSelected(id);
    onSelect?.(id);
    setReport(null);
    void run(async () => {
      setReport(summarizeReport(await client.getReport(id)));
    });
  };

  const open = (mode: 'replay' | 'all') => {
    if (!selected) return;
    onSelect?.(selected);
    void run(async () => {
      const res = await client.getSeries(selected);
      if (res.series.length === 0) {
        setStatus('The session has no usable series.');
        return;
      }
      onLoad(res.series, mode);
      const pts = res.series.reduce((n, s) => n + s.v.length, 0);
      setStatus(
        mode === 'replay'
          ? `Opened ${selected}: ${res.series.length} series, ${pts.toLocaleString()} samples, ready to replay (space).`
          : `Loaded ${selected}: ${res.series.length} series, ${pts.toLocaleString()} samples, all at once.`
      );
    });
  };

  const toggleStatus = (status: string) =>
    setFilter((prev) => ({
      ...prev,
      statuses: prev.statuses.includes(status) ? prev.statuses.filter((value) => value !== status) : [...prev.statuses, status],
    }));

  const move = (delta: number) => {
    if (visible.length === 0) return;
    const i = visible.findIndex((s) => s.session_id === selected);
    const next = visible[Math.max(0, Math.min(visible.length - 1, (i < 0 ? 0 : i) + delta))];
    select(next.session_id);
  };
  useHotkeys({ j: () => move(1), k: () => move(-1), r: () => void refresh() });

  return (
    <div className="flex h-full select-none flex-col bg-term-bg">
      <Toolbar>
        <TermInput value={serverUrl} onChange={(e) => onServerUrlChange(e.target.value)} aria-label="vehicle-server URL" spellCheck={false} className="w-64" />
        <TermInput
          type="password"
          value={token}
          onChange={(e) => onTokenChange(e.target.value)}
          placeholder="token"
          aria-label="vehicle-server API token"
          autoComplete="off"
          className="w-32 min-w-0"
        />
        <TermButton hotkey="R" boxed onClick={() => void refresh()} disabled={busy} title="Fetch the session list">
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

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <nav aria-label="Sessions" className="flex w-[420px] shrink-0 flex-col overflow-y-auto border-r border-term-rule bg-term-raise">
          <ListHead aside={visible.length === sessions.length ? `${sessions.length}` : `${visible.length}/${sessions.length}`}>recorded sessions</ListHead>
          <div className="flex shrink-0 flex-col gap-1 border-b border-term-rule px-[6px] py-[6px]">
            <TermInput
              filter
              hotkey="/"
              value={filter.text}
              onChange={(e) => setFilter((prev) => ({ ...prev, text: e.target.value }))}
              placeholder="filter session id"
              aria-label="Filter sessions by id"
              spellCheck={false}
              className="w-full min-w-0"
              wrapClassName="w-full"
            />
            {statuses.length > 0 && (
              <div className="flex flex-wrap items-center gap-1" aria-label="Filter by status">
                {statuses.map((status) => (
                  <TermButton
                    key={status}
                    toggled={filter.statuses.includes(status)}
                    onClick={() => toggleStatus(status)}
                    title={`Show only ${status} sessions`}
                  >
                    {status}
                  </TermButton>
                ))}
              </div>
            )}
            <div className="flex flex-wrap items-center gap-1">
              <TermInput
                type="date"
                value={filter.from}
                onChange={(e) => setFilter((prev) => ({ ...prev, from: e.target.value }))}
                aria-label="Created from (UTC)"
                className="w-[136px] min-w-0"
              />
              <span className="text-term-dim">–</span>
              <TermInput
                type="date"
                value={filter.to}
                onChange={(e) => setFilter((prev) => ({ ...prev, to: e.target.value }))}
                aria-label="Created to (UTC)"
                className="w-[136px] min-w-0"
              />
              <Segmented<SessionSort>
                label="Sort sessions"
                value={filter.sort}
                onChange={(sort) => setFilter((prev) => ({ ...prev, sort }))}
                options={[
                  { value: 'newest', label: 'newest' },
                  { value: 'loss', label: 'loss' },
                ]}
              />
              {(filter.text !== '' || filter.statuses.length > 0 || filter.from !== '' || filter.to !== '') && (
                <TermButton onClick={() => setFilter(defaultSessionFilter())}>clear</TermButton>
              )}
            </div>
          </div>
          {sessions.length === 0 && <Empty>No sessions loaded. Enter the URL and token, then Refresh.</Empty>}
          {sessions.length > 0 && visible.length === 0 && <Empty>No sessions match the filter.</Empty>}
          {visible.map((s) => {
            const on = s.session_id === selected;
            return (
              <button
                key={s.session_id}
                type="button"
                onClick={() => select(s.session_id)}
                aria-current={on}
                className={cn('flex w-full items-baseline gap-[1ch] whitespace-nowrap border-b border-term-rule px-[6px] py-[3px] text-left', on ? 'bg-term-row' : 'hover:bg-term-row')}
              >
                <GutterMark cursor={on} />
                <span className={cn('min-w-0 truncate', on ? 'text-term-hi' : 'text-term-fg')}>{s.session_id}</span>
                <span className="ml-auto truncate text-term-faint">{sessionRowInfo(s)}</span>
              </button>
            );
          })}
        </nav>

        <div className="min-w-0 flex-1 overflow-auto">
          {selected ? (
            <>
              <div className="border-b border-term-rule px-[14px] pb-2 pt-[10px]">
                <div className="font-semibold text-term-hi">{selected}</div>
                <div className="mt-2 flex items-center gap-1">
                  <TermButton boxed onClick={() => open('replay')} disabled={busy} title="Fetch all series (max 2000 points each) and replay from the start">
                    Open
                  </TermButton>
                  <TermButton onClick={() => open('all')} disabled={busy} title="Fetch all series and push every sample at once for static inspection in the oscilloscope">
                    Load all
                  </TermButton>
                </div>
                <Note className="mt-1 text-term-faint">Open replays through the transport below; Oscilloscope (O) and Cluster (F) show the values as it advances.</Note>
              </div>
              <ListHead>report summary</ListHead>
              {report === null ? (
                <Empty>{busy ? 'Loading report...' : 'No report.'}</Empty>
              ) : report.length === 0 ? (
                <Empty>The report has no scalar fields to summarise.</Empty>
              ) : (
                <dl className="px-[14px] py-2">
                  {report.map((r) => (
                    <div key={r.key} className="flex gap-[2ch]">
                      <dt className="w-[28ch] shrink-0 truncate text-term-dim">{r.key}</dt>
                      <dd className="min-w-0 truncate text-term-fg">{r.value}</dd>
                    </div>
                  ))}
                </dl>
              )}
            </>
          ) : (
            <Empty>Select a session.</Empty>
          )}
        </div>
      </div>
    </div>
  );
};
