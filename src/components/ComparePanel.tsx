import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Note, Segmented, TermButton, TermInput, Toolbar, cn } from '../ui/primitives';
import { Empty, ListHead, TD, TH, scopePalette } from '../ui/panel-parts';
import { useActiveTheme } from '../ui/theme';
import { drawTrackLayer, prepareCanvas } from '../ui/trackDraw';
import { useDevicePixelRatio, useElementSize } from '../ui/useCanvas';
import { useHotkeys } from '../ui/keys';
import { SessionClient, SessionRow, SeriesResponse, type RideSummary } from '../services/sessionClient';
import {
  CompareAxis,
  CompareResult,
  commonChannels,
  compareRideSummaries,
  compareSessions,
  compareToCsv,
  distanceAvailability,
  polylines,
  sessionChannel,
  valueRange,
} from '../services/compare';
import { downloadFile } from '../services/exportService';
import { TrackClient, TrackResponse } from '../services/trackClient';
import { boundsOfSegments, fitView } from '../services/trackGeometry';
import { formatRideValue } from '../services/rideSummaryLayout';

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
const TrackOverlay: React.FC<{ a: TrackResponse; b: TrackResponse; colorA: string; colorB: string }> = ({ a, b, colorA, colorB }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const size = useElementSize(canvasRef);
  const dpr = useDevicePixelRatio();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !size) return;
    const bounds = boundsOfSegments([...a.segments, ...b.segments]);
    if (!bounds) return;
    const prepared = prepareCanvas(canvas);
    if (!prepared) return;
    const view = fitView(bounds, prepared.width, prepared.height, 24);
    drawTrackLayer(prepared.ctx, a, view, colorA);
    drawTrackLayer(prepared.ctx, b, view, colorB);
  }, [a, b, colorA, colorB, size, dpr]);

  return (
    <div className="relative w-full border border-term-rule" style={{ height: H_MAIN }}>
      <canvas ref={canvasRef} role="img" aria-label="Compare relative tracks" className="absolute inset-0 h-full w-full" />
    </div>
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
  const [trackNonce, setTrackNonce] = useState(0);
  const [summaryA, setSummaryA] = useState<RideSummary | null>(null);
  const [summaryB, setSummaryB] = useState<RideSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);

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
    setSummaryA(null);
    setSummaryB(null);
    setSummaryError(null);
    const summaryOf = async (id: string): Promise<{ summary: RideSummary | null; error: string | null }> => {
      try {
        return { summary: await client.getRideSummary(id), error: null };
      } catch (e) {
        return { summary: null, error: e instanceof Error ? e.message : 'Ride summary request failed.' };
      }
    };
    try {
      const [a, b, sa, sb] = await Promise.all([client.getSeries(idA), client.getSeries(idB), summaryOf(idA), summaryOf(idB)]);
      setDataA(a);
      setDataB(b);
      setSummaryA(sa.summary);
      setSummaryB(sb.summary);
      setSummaryError([sa.error, sb.error].filter((message): message is string => message !== null).join(' · ') || null);
      const common = commonChannels(a.series, b.series);
      setChannel((c) => (common.includes(c) ? c : (common[0] ?? '')));
      setTrackNonce((n) => n + 1);
      setStatus(`Loaded ${idA} and ${idB}: ${common.length} common channel${common.length === 1 ? '' : 's'}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Request failed.');
    } finally {
      setBusy(false);
    }
  };

  // Latest connection settings: editing the URL/token inputs must not fetch the tracks by itself.
  const connection = useRef({ serverUrl, token });
  connection.current = { serverUrl, token };

  // Fetches on show, on a session change while shown and on Compare. A response that is no
  // longer the latest request is dropped (the cleanup flags it).
  useEffect(() => {
    if (!showTracks || !idA || !idB) {
      setTrackBusy(false);
      return;
    }
    let cancelled = false;
    setTrackBusy(true);
    setTrackError(null);
    setTrackA(null);
    setTrackB(null);
    const trackClient = new TrackClient(connection.current.serverUrl, connection.current.token);
    Promise.all([trackClient.getTrack(idA), trackClient.getTrack(idB)])
      .then(([a, b]) => {
        if (cancelled) return;
        setTrackA(a);
        setTrackB(b);
        setTrackBusy(false);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setTrackError(e instanceof Error ? e.message : 'Track request failed.');
        setTrackBusy(false);
      });
    return () => {
      cancelled = true;
    };
  }, [showTracks, idA, idB, trackNonce]);

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

  const summaryRows = useMemo(() => compareRideSummaries(summaryA, summaryB), [summaryA, summaryB]);

  const exportCsv = () => {
    if (!result || result.x.length === 0) return;
    downloadFile(compareToCsv(result, summaryRows), `vehicle-analyzer-compare-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`, 'text/csv;charset=utf-8;');
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
                <span className="text-term-faint">
                  relative metres, each from its own origin · path A {fmt(trackA.pathLengthM)} m, B {fmt(trackB.pathLengthM)} m
                </span>
              </div>
              <TrackOverlay a={trackA} b={trackB} colorA={pal[0]} colorB={pal[1]} />
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

      {summaryError && <Note className="px-[14px] py-1 text-term-amber">Ride summary unavailable: {summaryError}</Note>}
      {summaryRows.length > 0 && (
        <div className="border-t border-term-rule">
          <ListHead aside={`${summaryRows.length} row${summaryRows.length === 1 ? '' : 's'}`}>ride summaries</ListHead>
          <table className="w-full border-collapse" aria-label="Ride summaries A vs B">
            <thead>
              <tr>
                <th className={TH}>name</th>
                <th className={TH}>A</th>
                <th className={TH}>B</th>
                <th className={TH}>B − A</th>
                <th className={TH}>unit</th>
              </tr>
            </thead>
            <tbody>
              {summaryRows.map((row) => {
                const cell = (value: number | null, status: string) =>
                  status === 'computed' ? formatRideValue(value, row.range) : <span className="text-term-faint">{status}</span>;
                return (
                  <tr key={row.name}>
                    <td className={cn(TD, 'text-term-fg')}>{row.name}</td>
                    <td className={cn(TD, 'text-term-hi')}>{cell(row.aValue, row.aStatus)}</td>
                    <td className={cn(TD, 'text-term-hi')}>{cell(row.bValue, row.bStatus)}</td>
                    <td className={cn(TD, 'text-term-dim')}>{formatRideValue(row.diff, row.range)}</td>
                    <td className={cn(TD, 'text-term-dim')}>{row.unit}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
