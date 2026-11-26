import React, { useRef, useEffect, useState, useMemo } from 'react';
import { CaptureStore } from '../state/captureStore';
import { SeriesLike, lastValue, lowerBound, sampleAt, seriesOf } from '../state/ring';
import { availableChannels, ChannelInfo } from '../state/channels';
import { didKey, signalKey } from '../services/pipeline';
import {
  MathChannelDef,
  MathOp,
  MATH_OP_LABEL,
  computeMathChannel,
  exportOscilloscopeCsv,
  captureBrandedSnapshot,
  CsvExportChannel,
} from '../services/mathChannels';
import { formatValue } from '../services/format';
import { Segmented, TermButton, TermInput, Toolbar, cn } from '../ui/primitives';
import { useHotkeys } from '../ui/keys';
import { themeColor, useActiveTheme } from '../ui/theme';
import { TD, TH, documentTheme, scopePalette, traceSwatch } from '../ui/panel-parts';

interface OscilloscopePanelProps {
  store: CaptureStore;
}

const DEFAULT_KEYS = [signalKey('VehicleEngine', 'ENGINE_SPEED'), signalKey('VehicleSpeed', 'VEHICLE_SPEED'), signalKey('EkfLean', 'LEAN_ANGLE')];

interface Trace {
  key: string;
  label: string;
  unit: string;
  /** Palette slot; the colour is resolved per theme when drawing. */
  slot: number;
  series: SeriesLike;
  dashed: boolean;
}

const EMPTY = seriesOf([]);
/** New data is drawn at most at 30 fps; settings and resizes are drawn at once. */
const SCOPE_FRAME_MS = 33;

/**
 * Draws one trace between t0 and t1, auto-scaled to its visible range. When there are
 * more samples than pixel columns, each column draws the min-max span of its samples
 * (peak-preserving decimation), so cost follows the canvas width, not the data rate.
 */
function drawTrace(ctx: CanvasRenderingContext2D, tr: Trace, color: string, t0: number, span: number, width: number, height: number, pad: number, dpr: number) {
  const s = tr.series;
  const i0 = Math.max(0, lowerBound(s, t0) - 1);
  const i1 = s.length;
  if (i1 - i0 < 2) return;

  let lo = Infinity;
  let hi = -Infinity;
  for (let i = i0; i < i1; i++) {
    const v = s.valueAt(i);
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  if (!Number.isFinite(lo)) return;
  if (hi - lo < 1e-9) {
    hi += 1;
    lo -= 1;
  }
  const xOf = (t: number) => ((t - t0) / span) * width;
  const yOf = (v: number) => height - pad - ((v - lo) / (hi - lo)) * (height - 2 * pad);

  ctx.setLineDash(tr.dashed ? [6 * dpr, 3 * dpr] : []);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.4 * dpr;
  ctx.beginPath();

  const columns = Math.max(1, Math.floor(width));
  if (i1 - i0 <= columns * 2) {
    for (let i = i0; i < i1; i++) {
      const x = xOf(s.timeAt(i));
      const y = yOf(s.valueAt(i));
      if (i === i0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
  } else {
    let col = -1;
    let cMin = 0;
    let cMax = 0;
    let first = true;
    const flush = () => {
      if (col < 0) return;
      if (first) {
        ctx.moveTo(col, yOf(cMin));
        first = false;
      } else ctx.lineTo(col, yOf(cMin));
      ctx.lineTo(col, yOf(cMax));
    };
    for (let i = i0; i < i1; i++) {
      const c = Math.floor(xOf(s.timeAt(i)));
      const v = s.valueAt(i);
      if (c !== col) {
        flush();
        col = c;
        cMin = v;
        cMax = v;
      } else {
        if (v < cMin) cMin = v;
        if (v > cMax) cMax = v;
      }
    }
    flush();
  }
  ctx.stroke();
  ctx.setLineDash([]);
}

const WINDOWS = [5, 10, 30, 60] as const;

/** `VehicleEngine.ENGINE_SPEED` -> prefix faint, signal name in fg (DBC names are data). */
const ChannelLabel: React.FC<{ label: string }> = ({ label }) => {
  const dot = label.lastIndexOf('.');
  const space = label.indexOf(' ');
  const cut = dot >= 0 ? dot + 1 : space >= 0 ? space + 1 : 0;
  return (
    <span title={label}>
      {cut > 0 && <span className="text-term-faint">{label.slice(0, cut)}</span>}
      <span className="text-term-fg">{label.slice(cut)}</span>
    </span>
  );
};

export const OscilloscopePanel: React.FC<OscilloscopePanelProps> = ({ store }) => {
  const theme = useActiveTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [timeWindowSec, setTimeWindowSec] = useState<number>(10);
  const [cursorA, setCursorA] = useState<number | null>(null);
  const [cursorB, setCursorB] = useState<number | null>(null);
  const [nextCursor, setNextCursor] = useState<'A' | 'B'>('A');
  const [enabled, setEnabled] = useState<string[]>(DEFAULT_KEYS);
  const [picker, setPicker] = useState<string>('');
  const [mathChannels, setMathChannels] = useState<MathChannelDef[]>([]);
  const [showMath, setShowMath] = useState(false);
  const [draft, setDraft] = useState<{ op: MathOp; a: string; b: string; scale: string; unit: string }>({
    op: 'derivative',
    a: signalKey('EkfLean', 'LEAN_ANGLE'),
    b: didKey('VEHICLE_SPEED'),
    scale: '1',
    unit: 'deg/s',
  });

  const channels = availableChannels(store);
  const channelByKey = useMemo(() => new Map(channels.map((c) => [c.key, c])), [channels]);

  /** Traces to draw; math channels are computed only over the visible window (+1 s). */
  const buildTraces = (fromTime: number): Trace[] => {
    const plain: Trace[] = enabled.map((key, i) => {
      const info = channelByKey.get(key);
      return { key, label: info?.label ?? key, unit: info?.unit ?? '', slot: i, series: store.history.get(key) ?? EMPTY, dashed: false };
    });
    const math: Trace[] = mathChannels
      .filter((m) => m.enabled)
      .map((m, i) => ({
        key: m.id,
        label: `[math] ${m.label}`,
        unit: m.unit,
        slot: plain.length + i,
        series: seriesOf(computeMathChannel(m, store.history, fromTime)),
        dashed: true,
      }));
    return [...plain, ...math];
  };

  const latestOf = (trs: Trace[]) => {
    let latest = 0;
    trs.forEach((t) => {
      if (t.series.length > 0) latest = Math.max(latest, t.series.timeAt(t.series.length - 1));
    });
    return latest === 0 ? store.lastTime : latest;
  };

  const traces = buildTraces(store.lastTime - timeWindowSec - 1);
  const latestTime = latestOf(traces);
  const startTime = Math.max(0, latestTime - timeWindowSec);
  const cursorTime = (frac: number) => startTime + frac * timeWindowSec;

  // The canvas draws on its own animation frames, only when data, settings, size or theme changed.
  const drawConfig = useRef({ buildTraces, timeWindowSec, cursorA, cursorB, latestOf });
  useEffect(() => {
    drawConfig.current = { buildTraces, timeWindowSec, cursorA, cursorB, latestOf };
  });
  const settingsVersion = useRef(0);
  useEffect(() => {
    settingsVersion.current++;
  }, [enabled, mathChannels, timeWindowSec, cursorA, cursorB, theme]);

  useEffect(() => {
    let raf = 0;
    let drawnData = -1;
    let drawnSettings = -1;
    let drawnW = 0;
    let drawnH = 0;
    let lastDraw = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const settingsChanged = settingsVersion.current !== drawnSettings || rect.width !== drawnW || rect.height !== drawnH;
      if (!settingsChanged && (store.dataVersion === drawnData || now - lastDraw < SCOPE_FRAME_MS)) return;
      lastDraw = now;
      drawnData = store.dataVersion;
      drawnSettings = settingsVersion.current;
      drawnW = rect.width;
      drawnH = rect.height;
      draw(canvas, rect);
    };
    const draw = (canvas: HTMLCanvasElement, rect: DOMRect) => {
    const { buildTraces: build, timeWindowSec: span, cursorA: cA, cursorB: cB, latestOf: latestFn } = drawConfig.current;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(rect.width * dpr));
    const height = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Colours are read from the theme tokens on every draw, so a theme switch shows at once.
    const palette = scopePalette(documentTheme());
    ctx.fillStyle = themeColor('bg');
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = themeColor('rule');
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = Math.round((height / 5) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(width, y);
      ctx.stroke();
    }
    for (let i = 1; i < 10; i++) {
      const x = Math.round((width / 10) * i) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
    }

    const pad = 14 * dpr;
    const trs = build(store.lastTime - span - 1);
    const t1 = latestFn(trs);
    const t0 = Math.max(0, t1 - span);
    trs.forEach((tr) => drawTrace(ctx, tr, palette[tr.slot % palette.length], t0, span, width, height, pad, dpr));

    const drawCursor = (frac: number, color: string, dashed: boolean, label: string) => {
      const x = Math.round(frac * width) + 0.5;
      ctx.strokeStyle = color;
      ctx.setLineDash(dashed ? [4 * dpr, 4 * dpr] : []);
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, height);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.font = `${11 * dpr}px Iosevka, "DejaVu Sans Mono", monospace`;
      ctx.fillText(label, x + 4 * dpr, height - 6 * dpr);
    };
    if (cA !== null) drawCursor(cA, themeColor('amber'), false, 'A');
    if (cB !== null) drawCursor(cB, themeColor('hi'), true, 'B');
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [store]);

  const handleCanvasClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    if (nextCursor === 'A') {
      setCursorA(frac);
      setNextCursor('B');
    } else {
      setCursorB(frac);
      setNextCursor('A');
    }
  };

  const clearCursors = () => {
    setCursorA(null);
    setCursorB(null);
    setNextCursor('A');
  };

  const handleExportCsv = () => {
    const all = buildTraces(-Infinity);
    const data: CsvExportChannel[] = all.map((t) => {
      const pts: { time: number; value: number }[] = [];
      for (let i = 0; i < t.series.length; i++) pts.push({ time: t.series.timeAt(i), value: t.series.valueAt(i) });
      return { name: t.key, label: t.label, unit: t.unit, data: pts };
    });
    if (data.length === 0) return;
    const blob = new Blob([exportOscilloscopeCsv(data)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `vehicle-analyzer-scope-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleSnapshotPng = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const url = captureBrandedSnapshot(canvas, {
      activeChannelsCount: traces.length,
      timeWindowSec,
      platformName: 'Honda CL250',
      footer: `defs ${store.defs.ref} · ${traces.map((t) => t.label).join(', ')}`,
    }, {
      band: themeColor('raise', 0.92),
      rule: themeColor('amber'),
      title: themeColor('hi'),
      text: themeColor('dim'),
      faint: themeColor('dim'),
      font: 'Iosevka, "DejaVu Sans Mono", monospace',
    });
    const a = document.createElement('a');
    a.href = url;
    a.download = `vehicle-analyzer-scope-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.click();
  };

  const addPicked = () => {
    const key = picker || channels[0]?.key;
    if (key && !enabled.includes(key)) setEnabled((prev) => [...prev, key]);
  };

  const addMath = () => {
    const scale = Number(draft.scale);
    if (!Number.isFinite(scale) || !draft.a) return;
    const id = `math_${Date.now()}`;
    const la = channelByKey.get(draft.a)?.label ?? draft.a;
    const lb = channelByKey.get(draft.b)?.label ?? draft.b;
    const label = MATH_OP_LABEL[draft.op].replace('A', la).replace('B', lb) + (scale !== 1 ? ` ×${scale}` : '');
    setMathChannels((prev) => [
      ...prev,
      // The colour comes from the theme palette by slot when drawn; the field stays empty.
      { id, label, op: draft.op, a: draft.a, b: draft.op === 'derivative' ? undefined : draft.b, scale, unit: draft.unit, color: '', enabled: true },
    ]);
  };

  // Panel keys; App owns t s o u h d space c x l / ? (GLOBAL_KEYS).
  useHotkeys({
    w: () => setTimeWindowSec((w) => WINDOWS[(WINDOWS.indexOf(w as (typeof WINDOWS)[number]) + 1) % WINDOWS.length]),
    r: clearCursors,
    a: addPicked,
    m: () => setShowMath((v) => !v),
    v: handleExportCsv,
    p: handleSnapshotPng,
  });

  const groups = useMemo(() => {
    const g = new Map<string, ChannelInfo[]>();
    channels.forEach((c) => g.set(c.group, [...(g.get(c.group) ?? []), c]));
    return [...g.entries()];
  }, [channels]);

  const ChannelSelect: React.FC<{ value: string; onChange: (v: string) => void; label: string }> = ({ value, onChange, label }) => (
    <select aria-label={label} value={value} onChange={(e) => onChange(e.target.value)} className="term-select max-w-[280px]">
      {groups.map(([g, list]) => (
        <optgroup key={g} label={g}>
          {list.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  const Swatch: React.FC<{ slot: number; dashed?: boolean }> = ({ slot, dashed }) => {
    const sw = traceSwatch(theme, slot);
    return (
      <span aria-hidden="true" className={sw.className} style={sw.style}>
        {dashed ? '┄' : '●'}
      </span>
    );
  };

  const showReadout = cursorA !== null || cursorB !== null;

  return (
    <div className="flex h-full select-none flex-col bg-term-bg">
      <Toolbar>
        <Segmented
          label="Time window"
          hotkey="W"
          options={WINDOWS.map((w) => ({ value: w, label: `${w}s` }))}
          value={timeWindowSec}
          onChange={setTimeWindowSec}
        />
        <span className="inline-flex items-center gap-1">
          <TermButton hotkey="R" onClick={clearCursors} disabled={!showReadout} title="Remove both cursors">
            cursors off
          </TermButton>
          <TermButton hotkey="M" toggled={showMath} onClick={() => setShowMath((v) => !v)} title="Host-side math channel">
            math
          </TermButton>
          <TermButton hotkey="V" onClick={handleExportCsv} title="Export all plotted channels as CSV">
            CSV
          </TermButton>
          <TermButton hotkey="P" onClick={handleSnapshotPng} title="Save the plot as PNG">
            PNG
          </TermButton>
        </span>
        <span className="ml-auto text-term-dim">
          {startTime.toFixed(2)} – {latestTime.toFixed(2)} s
        </span>
      </Toolbar>

      <div className="flex shrink-0 flex-wrap items-center gap-x-[22px] gap-y-1 border-b border-term-rule px-[14px] py-[6px]">
        {traces.length === 0 && <span className="text-term-faint">no channel plotted</span>}
        {traces.map((t) => {
          const last = lastValue(t.series);
          const isMath = t.key.startsWith('math_');
          return (
            <span key={t.key} className="inline-flex items-center gap-[1ch] whitespace-nowrap">
              <Swatch slot={t.slot} dashed={t.dashed} />
              <ChannelLabel label={t.label} />
              <span className="text-term-hi">{last === undefined ? <span className="text-term-faint">–</span> : formatValue(last)}</span>
              {t.unit && <span className="text-term-faint">{t.unit}</span>}
              <button
                type="button"
                onClick={() =>
                  isMath ? setMathChannels((prev) => prev.filter((m) => m.id !== t.key)) : setEnabled((prev) => prev.filter((k) => k !== t.key))
                }
                className="px-[2px] text-term-faint hover:text-term-hi"
                title={`Remove ${t.label}`}
                aria-label={`Remove ${t.label}`}
              >
                ×
              </button>
            </span>
          );
        })}
        <span className="inline-flex items-center gap-[6px]">
          <ChannelSelect label="Channel to add" value={picker || channels[0]?.key || ''} onChange={setPicker} />
          <TermButton hotkey="A" onClick={addPicked} title="Add the selected channel">
            add
          </TermButton>
        </span>
      </div>

      {showMath && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-term-rule px-[14px] py-[6px]">
          <span className="font-semibold text-term-hi">math</span>
          <select
            aria-label="Operation"
            value={draft.op}
            onChange={(e) => setDraft({ ...draft, op: e.target.value as MathOp })}
            className="term-select"
          >
            {(Object.keys(MATH_OP_LABEL) as MathOp[]).map((op) => (
              <option key={op} value={op}>
                {MATH_OP_LABEL[op]}
              </option>
            ))}
          </select>
          <span className="text-term-dim">A</span>
          <ChannelSelect label="Input A" value={draft.a} onChange={(a) => setDraft({ ...draft, a })} />
          {draft.op !== 'derivative' && (
            <>
              <span className="text-term-dim">B</span>
              <ChannelSelect label="Input B" value={draft.b} onChange={(b) => setDraft({ ...draft, b })} />
            </>
          )}
          <span className="text-term-dim">× scale</span>
          <TermInput aria-label="Scale" value={draft.scale} onChange={(e) => setDraft({ ...draft, scale: e.target.value })} className="w-[7ch] min-w-0" />
          <span className="text-term-dim">unit</span>
          <TermInput aria-label="Unit" value={draft.unit} onChange={(e) => setDraft({ ...draft, unit: e.target.value })} className="w-[9ch] min-w-0" />
          <TermButton boxed onClick={addMath}>
            add math channel
          </TermButton>
          <span className="italic text-term-dim">Analysis only, not a platform signal (derived signals live in vehicle-defs).</span>
        </div>
      )}

      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        <canvas ref={canvasRef} onClick={handleCanvasClick} className="h-full w-full cursor-crosshair" />

        {showReadout && (
          <table className="absolute right-[14px] top-[10px] border border-term-ruleHi bg-term-bg">
            <thead>
              <tr>
                <th className={TH}>cursor</th>
                <th className={cn(TH, 'text-right text-term-amber')}>A</th>
                <th className={cn(TH, 'text-right text-term-hi')}>B</th>
                <th className={cn(TH, 'text-right')}>B − A</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className={cn(TD, 'text-term-dim')}>t s</td>
                <td className={cn(TD, 'text-right')}>{cursorA !== null ? cursorTime(cursorA).toFixed(3) : <span className="text-term-faint">–</span>}</td>
                <td className={cn(TD, 'text-right')}>{cursorB !== null ? cursorTime(cursorB).toFixed(3) : <span className="text-term-faint">–</span>}</td>
                <td className={cn(TD, 'text-right text-term-hi')}>
                  {cursorA !== null && cursorB !== null ? `${((cursorB - cursorA) * timeWindowSec * 1000).toFixed(1)} ms` : <span className="text-term-faint">–</span>}
                </td>
              </tr>
              {traces.map((t) => {
                const va = cursorA !== null ? sampleAt(t.series, cursorTime(cursorA)) : undefined;
                const vb = cursorB !== null ? sampleAt(t.series, cursorTime(cursorB)) : undefined;
                const cell = (v: number | undefined) => (v === undefined ? <span className="text-term-faint">–</span> : formatValue(v));
                return (
                  <tr key={t.key}>
                    <td className={cn(TD, 'max-w-[260px] overflow-hidden text-ellipsis')} title={t.label}>
                      <Swatch slot={t.slot} dashed={t.dashed} /> <ChannelLabel label={t.label} />
                    </td>
                    <td className={cn(TD, 'text-right')}>{cell(va)}</td>
                    <td className={cn(TD, 'text-right')}>{cell(vb)}</td>
                    <td className={cn(TD, 'text-right text-term-hi')}>{va !== undefined && vb !== undefined ? formatValue(vb - va) : <span className="text-term-faint">–</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <div className="flex h-[24px] shrink-0 items-center gap-[22px] whitespace-nowrap border-t border-term-rule px-[14px] text-term-faint">
        <span>each trace auto-scaled to its visible range, min-max per pixel when dense</span>
        <span>
          click places cursor <span className={nextCursor === 'A' ? 'text-term-amber' : 'text-term-hi'}>{nextCursor}</span>
        </span>
      </div>
    </div>
  );
};
