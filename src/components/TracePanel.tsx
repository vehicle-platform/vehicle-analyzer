import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { CanFrame, TraceMode } from '../types/can';
import { CaptureStore } from '../state/captureStore';
import { formatSignal } from '../services/format';
import { E2EStatus, isE2EValid } from '../services/e2e';
import { exportToVectorAsc, exportToCsv, exportToJson, downloadFile } from '../services/exportService';
import { ByteCell, FaultCell, Na, Segmented, TermButton, TermInput, Toolbar, cn } from '../ui/primitives';
import { useHotkeys } from '../ui/keys';
import { GutterMark, PanelFooter, SignalText, TraceLegend } from '../ui/trace-parts';

interface TracePanelProps {
  store: CaptureStore;
  /** True while a pause trigger is armed. */
  triggerArmed: boolean;
  /** Arms the trigger on a CAN ID (the next frame with it pauses the stream), or disarms it. */
  onArmTrigger: (id: number | null) => void;
}

type SortField = 'id' | 'name' | 'period' | 'freq' | 'count';
type ExportFormat = 'asc' | 'csv' | 'json';

/** E2E bookkeeping fields are summarised in the E2E column, not repeated as signals. */
const HIDDEN_SIGNALS = new Set(['E2E_CRC', 'E2E_COUNTER']);

/**
 * Fixed row height of the scroll log (virtualized: only visible rows are rendered).
 * Must equal the rendered row: 3px + 18px line + 3px padding + 1px rule.
 */
const ROW_PX = 25;
const OVERSCAN = 10;

/** What a failed E2E check means for the values of the frame. */
const FAULT_REASON: Partial<Record<E2EStatus, string>> = {
  WRONG_CRC: 'CRC check failed (E2E profile). Values not trusted.',
  WRONG_SEQUENCE: 'Counter jumped past the allowed gap: frames lost or out of order. Values not trusted.',
  REPEATED: 'Counter repeated: frozen or duplicated sender. Values not trusted.',
  NO_NEW_DATA: 'No valid frame within the E2E timeout. Values are stale, not trusted.',
};

/** An E2E status that makes the frame's values untrusted (INITIAL is a normal start-up state). */
const isFault = (s?: E2EStatus): boolean => s !== undefined && s !== 'INITIAL' && !isE2EValid(s);

const hexBytes = (data: number[]) => data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');

const matches = (f: CanFrame, q: string) =>
  f.idHex.toLowerCase().includes(q) ||
  (f.name?.toLowerCase().includes(q) ?? false) ||
  f.bus.toLowerCase().includes(q) ||
  Object.keys(f.decodedSignals ?? {}).some((k) => k.toLowerCase().includes(q)) ||
  f.data.map((b) => b.toString(16).padStart(2, '0')).join(' ').includes(q);

const rowKey = (f: CanFrame) => `${f.bus}:${f.id}`;

const E2EText: React.FC<{ status?: E2EStatus }> = ({ status }) => {
  if (!status) return <Na title="Not E2E protected" />;
  if (isE2EValid(status)) {
    return (
      <span className="text-term-dim" title={status === 'OK_SOME_LOST' ? 'OK_SOME_LOST: valid, some frames lost before it' : 'OK'}>
        ok
      </span>
    );
  }
  if (status === 'INITIAL') return <span className="text-term-faint">INITIAL</span>;
  return <FaultCell title={FAULT_REASON[status]}>{status}</FaultCell>;
};

const SortHead: React.FC<{
  field: SortField;
  label: string;
  right?: boolean;
  sortField: SortField;
  sortAsc: boolean;
  onSort: (field: SortField) => void;
}> = ({ field, label, right, sortField, sortAsc, onSort }) => {
  const active = sortField === field;
  return (
    <th aria-sort={active ? (sortAsc ? 'ascending' : 'descending') : 'none'} className={cn(TH, right && 'text-right')}>
      <button type="button" onClick={() => onSort(field)} className={cn('hover:text-term-fg', active && 'text-term-fg')}>
        {label}
        {active && <span className="text-term-amber"> {sortAsc ? '↓' : '↑'}</span>}
      </button>
    </th>
  );
};

export const TracePanel: React.FC<TracePanelProps> = ({ store, triggerArmed, onArmTrigger }) => {
  const [mode, setMode] = useState<TraceMode>('overwrite');
  const [filterQuery, setFilterQuery] = useState('');
  const [sortField, setSortField] = useState<SortField>('id');
  const [sortAsc, setSortAsc] = useState(true);
  const [triggerId, setTriggerId] = useState<string>('');
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [cursorKey, setCursorKey] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const frames = [...store.framesByKey.values()];
  const q = filterQuery.trim().toLowerCase();

  const armOn = (id: number) => {
    setTriggerId(`0x${id.toString(16).toUpperCase().padStart(3, '0')}`);
    onArmTrigger(id);
  };

  const toggleTrigger = () => {
    if (triggerArmed) {
      onArmTrigger(null);
      return;
    }
    const parsedId = parseInt(triggerId.trim().replace(/^0x/i, ''), 16);
    if (!isNaN(parsedId)) onArmTrigger(parsedId);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortAsc(!sortAsc);
    else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const overwriteFrames = (() => {
    const list = q ? frames.filter((f) => matches(f, q)) : frames;
    return list.sort((a, b) => {
      let c = 0;
      switch (sortField) {
        case 'id':
          c = a.bus.localeCompare(b.bus) || a.id - b.id;
          break;
        case 'name':
          c = (a.name || '').localeCompare(b.name || '');
          break;
        case 'period':
          c = a.periodMs - b.periodMs;
          break;
        case 'freq':
          c = a.frequencyHz - b.frequencyHz;
          break;
        case 'count':
          c = a.count - b.count;
          break;
      }
      return sortAsc ? c : -c;
    });
  })();

  // ---- scroll log virtualization
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [userScrollTop, setUserScrollTop] = useState(0);
  const [viewportH, setViewportH] = useState(600);
  const [follow, setFollow] = useState(true);
  const log = store.log;
  // Without a filter the ring is indexed directly; with one, the matching indices are collected.
  const filtered: number[] | null = mode === 'scroll' && q ? (() => {
    const idx: number[] = [];
    for (let i = 0; i < log.length; i++) if (matches(log.at(i), q)) idx.push(i);
    return idx;
  })() : null;
  const rowCount = filtered ? filtered.length : log.length;
  const rowAt = (r: number) => log.at(filtered ? filtered[r] : r);
  const scrollTop = follow ? Math.max(0, rowCount * ROW_PX - viewportH) : userScrollTop;
  const first = Math.max(0, Math.floor(scrollTop / ROW_PX) - OVERSCAN);
  const last = Math.min(rowCount, Math.ceil((scrollTop + viewportH) / ROW_PX) + OVERSCAN);

  useEffect(() => {
    if (mode !== 'scroll' || typeof ResizeObserver === 'undefined') return;
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportH(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, [mode]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || mode !== 'scroll' || !follow) return;
    el.scrollTop = el.scrollHeight;
  }, [mode, follow, rowCount]);

  const onScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    setUserScrollTop(el.scrollTop);
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - ROW_PX * 2;
    if (follow !== atBottom) setFollow(atBottom);
  };

  const handleExport = (format: ExportFormat) => {
    const list = log.length > 0 ? log.toArray() : frames;
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'asc') downloadFile(exportToVectorAsc(list), `can_trace_${ts}.asc`, 'text/plain');
    else if (format === 'csv') downloadFile(exportToCsv(list), `can_trace_${ts}.csv`, 'text/csv');
    else downloadFile(exportToJson(list), `can_trace_${ts}.json`, 'application/json');
    setShowExportMenu(false);
  };

  // ---- export menu: focus the first entry on open, close on an outside click
  const exportRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!showExportMenu) return;
    exportRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const onDown = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) setShowExportMenu(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [showExportMenu]);

  // ---- keyboard cursor (overwrite mode)
  const cursorIdx = cursorKey === null ? -1 : overwriteFrames.findIndex((f) => rowKey(f) === cursorKey);
  const cursorFrame = cursorIdx >= 0 ? overwriteFrames[cursorIdx] : undefined;

  const moveCursor = (delta: number) => {
    if (mode !== 'overwrite' || overwriteFrames.length === 0) return;
    const next = cursorIdx < 0 ? 0 : Math.min(overwriteFrames.length - 1, Math.max(0, cursorIdx + delta));
    setCursorKey(rowKey(overwriteFrames[next]));
  };

  useEffect(() => {
    if (cursorKey === null || mode !== 'overwrite') return;
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-row-key="${cursorKey}"]`);
    row?.scrollIntoView({ block: 'nearest' });
  }, [cursorKey, mode]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  const copyBytes = async (f: CanFrame) => {
    try {
      await navigator.clipboard.writeText(hexBytes(f.data));
      setCopied(`copied ${f.idHex}`);
    } catch {
      setCopied('copy blocked by the browser');
    }
  };

  useHotkeys({
    j: () => moveCursor(1),
    k: () => moveCursor(-1),
    ArrowDown: () => moveCursor(1),
    ArrowUp: () => moveCursor(-1),
    p: () => {
      if (cursorFrame) armOn(cursorFrame.id);
    },
    y: () => {
      if (cursorFrame) void copyBytes(cursorFrame);
    },
    m: () => setMode((m) => (m === 'overwrite' ? 'scroll' : 'overwrite')),
    v: () => setShowExportMenu((v) => !v),
  });

  const decoded = (f: CanFrame) => {
    const msg = store.pipeline.messageFor(f);
    const entries = Object.entries(f.decodedSignals ?? {}).filter(([k]) => !HIDDEN_SIGNALS.has(k));
    return entries.map(([k, v]) => {
      const sig = msg?.signals.find((s) => s.name === k);
      return { k, text: formatSignal(sig, v), unit: sig?.values ? '' : sig?.unit ?? '' };
    });
  };

  const groupByBus = sortField === 'id';

  return (
    <div className="flex h-full select-none flex-col bg-term-bg">
      <Toolbar>
        <Segmented<TraceMode>
          label="Trace mode"
          value={mode}
          onChange={setMode}
          hotkey="M"
          options={[
            { value: 'overwrite', label: 'overwrite', title: 'One row per id, updated in place' },
            { value: 'scroll', label: 'scroll log', title: 'Every frame, newest at the bottom' },
          ]}
        />
        <TermInput
          hotkey="/"
          filter
          type="text"
          aria-label="Filter frames"
          placeholder="id, name, bus or signal"
          value={filterQuery}
          onChange={(e) => setFilterQuery(e.target.value)}
        />
        <span className="inline-flex items-center gap-[6px]">
          <span className="text-term-dim">pause on id</span>
          <TermInput
            type="text"
            aria-label="Pause on id"
            placeholder="0x081"
            value={triggerId}
            onChange={(e) => setTriggerId(e.target.value)}
            className="min-w-0 w-[10ch]"
          />
          <TermButton
            boxed
            onClick={toggleTrigger}
            className={triggerArmed ? 'text-term-amber' : undefined}
            title={triggerArmed ? 'Armed: the next frame with this id pauses the source. Click to disarm.' : 'Pause the source on the next frame with this id'}
          >
            {triggerArmed ? '[armed]' : 'Arm'}
          </TermButton>
        </span>
        {copied && <span className="text-term-dim">{copied}</span>}

        <span className="ml-auto flex items-center gap-[22px]">
          {mode === 'scroll' && (
            <span className="inline-flex items-center gap-[6px]">
              <TermButton toggled={follow} onClick={() => setFollow(!follow)} title="Keep the newest frame in view">
                follow
              </TermButton>
              <span className="text-term-dim">
                <span className="text-term-fg">{rowCount.toLocaleString()}</span> / {log.capacity.toLocaleString()} frames
              </span>
            </span>
          )}
          <span className="text-term-dim">
            <span className="text-term-fg">{frames.length}</span> ids
          </span>
          <div className="relative" ref={exportRef}>
            <TermButton hotkey="V" aria-haspopup="menu" aria-expanded={showExportMenu} onClick={() => setShowExportMenu(!showExportMenu)}>
              Export
            </TermButton>
            {showExportMenu && (
              <div role="menu" aria-label="Export format" className="absolute right-0 top-full z-30 mt-[2px] flex min-w-[24ch] flex-col border border-term-ruleHi bg-term-raise py-1">
                {(
                  [
                    ['asc', 'Vector ASC'],
                    ['csv', 'CSV'],
                    ['json', 'JSON'],
                  ] as const
                ).map(([fmt, label]) => (
                  <button
                    key={fmt}
                    role="menuitem"
                    type="button"
                    onClick={() => handleExport(fmt)}
                    className="flex justify-between gap-4 px-[10px] text-left leading-[22px] text-term-fg hover:bg-term-row focus-visible:bg-term-row"
                  >
                    <span className="text-term-hi">{fmt}</span>
                    <span className="text-term-dim">{label}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </span>
      </Toolbar>

      <div className="min-h-0 flex-1 overflow-auto" ref={scrollRef} onScroll={mode === 'scroll' ? onScroll : undefined}>
        {mode === 'overwrite' ? (
          <table className="w-full table-fixed border-separate border-spacing-0 text-left">
            <colgroup>
              <col style={{ width: 20 }} />
              <col style={{ width: '10ch' }} />
              <col style={{ width: '13ch' }} />
              <col style={{ width: '24ch' }} />
              <col style={{ width: '6ch' }} />
              <col style={{ width: '9ch' }} />
              <col style={{ width: '8ch' }} />
              <col style={{ width: '9ch' }} />
              <col style={{ width: '17ch' }} />
              <col style={{ width: '31ch' }} />
              <col />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-term-bg">
              <tr>
                <th className={TH} aria-label="Marker" />
                <th className={TH}>bus</th>
                <SortHead field="id" label="id" sortField={sortField} sortAsc={sortAsc} onSort={handleSort} />
                <SortHead field="name" label="name" sortField={sortField} sortAsc={sortAsc} onSort={handleSort} />
                <th className={cn(TH, 'text-right')}>dlc</th>
                <SortHead field="period" label="period" right sortField={sortField} sortAsc={sortAsc} onSort={handleSort} />
                <SortHead field="freq" label="Hz" right sortField={sortField} sortAsc={sortAsc} onSort={handleSort} />
                <SortHead field="count" label="count" right sortField={sortField} sortAsc={sortAsc} onSort={handleSort} />
                <th className={TH}>e2e</th>
                <th className={TH}>data</th>
                <th className={TH}>decoded</th>
              </tr>
            </thead>
            <tbody>
              {overwriteFrames.length === 0 ? (
                <tr>
                  <td colSpan={11} className="px-[14px] py-6 italic text-term-dim">
                    {q ? 'No frame matches the filter.' : 'No frames yet.'}
                  </td>
                </tr>
              ) : (
                overwriteFrames.map((frame, i) => {
                  const key = rowKey(frame);
                  const cur = key === cursorKey;
                  const fault = isFault(frame.e2e);
                  const showBus = !groupByBus || i === 0 || overwriteFrames[i - 1].bus !== frame.bus;
                  const sigs = decoded(frame);
                  return (
                    <tr
                      key={key}
                      data-row-key={key}
                      onClick={() => setCursorKey(key)}
                      className={cn('align-top', cur ? 'bg-term-row' : 'hover:bg-term-raise')}
                    >
                      <td className={cn(TD, 'pl-[6px] pr-0')}>
                        <GutterMark cursor={cur} fault={fault} />
                      </td>
                      <td className={cn(TD, 'text-term-dim')}>{showBus ? frame.bus : ''}</td>
                      <td className={cn(TD, fault ? 'text-term-red' : 'text-term-hi')}>{frame.idHex}</td>
                      <td className={cn(TD, 'overflow-hidden text-ellipsis', fault ? 'text-term-red' : frame.bus === 'vehicle' ? 'text-term-dim' : 'text-term-fg')} title={frame.name}>
                        {frame.name || <Na />}
                      </td>
                      <td className={cn(TD, 'text-right')}>{frame.dlc}</td>
                      <td className={cn(TD, 'text-right')}>{frame.periodMs > 0 ? frame.periodMs.toFixed(1) : <Na />}</td>
                      <td className={cn(TD, 'text-right')}>{frame.frequencyHz > 0 ? frame.frequencyHz.toFixed(1) : <Na />}</td>
                      <td className={cn(TD, 'text-right')}>{frame.count.toLocaleString()}</td>
                      <td className={TD}>
                        <E2EText status={frame.e2e} />
                      </td>
                      <td className={TD}>
                        {frame.data.map((byte, idx) => (
                          <ByteCell key={idx} value={byte} changed={frame.changedBytes?.[idx]} />
                        ))}
                      </td>
                      <td className={cn(TD, 'whitespace-normal')}>
                        {sigs.length === 0 ? (
                          <Na />
                        ) : (
                          sigs.map(({ k, text, unit }) => <SignalText key={k} name={k} value={text} unit={unit} untrusted={fault} />)
                        )}
                        {fault && frame.e2e && <span className="block italic text-term-red">{FAULT_REASON[frame.e2e]}</span>}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        ) : (
          <table className="w-full table-fixed border-separate border-spacing-0 text-left">
            <colgroup>
              <col style={{ width: 20 }} />
              <col style={{ width: '12ch' }} />
              <col style={{ width: '9ch' }} />
              <col style={{ width: '10ch' }} />
              <col style={{ width: '13ch' }} />
              <col style={{ width: '24ch' }} />
              <col style={{ width: '6ch' }} />
              <col style={{ width: '31ch' }} />
              <col />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-term-bg">
              <tr>
                <th className={TH} aria-label="Marker" />
                <th className={cn(TH, 'text-right')}>time s</th>
                <th className={cn(TH, 'text-right')}>Δt ms</th>
                <th className={TH}>bus</th>
                <th className={TH}>id</th>
                <th className={TH}>name</th>
                <th className={cn(TH, 'text-right')}>dlc</th>
                <th className={TH}>data</th>
                <th className={TH}>decoded</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ height: first * ROW_PX }} />
              {Array.from({ length: Math.max(0, last - first) }, (_, k) => first + k).map((r) => {
                const frame = rowAt(r);
                const fault = isFault(frame.e2e);
                const sigs = decoded(frame);
                return (
                  <tr key={r} style={{ height: ROW_PX }} className="hover:bg-term-raise">
                    <td className={cn(TD, 'pl-[6px] pr-0')}>
                      <GutterMark fault={fault} />
                    </td>
                    <td className={cn(TD, 'text-right text-term-dim')}>{frame.timestamp.toFixed(4)}</td>
                    <td className={cn(TD, 'text-right text-term-faint')}>{frame.deltaMs.toFixed(2)}</td>
                    <td className={cn(TD, 'text-term-dim')}>{frame.bus}</td>
                    <td className={cn(TD, fault ? 'text-term-red' : 'text-term-hi')}>{frame.idHex}</td>
                    <td className={cn(TD, 'overflow-hidden text-ellipsis', fault ? 'text-term-red' : frame.bus === 'vehicle' ? 'text-term-dim' : 'text-term-fg')}>
                      {frame.name || <Na />}
                    </td>
                    <td className={cn(TD, 'text-right')}>{frame.dlc}</td>
                    <td className={TD}>{hexBytes(frame.data)}</td>
                    <td className={cn(TD, 'overflow-hidden text-ellipsis')} title={fault && frame.e2e ? FAULT_REASON[frame.e2e] : undefined}>
                      {fault && frame.e2e && <span className="mr-[14px] text-term-red">{frame.e2e}</span>}
                      {sigs.length === 0 ? <Na /> : sigs.map(({ k, text, unit }) => <SignalText key={k} name={k} value={text} unit={unit} untrusted={fault} />)}
                    </td>
                  </tr>
                );
              })}
              <tr style={{ height: Math.max(0, rowCount - last) * ROW_PX }} />
            </tbody>
          </table>
        )}
      </div>

      <PanelFooter
        keys={
          mode === 'overwrite'
            ? [
                { k: 'j/k', label: 'Move' },
                { k: 'p', label: 'Pause on this id' },
                { k: 'y', label: 'Copy bytes' },
                { k: 'M', label: 'Scroll log' },
                { k: 'V', label: 'Export' },
              ]
            : [
                { k: 'M', label: 'Overwrite' },
                { k: 'V', label: 'Export' },
              ]
        }
        legend={<TraceLegend />}
      />
    </div>
  );
};

/** Column head: lowercase, dim, 24px, rule-hi underline. */
const TH = 'h-6 whitespace-nowrap border-b border-term-ruleHi px-2 font-normal text-term-dim';
/** Dense cell: 3px 8px, 1px rule underneath. */
const TD = 'whitespace-nowrap border-b border-term-rule px-2 py-[3px]';
