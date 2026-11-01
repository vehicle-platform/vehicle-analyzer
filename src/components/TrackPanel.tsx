import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from '../ui/panel-parts';
import { Note, TermButton, TermInput, Toolbar } from '../ui/primitives';
import { themeColor, useActiveTheme } from '../ui/theme';
import { SessionClient } from '../services/sessionClient';
import { NoGpsInSessionError, TrackClient, TrackResponse } from '../services/trackClient';
import {
  boundsOfSegments,
  colorScale,
  fitView,
  nearestByScreen,
  nearestByTime,
  panView,
  scaleBar,
  worldToScreen,
  zoomAt,
  type TrackView,
} from '../services/trackGeometry';
import { isPositionChannel } from '../services/compare';

interface TrackPanelProps {
  token: string;
  onTokenChange: (token: string) => void;
  serverUrl: string;
  onServerUrlChange: (url: string) => void;
  /** The session selected/opened in the Recorded sessions view (E). */
  sessionId: string | null;
  /** Replay position in seconds on the recorded session's t0 axis. */
  replayTimeSec: number;
  /** Seek the replay to a track point time (ms on the session's t0 axis). */
  onSeekTime?: (tMs: number) => void;
}

const PADDING = 28;
const SEEK_RADIUS_PX = 14;

const fmt = (n: number) => String(Number(n.toPrecision(4)));

const valuesForColor = (track: TrackResponse): (number | null)[] => {
  const out: (number | null)[] = [];
  for (const segment of track.segments) {
    if (track.color) out.push(...(segment.colorV ?? segment.speedMps.map(() => null)));
    else out.push(...segment.speedMps);
  }
  return out;
};

const drawTrack = (
  canvas: HTMLCanvasElement,
  track: TrackResponse,
  view: TrackView,
  replayTimeSec: number,
  theme: string
) => {
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext('2d');
  if (!ctx || typeof Path2D === 'undefined') return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const values = valuesForColor(track);
  const scale = colorScale(values, 16);
  const paths = new Map<number, Path2D>();
  const pathFor = (bin: number | null) => {
    const key = bin ?? -1;
    let path = paths.get(key);
    if (!path) {
      path = new Path2D();
      paths.set(key, path);
    }
    return path;
  };

  for (const segment of track.segments) {
    const n = Math.min(segment.tMs.length, segment.xM.length, segment.yM.length, segment.speedMps.length);
    if (n === 0) continue;
    let previous = worldToScreen(view, segment.xM[0], segment.yM[0]);
    let previousBin = scale.binOf(track.color ? (segment.colorV?.[0] ?? null) : segment.speedMps[0]);
    const first = pathFor(previousBin);
    first.moveTo(previous.x, previous.y);
    for (let i = 1; i < n; i++) {
      const point = worldToScreen(view, segment.xM[i], segment.yM[i]);
      const bin = scale.binOf(track.color ? (segment.colorV?.[i] ?? null) : segment.speedMps[i]);
      const path = pathFor(bin);
      if (bin !== previousBin) path.moveTo(previous.x, previous.y);
      path.lineTo(point.x, point.y);
      previous = point;
      previousBin = bin;
    }
  }

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  for (const [key, path] of paths) {
    ctx.strokeStyle = key < 0 ? scale.neutral : scale.colors[key];
    ctx.stroke(path);
  }

  // Start (circle) and end (square), one per segment.
  for (const segment of track.segments) {
    if (segment.xM.length === 0) continue;
    const start = worldToScreen(view, segment.xM[0], segment.yM[0]);
    const end = worldToScreen(view, segment.xM[segment.xM.length - 1], segment.yM[segment.yM.length - 1]);
    ctx.fillStyle = themeColor('hi');
    ctx.beginPath();
    ctx.arc(start.x, start.y, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = themeColor('amber');
    ctx.fillRect(end.x - 3, end.y - 3, 6, 6);
  }

  // Replay cursor (null outside a segment or inside a gap).
  const cursor = nearestByTime(track.segments, replayTimeSec * 1000);
  if (cursor) {
    const at = worldToScreen(view, cursor.x, cursor.y);
    ctx.strokeStyle = themeColor('red');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(at.x, at.y, 7, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(at.x - 10, at.y);
    ctx.lineTo(at.x + 10, at.y);
    ctx.moveTo(at.x, at.y - 10);
    ctx.lineTo(at.x, at.y + 10);
    ctx.stroke();
  }

  // North arrow and scale bar.
  const arrowX = rect.width - 28;
  const arrowY = 28;
  ctx.strokeStyle = themeColor('dim');
  ctx.fillStyle = themeColor('dim');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(arrowX, arrowY + 14);
  ctx.lineTo(arrowX, arrowY - 10);
  ctx.moveTo(arrowX - 4, arrowY - 5);
  ctx.lineTo(arrowX, arrowY - 12);
  ctx.lineTo(arrowX + 4, arrowY - 5);
  ctx.stroke();
  ctx.font = '11px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.fillText('N', arrowX, arrowY + 27);

  const bar = scaleBar(view);
  if (bar.px > 0) {
    const x0 = 18;
    const y0 = rect.height - 22;
    ctx.strokeStyle = themeColor('fg');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x0 + bar.px, y0);
    ctx.moveTo(x0, y0 - 4);
    ctx.lineTo(x0, y0 + 4);
    ctx.moveTo(x0 + bar.px, y0 - 4);
    ctx.lineTo(x0 + bar.px, y0 + 4);
    ctx.stroke();
    ctx.fillStyle = themeColor('dim');
    ctx.textAlign = 'left';
    ctx.fillText(bar.label, x0, y0 - 7);
  }

  // `theme` is read through themeColor; the argument keeps the redraw dependency explicit.
  void theme;
};

/** Relative dead-reckoned ride track (roadmap A7a). Never a map and never an absolute position. */
export const TrackPanel: React.FC<TrackPanelProps> = ({
  token,
  onTokenChange,
  serverUrl,
  onServerUrlChange,
  sessionId,
  replayTimeSec,
  onSeekTime,
}) => {
  const theme = useActiveTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [track, setTrack] = useState<TrackResponse | null>(null);
  const [seriesNames, setSeriesNames] = useState<string[]>([]);
  const [color, setColor] = useState<string>('');
  const [view, setView] = useState<TrackView | null>(null);
  const [size, setSize] = useState({ width: 1, height: 1 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noGps, setNoGps] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const bounds = useMemo(() => (track ? boundsOfSegments(track.segments) : null), [track]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const measure = () => {
      const rect = canvas.getBoundingClientRect();
      setSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [track, noGps, error, busy, sessionId]);

  useEffect(() => {
    if (!sessionId || !serverUrl.trim()) {
      setSeriesNames([]);
      return;
    }
    let cancelled = false;
    const client = new SessionClient(serverUrl, token);
    void client
      .getSeries(sessionId, { maxPoints: 10 })
      .then((res) => {
        if (cancelled) return;
        setSeriesNames(res.series.map((s) => s.name).filter((name) => !isPositionChannel(name)));
      })
      .catch(() => {
        if (!cancelled) setSeriesNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, serverUrl, token]);

  useEffect(() => {
    if (!sessionId || !serverUrl.trim()) {
      setTrack(null);
      setError(null);
      setNoGps(false);
      setBusy(false);
      return;
    }
    let cancelled = false;
    setBusy(true);
    setError(null);
    setNoGps(false);
    setTrack(null);
    const client = new TrackClient(serverUrl, token);
    void client
      .getTrack(sessionId, color ? { color } : {})
      .then((next) => {
        if (cancelled) return;
        setTrack(next);
        setBusy(false);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setTrack(null);
        setBusy(false);
        if (err instanceof NoGpsInSessionError) setNoGps(true);
        else setError(err instanceof Error ? err.message : 'Track request failed.');
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, serverUrl, token, color]);

  useEffect(() => {
    if (!bounds) {
      setView(null);
      return;
    }
    setView(fitView(bounds, size.width, size.height, PADDING));
  }, [bounds, size.width, size.height]);

  useEffect(() => {
    if (!track || !view || !canvasRef.current) return;
    drawTrack(canvasRef.current, track, view, replayTimeSec, theme);
  }, [track, view, replayTimeSec, theme, size.width, size.height]);

  const fit = () => {
    if (bounds) setView(fitView(bounds, size.width, size.height, PADDING));
  };

  const localPoint = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!view) return;
    e.preventDefault();
    const p = localPoint(e);
    const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
    setView((current) => (current ? zoomAt(current, p.x, p.y, factor) : current));
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!view) return;
    const p = localPoint(e);
    drag.current = { x: p.x, y: p.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current || !view) return;
    const p = localPoint(e);
    const dx = p.x - drag.current.x;
    const dy = p.y - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
    drag.current = { x: p.x, y: p.y, moved: drag.current.moved };
    setView((current) => (current ? panView(current, dx, dy) : current));
  };

  const onPointerUp = () => {
    if (drag.current?.moved) suppressClick.current = true;
    drag.current = null;
  };

  const onClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (suppressClick.current) {
      suppressClick.current = false;
      return;
    }
    if (!track || !view) return;
    const p = localPoint(e);
    const hit = nearestByScreen(track.segments, view, p.x, p.y, SEEK_RADIUS_PX);
    if (hit && onSeekTime) onSeekTime(hit.tMs);
  };

  useEffect(() => {
    if (color && seriesNames.length > 0 && !seriesNames.includes(color)) setColor('');
  }, [color, seriesNames]);

  const colorOptions = ['', ...seriesNames];
  const legendName = track?.color?.name ?? 'speed';
  const legendUnit = track?.color?.unit ?? 'm/s';
  const legendScale = useMemo(() => (track ? colorScale(valuesForColor(track), 16) : null), [track]);

  if (!serverUrl.trim()) {
    return (
      <div className="flex h-full select-none flex-col bg-term-bg">
        <Empty>No vehicle-server URL configured. Set it here or in Sessions (E).</Empty>
      </div>
    );
  }

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
        <label className="flex items-center gap-1">
          <span className="text-term-dim">colour</span>
          <select aria-label="Track colour" value={color} onChange={(e) => setColor(e.target.value)} className="term-select max-w-[280px]">
            {colorOptions.map((name) => (
              <option key={name || 'speed'} value={name}>
                {name || 'speed'}
              </option>
            ))}
          </select>
        </label>
        <TermButton boxed onClick={fit} disabled={!bounds} title="Fit the whole track">
          Fit
        </TermButton>
        <span className="ml-auto text-term-dim">{busy ? 'loading track...' : 'relative metres · north up · no position'}</span>
      </Toolbar>

      {error && (
        <div role="alert" className="shrink-0 border-b border-term-rule bg-term-redBg px-[14px] leading-[24px] text-term-red">
          ■ {error}
        </div>
      )}

      {!sessionId ? (
        <Empty>No recorded session selected. Pick one in Sessions (E).</Empty>
      ) : busy && !track ? (
        <Empty>Loading track...</Empty>
      ) : noGps ? (
        <Empty>No GPS in this session.</Empty>
      ) : !track ? (
        <Empty>No track to draw.</Empty>
      ) : track.segments.length === 0 ? (
        <Empty>No usable GNSS samples in this session.</Empty>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-term-rule px-[14px] py-[6px] text-term-dim">
            <span className="text-term-hi">{sessionId}</span>
            <span>
              {fmt(track.pathLengthM)} m path · {track.pointsTotal} samples
              {track.downsampled ? ' (downsampled)' : ''}
            </span>
            <span>
              excluded: no-fix {track.excluded.noFix}, stale fix {track.excluded.staleFix}, heading {track.excluded.untrustedHeading}
            </span>
            {legendScale && (
              <span className="ml-auto flex items-center gap-1" aria-label="Colour legend">
                <span>{legendName}</span>
                <span className="text-term-faint">[{legendUnit || '-'}]</span>
                {legendScale.colors.map((c, i) => (
                  <span key={i} style={{ backgroundColor: c }} className="inline-block h-[10px] w-[10px]" title={String(i)} />
                ))}
                <span className="text-term-faint">
                  {fmt(legendScale.min)}..{fmt(legendScale.max)}
                </span>
              </span>
            )}
          </div>
          <div className="relative min-h-0 flex-1">
            <canvas
              ref={canvasRef}
              role="img"
              aria-label="Relative ride track"
              className="absolute inset-0 h-full w-full cursor-crosshair"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onClick={onClick}
            />
          </div>
          <Note className="shrink-0 border-t border-term-rule px-[14px] py-1 text-term-faint">
            Dead-reckoned from GNSS speed and heading. Approximate shape, not a map.
          </Note>
        </>
      )}
    </div>
  );
};
