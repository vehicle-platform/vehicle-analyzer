import React, { useCallback, useMemo, useState } from 'react';
import { Note, Segmented, TermButton, TermInput, Toolbar, cn } from '../ui/primitives';
import { Empty, scopePalette } from '../ui/panel-parts';
import { useActiveTheme } from '../ui/theme';
import { useHotkeys } from '../ui/keys';
import { SessionClient, SessionRow, SeriesResponse } from '../services/sessionClient';
import {
  CompareAxis,
  CompareResult,
  commonChannels,
  compareSessions,
  compareToCsv,
  distanceAvailability,
  polylines,
  sessionChannel,
  valueRange,
} from '../services/compare';
import { downloadFile } from '../services/exportService';
import { TrackClient, TrackResponse } from '../services/trackClient';
import { boundsOfSegments, fitView, worldToScreen } from '../services/trackGeometry';

interface ComparePanelProps {
  token: string;
  onTokenChange: (token: string) => void;
  serverUrl: string;
  onServerUrlChange: (url: string) => void;
}

const W = 900;
const H_MAIN = 220;
const H_DIFF = 120;

const fmt = (n: number) => String(Number(n.toPrecision(5)));

/** One SVG trace area with a frame, min/max labels and one polyline set per trace. */
const Plot: React.FC<{
  x: number[];
  traces: { y: (number | null)[]; color: string; label: string }[];
  h: number;
  axisUnit: string;
  unit: string;
}> = ({ x, traces, h, axisUnit, unit }) => {
  const xr: [number, number] = [x[0], x[x.length - 1]];
  const range = valueRange(...traces.map((t) => t.y));
  if (x.length === 0 || !range) return <Empty>Nothing to draw (no overlap on this axis).</Empty>;
  const pad = range[1] > range[0] ? 0 : 1;
  const yr: [number, number] = [range[0] - pad, range[1] + pad];
  return (
    <div className="px-[14px] py-1">
      <svg viewBox={`0 0 ${W} ${h}`} className="w-full border border-term-rule" style={{ height: h }} preserveAspectRatio="none" role="img">
        {traces.map((t) =>
          polylines(x, t.y, xr, yr, W, h).map((run, i) =>
            run.length === 1 ? (
              <circle key={`${t.label}${i}`} cx={run[0][0]} cy={run[0][1]} r={1.5} fill={t.color} />
            ) : (
              <polyline key={`${t.label}${i}`} points={run.map((p) => p.join(',')).join(' ')} fill="none" stroke={t.color} strokeWidth={1.3} vectorEffect="non-scaling-stroke" />
            )
          )
        )}
      </svg>
      <div className="flex justify-between text-term-faint">
        <span>
          {fmt(xr[0])} {axisUnit}
        </span>
        <span>
          y {fmt(yr[0])} .. {fmt(yr[1])} {unit}
        </span>
        <span>
          {fmt(xr[1])} {axisUnit}
        </span>
      </div>
    </div>
  );
};

/** Both relative tracks on one canvas; each track starts at its own (0, 0) origin. */
const TrackOverlay: React.FC<{ a: TrackResponse; b: TrackResponse; colors: string[] }> = ({ a, b, colors }) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);

  React.useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const bounds = boundsOfSegments([...a.segments, ...b.segments]);
    if (!bounds) return;
    const view = fitView(bounds, canvas.width, canvas.height, 24);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    [a, b].forEach((track, index) => {
      ctx.strokeStyle = colors[index];
      for (const segment of track.segments) {
        const n = Math.min(segment.xM.length, segment.yM.length);
        if (n === 0) continue;
        const first = worldToScreen(view, segment.xM[0], segment.yM[0]);
        ctx.beginPath();
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < n; i++) {
          const point = worldToScreen(view, segment.xM[i], segment.yM[i]);
          ctx.lineTo(point.x, point.y);
        }
        ctx.stroke();
      }
    });
  }, [a, b, colors]);

  return (
    <canvas
      ref={canvasRef}
      width={W}
      height={H_MAIN}
      role="img"
      aria-label="Compare relative tracks"
      className="w-full border border-term-rule"
      style={{ height: H_MAIN }}
    />
  );
};

/** Compare two recorded vehicle-server sessions on a common time or distance axis (roadmap A4). */
export const ComparePanel: React.FC<ComparePanelProps> = ({ token, onTokenChange, serverUrl, onServerUrlChange }) => {
  const theme = useActiveTheme();
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [idA, setIdA] = useState('');
  const [idB, setIdB] = useState('');
  const [dataA, setDataA] = useState<SeriesResponse | null>(null);
  const [dataB, setDataB] = useState<SeriesResponse | null>(null);
  const [channel, setChannel] = useState('');
  const [axis, setAxis] = useState<CompareAxis>('time');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showTracks, setShowTracks] = useState(false);
  const [trackA, setTrackA] = useState<TrackResponse | null>(null);
  const [trackB, setTrackB] = useState<TrackResponse | null>(null);
  const [trackBusy, setTrackBusy] = useState(false);
  const [trackError, setTrackError] = useState<string | null>(null);

  const client = useMemo(() => new SessionClient(serverUrl, token), [serverUrl, token]);

  const refresh = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const rows = await client.listSessions();
      setSessions(rows);
      setStatus(`${rows.length} session${rows.length === 1 ? '' : 's'} on the server.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  }, [client]);

  const load = async () => {
    if (!idA || !idB) return;
    setBusy(true);
    setError(null);
    try {
      const [a, b] = await Promise.all([client.getSeries(idA), client.getSeries(idB)]);
      setDataA(a);
      setDataB(b);
      const common = commonChannels(a.series, b.series);
      setChannel((c) => (common.includes(c) ? c : (common[0] ?? '')));
      setStatus(`Loaded ${idA} and ${idB}: ${common.length} common channel${common.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  const loadTracks = useCallback(async () => {
    if (!idA || !idB) return;
    setTrackBusy(true);
    setTrackError(null);
    setTrackA(null);
    setTrackB(null);
    const trackClient = new TrackClient(serverUrl, token);
    try {
      const [a, b] = await Promise.all([trackClient.getTrack(idA), trackClient.getTrack(idB)]);
      setTrackA(a);
      setTrackB(b);
    } catch (e) {
      setTrackError(e instanceof Error ? e.message : 'Track request failed.');
    } finally {
      setTrackBusy(false);
    }
  }, [idA, idB, serverUrl, token]);

  React.useEffect(() => {
    if (showTracks) void loadTracks();
  }, [showTracks, loadTracks]);

  const channels = useMemo(() => (dataA && dataB ? commonChannels(dataA.series, dataB.series) : []), [dataA, dataB]);
  const chA = useMemo(() => (dataA && channel ? sessionChannel(dataA, idA, channel) : null), [dataA, idA, channel]);
  const chB = useMemo(() => (dataB && channel ? sessionChannel(dataB, idB, channel) : null), [dataB, idB, channel]);
  const dist = distanceAvailability(chA, chB);
  const effectiveAxis: CompareAxis = axis === 'distance' && !dist.ok ? 'time' : axis;

  const result: CompareResult | null = useMemo(() => {
    if (!chA || !chB) return null;
    try {
      return compareSessions(chA, chB, effectiveAxis);
    } catch {
      return null;
    }
  }, [chA, chB, effectiveAxis]);

  const exportCsv = () => {
    if (!result || result.x.length === 0) return;
    downloadFile(compareToCsv(result), `vehicle-analyzer-compare-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, 'text/csv;charset=utf-8;');
  };
  useHotkeys({ r: () => void refresh(), v: exportCsv });

  const pal = scopePalette(theme);
  const sessionSelect = (label: string, value: string, onChange: (v: string) => void) => (
    <label className="flex items-center gap-1">
      <span className="text-term-dim">{label}</span>
      <select aria-label={`Session ${label}`} value={value} onChange={(e) => onChange(e.target.value)} className="term-select max-w-[260px]">
        <option value="">select...</option>
        {sessions.map((s) => (
          <option key={s.session_id} value={s.session_id}>
            {s.session_id}
          </option>
        ))}
      </select>
    </label>
  );

  return (
    <div className="flex h-full select-none flex-col overflow-y-auto bg-term-bg">
      <Toolbar>
        <TermInput value={serverUrl} onChange={(e) => onServerUrlChange(e.target.value)} aria-label="vehicle-server URL" spellCheck={false} className="w-64" />
        <TermInput type="password" value={token} onChange={(e) => onTokenChange(e.target.value)} placeholder="token" aria-label="vehicle-server API token" autoComplete="off" className="w-32 min-w-0" />
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
        {sessionSelect('A', idA, setIdA)}
        {sessionSelect('B', idB, setIdB)}
        <TermButton boxed onClick={() => void load()} disabled={busy || !idA || !idB} title="Fetch the series of both sessions">
          Compare
        </TermButton>
        <label className="flex items-center gap-1">
          <span className="text-term-dim">channel</span>
          <select aria-label="Channel" value={channel} onChange={(e) => setChannel(e.target.value)} disabled={channels.length === 0} className="term-select max-w-[280px]">
            {channels.length === 0 && <option value="">none</option>}
            {channels.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <Segmented
          label="Axis"
          value={effectiveAxis}
          onChange={setAxis}
          options={[
            { value: 'time', label: 'time' },
            { value: 'distance', label: 'distance', disabled: !dist.ok, title: dist.ok ? 'Cumulative trip distance' : dist.reason },
          ]}
        />
        <TermButton hotkey="V" onClick={exportCsv} disabled={!result || result.x.length === 0} title="Export axis, A, B and B-A as CSV">
          Export CSV
        </TermButton>
        <TermButton boxed onClick={() => setShowTracks((value) => !value)} disabled={busy || !idA || !idB} title="Draw both relative tracks on one canvas">
          {showTracks ? 'Hide tracks' : 'Tracks'}
        </TermButton>
      </div>
      {!dist.ok && dataA && dataB && <Note className="px-[14px] pt-1 text-term-amber">Distance axis unavailable: {dist.reason}</Note>}

      {showTracks && (
        <div className="px-[14px] py-1">
          {trackError && (
            <Note className="text-term-amber">Track overlay unavailable: {trackError}</Note>
          )}
          {trackBusy && <Note className="text-term-dim">Loading both tracks...</Note>}
          {trackA && trackB && (
            <>
              <div className="flex gap-[22px] pb-1">
                <span style={{ color: pal[0] }}>A {idA}</span>
                <span style={{ color: pal[1] }}>B {idB}</span>
                <span className="text-term-faint">relative metres, each from its own origin</span>
              </div>
              <TrackOverlay a={trackA} b={trackB} colors={[pal[0], pal[1]]} />
            </>
          )}
        </div>
      )}

      {result ? (
        <>
          <div className="flex gap-[22px] px-[14px] pt-2">
            <span style={{ color: pal[0] }}>A {result.sessionA}</span>
            <span style={{ color: pal[1] }}>B {result.sessionB}</span>
            <span className="text-term-dim">
              {result.channel} [{result.unit || '-'}] on {result.axis} ({result.axisUnit}) · {result.x.length} points
            </span>
          </div>
          <Plot x={result.x} h={H_MAIN} axisUnit={result.axisUnit} unit={result.unit} traces={[{ y: result.a, color: pal[0], label: 'A' }, { y: result.b, color: pal[1], label: 'B' }]} />
          <div className="px-[14px] text-term-dim">difference B − A</div>
          <Plot x={result.x} h={H_DIFF} axisUnit={result.axisUnit} unit={result.unit} traces={[{ y: result.diff, color: pal[2], label: 'diff' }]} />
          <Note className={cn('px-[14px] py-1 text-term-faint')}>
            Series are the server&apos;s min/max downsampled samples, interpolated linearly inside each series only; gaps and non-overlap are blank. Not a platform signal.
          </Note>
        </>
      ) : (
        <Empty>{dataA && dataB ? 'Nothing to compare for this channel.' : 'Pick two sessions (Refresh first) and press Compare.'}</Empty>
      )}
    </div>
  );
};
