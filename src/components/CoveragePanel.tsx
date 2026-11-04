import React, { useEffect, useMemo, useState } from 'react';
import { DEFS } from '../defs';
import type { DerivedClass } from '../defs/model';
import { Note, Na, TermButton, TermInput, Toolbar, cn } from '../ui/primitives';
import { Empty, TD, TH } from '../ui/panel-parts';
import { useHotkeys } from '../ui/keys';
import { SessionClient } from '../services/sessionClient';
import { downloadFile } from '../services/exportService';
import {
  applySession,
  buildCoverage,
  coverageToCsv,
  defsStatusText,
  sessionText,
  summarize,
  waitingCategory,
  waitingFor,
  type CoverageGroup,
  type CoverageRow,
} from '../services/coverage';

interface CoveragePanelProps {
  /** Shared with the WS live token (same sessionStorage key, owned by App). */
  token: string;
  onTokenChange: (token: string) => void;
  serverUrl: string;
  onServerUrlChange: (url: string) => void;
  /** Session selected in Recorded sessions (E), if any. */
  selectedSessionId?: string | null;
}

const GROUPS: readonly CoverageGroup[] = ['polled_did', 'catalog_candidate', 'identification', 'sensor', 'derived'];
const CLASSES: readonly DerivedClass[] = ['A', 'B', 'C', 'D'];
const GROUP_LABELS: Record<CoverageGroup, string> = {
  polled_did: 'polled DIDs',
  catalog_candidate: 'OBD candidates',
  identification: 'identification',
  sensor: 'sensors',
  derived: 'derived signals',
};

type SortKey = 'group' | 'name' | 'id' | 'class' | 'unit' | 'defs' | 'waiting' | 'session';
type SortDir = 1 | -1;
interface Sort {
  key: SortKey;
  dir: SortDir;
}

const COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'group', label: 'group' },
  { key: 'name', label: 'name' },
  { key: 'id', label: 'id' },
  { key: 'class', label: 'class' },
  { key: 'unit', label: 'unit' },
  { key: 'defs', label: 'defs status' },
  { key: 'waiting', label: 'waiting for' },
  { key: 'session', label: 'session' },
];

const countBy = (values: string[]): [string, number][] => {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
};

const sortValue = (row: CoverageRow, key: SortKey): string => {
  switch (key) {
    case 'group':
      return String(GROUPS.indexOf(row.group));
    case 'name':
      return row.name;
    case 'id':
      return row.id;
    case 'class':
      return row.class ?? 'Z';
    case 'unit':
      return row.unit;
    case 'defs':
      return defsStatusText(row);
    case 'waiting':
      return waitingFor(row).join('; ');
    case 'session':
      return row.session?.status ?? '';
  }
};

const compareRows = (a: CoverageRow, b: CoverageRow, sort: Sort): number => {
  const left = sortValue(a, sort.key);
  const right = sortValue(b, sort.key);
  const primary = left.localeCompare(right, undefined, { numeric: true, sensitivity: 'base' });
  if (primary !== 0) return primary * sort.dir;
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) * sort.dir;
};

const chipSplit = (rows: CoverageRow[], group: CoverageGroup, loaded: boolean): string => {
  const own = rows.filter((row) => row.group === group);
  if (group === 'polled_did') {
    const verified = own.filter((row) => row.defsStatus.kind === 'polled_did' && row.defsStatus.verified).length;
    return `${verified} verified / ${own.length - verified} not verified`;
  }
  if (group === 'catalog_candidate' || group === 'identification') return 'catalog only';
  if (group === 'sensor') {
    const phase0 = own.filter((row) => row.defsStatus.kind === 'sensor' && row.defsStatus.phase0 !== null).length;
    return `${phase0} Phase 0 / ${own.length - phase0} none`;
  }
  const classes = countBy(own.flatMap((row) => (row.class === undefined ? [] : [row.class])))
    .map(([letter, count]) => `${letter} ${count}`)
    .join(' · ');
  const statuses = loaded ? countBy(own.flatMap((row) => (row.session === null ? [] : [row.session.status]))).map(([status, count]) => `${status} ${count}`).join(' · ') : '';
  return statuses === '' ? classes : `${classes} · session: ${statuses}`;
};

const sessionTone = (status: string): string =>
  status === 'error' ? 'text-term-red' : ['computed', 'ok', 'valid', 'present'].includes(status) ? 'text-term-fg' : 'text-term-dim';

/** Signal coverage over the bundled defs (D-081, invariant 2): raw defs facts, no readiness rule. */
export const CoveragePanel: React.FC<CoveragePanelProps> = ({ token, onTokenChange, serverUrl, onServerUrlChange, selectedSessionId }) => {
  const rows = useMemo(() => buildCoverage(DEFS), []);
  const [sessionId, setSessionId] = useState('');
  const [report, setReport] = useState<unknown | null>(null);
  const [reportFor, setReportFor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [groups, setGroups] = useState<CoverageGroup[]>([]);
  const [classes, setClasses] = useState<DerivedClass[]>([]);
  const [waiting, setWaiting] = useState('all');
  const [sessionStatus, setSessionStatus] = useState('all');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>({ key: 'group', dir: 1 });

  useEffect(() => {
    setReport(null);
    setReportFor(null);
    setStatus('');
    setError(null);
  }, [selectedSessionId]);

  const selected = selectedSessionId?.trim() ?? '';
  const chosenSession = selected !== '' ? selected : sessionId.trim() === '' ? null : sessionId.trim();
  const client = useMemo(() => new SessionClient(serverUrl, token), [serverUrl, token]);
  const covered = useMemo(() => (report === null ? rows : applySession(rows, report)), [rows, report]);
  const summary = useMemo(() => summarize(covered), [covered]);
  const waitingCategories = useMemo(() => [...new Set(rows.map((row) => waitingCategory(row)))].sort((a, b) => a.localeCompare(b)), [rows]);
  const sessionStatuses = useMemo(
    () => [...new Set(covered.flatMap((row) => (row.session === null ? [] : [row.session.status])))].sort((a, b) => a.localeCompare(b)),
    [covered]
  );

  const load = async () => {
    if (chosenSession === null) {
      setError('Enter a session id or select one in Recorded sessions (E).');
      return;
    }
    if (serverUrl.trim() === '') {
      setError('No vehicle-server URL configured.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await client.getReport(chosenSession);
      setReport(next);
      setReportFor(chosenSession);
      setStatus(`Report loaded for ${chosenSession}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };
  useHotkeys({ r: () => void load() });

  const visible = useMemo(() => {
    const text = query.trim().toLowerCase();
    return covered
      .filter((row) => (groups.length === 0 ? true : groups.includes(row.group)))
      .filter((row) => (classes.length === 0 ? true : row.class !== undefined && classes.includes(row.class)))
      .filter((row) => (waiting === 'all' ? true : waitingCategory(row) === waiting))
      .filter((row) => (sessionStatus === 'all' ? true : row.session?.status === sessionStatus))
      .filter((row) => (text === '' ? true : `${row.name} ${row.description}`.toLowerCase().includes(text)))
      .sort((a, b) => compareRows(a, b, sort));
  }, [covered, groups, classes, waiting, sessionStatus, query, sort]);

  const toggleGroup = (group: CoverageGroup) =>
    setGroups((previous) => (previous.includes(group) ? previous.filter((value) => value !== group) : [...previous, group]));
  const toggleClass = (letter: DerivedClass) =>
    setClasses((previous) => (previous.includes(letter) ? previous.filter((value) => value !== letter) : [...previous, letter]));
  const clearFilters = () => {
    setGroups([]);
    setClasses([]);
    setWaiting('all');
    setSessionStatus('all');
    setQuery('');
  };

  const changeSort = (key: SortKey) =>
    setSort((previous) => (previous.key === key ? { key, dir: previous.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const exportCsv = () => {
    const session = reportFor === null ? '' : `-${reportFor.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
    downloadFile(coverageToCsv(visible), `coverage-${DEFS.ref}${session}.csv`, 'text/csv;charset=utf-8');
  };

  const selectedLabel = chosenSession ?? 'no session selected';

  return (
    <div className="flex h-full select-none flex-col overflow-hidden bg-term-bg">
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
        {selected !== '' ? null : (
          <TermInput
            value={sessionId}
            onChange={(e) => setSessionId(e.target.value)}
            placeholder="session id"
            aria-label="Session id"
            spellCheck={false}
            className="w-56"
          />
        )}
        <TermButton hotkey="R" boxed onClick={() => void load()} disabled={busy} title="Load GET /sessions/{id}/report for the selected session">
          Load session
        </TermButton>
        <TermButton onClick={exportCsv} disabled={visible.length === 0} title="Export the visible rows as CSV">
          Export CSV
        </TermButton>
        <span className="ml-auto text-term-dim">{busy ? 'working...' : 'read-only HTTP, token in the Authorization header only'}</span>
      </Toolbar>

      {error && (
        <div role="alert" className="shrink-0 border-b border-term-rule bg-term-redBg px-[14px] leading-[24px] text-term-red">
          ■ {error}
        </div>
      )}
      {status && !error && <div className="shrink-0 border-b border-term-rule px-[14px] leading-[24px] text-term-fg">{status}</div>}

      <div className="shrink-0 border-b border-term-rule px-[14px] py-[6px]">
        <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
          <span className="text-term-dim">
            defs <span className="text-term-fg">{DEFS.ref}</span>
          </span>
          <span className="text-term-dim">
            session <span className={chosenSession === null ? 'text-term-faint' : 'text-term-fg'}>{selectedLabel}</span>
          </span>
          <span className="ml-auto text-term-dim">{rows.length} values from the bundled defs</span>
        </div>
        <div role="group" aria-label="Coverage groups" className="mt-[6px] flex flex-wrap items-center gap-1">
          {GROUPS.map((group) => (
            <TermButton
              key={group}
              toggled={groups.includes(group)}
              onClick={() => toggleGroup(group)}
              aria-label={`Filter ${GROUP_LABELS[group]}`}
              title={`Show or hide ${GROUP_LABELS[group]}`}
            >
              {GROUP_LABELS[group]} <span className="text-term-hi">{summary.groups[group]}</span>{' '}
              <span className="text-term-faint">{chipSplit(covered, group, reportFor !== null)}</span>
            </TermButton>
          ))}
        </div>
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-term-rule px-[14px] py-[6px]">
        <TermInput
          filter
          hotkey="/"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="name or description"
          aria-label="Search signal coverage by name or description"
          spellCheck={false}
          className="w-64 min-w-0"
        />
        <span className="text-term-dim">class</span>
        <span role="group" aria-label="Filter by derived class" className="flex gap-1">
          {CLASSES.map((letter) => (
            <TermButton
              key={letter}
              toggled={classes.includes(letter)}
              onClick={() => toggleClass(letter)}
              aria-label={`Filter class ${letter}`}
              title={`Show only class ${letter} derived signals`}
            >
              {letter}
            </TermButton>
          ))}
        </span>
        <label className="flex items-center gap-[6px] text-term-dim">
          waiting
          <select className="term-select" aria-label="Waiting for category" value={waiting} onChange={(e) => setWaiting(e.target.value)}>
            <option value="all">all</option>
            {waitingCategories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </label>
        {sessionStatuses.length > 0 && (
          <label className="flex items-center gap-[6px] text-term-dim">
            session
            <select className="term-select" aria-label="Session status" value={sessionStatus} onChange={(e) => setSessionStatus(e.target.value)}>
              <option value="all">all</option>
              {sessionStatuses.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        )}
        <TermButton onClick={clearFilters} disabled={groups.length === 0 && classes.length === 0 && waiting === 'all' && sessionStatus === 'all' && query === ''}>
          clear
        </TermButton>
        <span className="ml-auto text-term-dim">
          {visible.length}/{rows.length} rows
        </span>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        <table aria-label="Signal coverage" className="w-full min-w-[1100px] table-fixed border-collapse">
          <colgroup>
            <col className="w-[10%]" />
            <col className="w-[20%]" />
            <col className="w-[7%]" />
            <col className="w-[5%]" />
            <col className="w-[7%]" />
            <col className="w-[19%]" />
            <col className="w-[18%]" />
            <col className="w-[14%]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-term-bg">
            <tr>
              {COLUMNS.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={TH}
                  aria-sort={sort.key === column.key ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}
                >
                  <button type="button" className="flex w-full items-center gap-1 text-left" onClick={() => changeSort(column.key)} title={`Sort by ${column.label}`}>
                    <span>{column.label}</span>
                    {sort.key === column.key && <span className="text-term-amber">{sort.dir === 1 ? '^' : 'v'}</span>}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={`${row.group}:${row.id}:${row.name}`} className="hover:bg-term-row">
                <td className={cn(TD, 'whitespace-normal break-words text-term-dim')}>{GROUP_LABELS[row.group]}</td>
                <td className={cn(TD, 'whitespace-normal break-words')}>
                  <div className="text-term-hi">{row.name}</div>
                  <div className="text-term-faint">{row.description}</div>
                </td>
                <td className={cn(TD, 'text-term-fg')}>{row.id === '' ? <Na /> : row.id}</td>
                <td className={cn(TD, 'text-term-fg')}>{row.class === undefined ? <Na /> : row.class}</td>
                <td className={cn(TD, 'text-term-fg')}>{row.unit === '' ? <Na /> : row.unit}</td>
                <td className={cn(TD, 'whitespace-normal break-words text-term-fg')}>{defsStatusText(row)}</td>
                <td className={cn(TD, 'whitespace-normal break-words text-term-dim')}>{waitingFor(row).length === 0 ? <Na /> : waitingFor(row).join('; ')}</td>
                <td className={cn(TD, 'whitespace-normal break-words')}>
                  {row.session === null ? (
                    <Na title="Load a session report to fill this column." />
                  ) : (
                    <span className={sessionTone(row.session.status)}>{sessionText(row)}</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {visible.length === 0 && <Empty>No values match the filters.</Empty>}
      </div>

      <Note className="shrink-0 px-[14px] pb-2">
        Rows come from the bundled defs; the session column reads GET /sessions/{'{id}'}/report only. "Waiting for" quotes defs keys and fixed labels, not a
        computed readiness verdict (D-085). GPS rows show presence only, never a position (D-076).
      </Note>
    </div>
  );
};
