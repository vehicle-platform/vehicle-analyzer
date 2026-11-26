import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Empty } from '../ui/panel-parts';
import { Note, TermButton, TermInput, Toolbar } from '../ui/primitives';
import { useActiveTheme } from '../ui/theme';
import { drawTrack, valuesForColor } from '../ui/trackDraw';
import { useDevicePixelRatio, useElementSize, type ElementSize } from '../ui/useCanvas';
import { SessionClient } from '../services/sessionClient';
import { NoGpsInSessionError, TrackClient, TrackResponse } from '../services/trackClient';
import {
  boundsOfSegments,
  colorScale,
  fitView,
  nearestByScreen,
  panView,
  resizeView,
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
  /** False when the loaded replay is another session or a log on a different time axis. */
  replaySynced?: boolean;
}

const PADDING = 28;
const SEEK_RADIUS_PX = 14;

const fmt = (n: number) => String(Number(n.toPrecision(4)));

/** Relative dead-reckoned ride track (roadmap A7a). Never a map and never an absolute position. */
export const TrackPanel: React.FC<TrackPanelProps> = ({
  token,
  onTokenChange,
  serverUrl,
  onServerUrlChange,
  sessionId,
  replayTimeSec,
  onSeekTime,
  replaySynced = true,
}) => {
  const theme = useActiveTheme();
  const dpr = useDevicePixelRatio();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [track, setTrack] = useState<TrackResponse | null>(null);
  const [seriesNames, setSeriesNames] = useState<string[]>([]);
  const [color, setColor] = useState<string>('');
  const [viewVersion, setViewVersion] = useState(0);
  const [reloadNonce, setReloadNonce] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noGps, setNoGps] = useState(false);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);
  // Editing the URL/token inputs must not fetch: the effects read the latest values from here.
  const connection = useRef({ serverUrl, token });
  useEffect(() => {
    connection.current = { serverUrl, token };
  }, [serverUrl, token]);
  // The view is fitted when a track first appears for a session and on Fit, never on a refetch or resize.
  const viewRef = useRef<{ sessionId: string | null; view: TrackView | null }>({ sessionId: null, view: null });
  const lastSize = useRef<ElementSize | null>(null);
  const visibleTrack = track && track.sessionId === sessionId ? track : null;

  const bounds = useMemo(() => (visibleTrack ? boundsOfSegments(visibleTrack.segments) : null), [visibleTrack]);
  const canvasShown = Boolean(sessionId && serverUrl.trim() && visibleTrack && !noGps && visibleTrack.segments.length > 0);
  const size = useElementSize(canvasRef, canvasShown);

  useEffect(() => {
    const { serverUrl: url, token: apiToken } = connection.current;
    if (!sessionId || !url.trim()) {
      setSeriesNames([]);
      return;
    }
    let cancelled = false;
    const client = new SessionClient(url, apiToken);
    void client
      .getSeries(sessionId, { maxPoints: 10 })
      .then((res) => {
        if (cancelled) return;
        const names = res.series.map((s) => s.name).filter((name) => !isPositionChannel(name));
        setSeriesNames(names);
        setColor((current) => (current && names.length > 0 && !names.includes(current) ? '' : current));
      })
      .catch(() => {
        if (!cancelled) setSeriesNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, reloadNonce]);

  // A colour change or Refresh keeps the current track (and its view) on screen until the new data arrives.
  useEffect(() => {
    const { serverUrl: url, token: apiToken } = connection.current;
    if (!sessionId || !url.trim()) {
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
    const client = new TrackClient(url, apiToken);
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
  }, [sessionId, color, reloadNonce]);

  useEffect(() => {
    if (viewRef.current.sessionId !== sessionId) {
      viewRef.current = { sessionId, view: null };
      lastSize.current = null;
    }
    if (!bounds) {
      viewRef.current = { sessionId, view: null };
      lastSize.current = null;
      return;
    }
    if (!size) return;
    const previous = lastSize.current;
    lastSize.current = size;
    const current = viewRef.current.view;
    if (!current) {
      viewRef.current = { sessionId, view: fitView(bounds, size.width, size.height, PADDING) };
    } else if (previous && (previous.width !== size.width || previous.height !== size.height)) {
      viewRef.current = { sessionId, view: resizeView(current, previous.width, previous.height, size.width, size.height) };
    }
  }, [bounds, size, sessionId]);

  useEffect(() => {
    const view = viewRef.current.view;
    if (!visibleTrack || !view || !size || !canvasRef.current) return;
    drawTrack(canvasRef.current, visibleTrack, view, replaySynced ? replayTimeSec : null, theme);
  }, [visibleTrack, viewVersion, replayTimeSec, replaySynced, theme, size, dpr]);

  // Native listener: React registers wheel handlers as passive, where preventDefault is ignored.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const current = viewRef.current.view;
      if (!current) return;
      const rect = canvas.getBoundingClientRect();
      const factor = e.deltaY < 0 ? 1.2 : 1 / 1.2;
      viewRef.current = { sessionId, view: zoomAt(current, e.clientX - rect.left, e.clientY - rect.top, factor) };
      setViewVersion((value) => value + 1);
    };
    canvas.addEventListener('wheel', onWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', onWheel);
  }, [canvasShown, sessionId]);

  const fit = () => {
    if (!bounds || !size) return;
    viewRef.current = { sessionId, view: fitView(bounds, size.width, size.height, PADDING) };
    setViewVersion((value) => value + 1);
  };

  const localPoint = (e: React.MouseEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!viewRef.current.view || e.button !== 0) return;
    const p = localPoint(e);
    drag.current = { x: p.x, y: p.y, moved: false };
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const current = viewRef.current.view;
    if (!drag.current || !current) return;
    const p = localPoint(e);
    const dx = p.x - drag.current.x;
    const dy = p.y - drag.current.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) drag.current.moved = true;
    drag.current = { x: p.x, y: p.y, moved: drag.current.moved };
    viewRef.current = { sessionId, view: panView(current, dx, dy) };
    setViewVersion((value) => value + 1);
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
    const view = viewRef.current.view;
    if (!visibleTrack || !view || !replaySynced) return;
    const p = localPoint(e);
    const hit = nearestByScreen(visibleTrack.segments, view, p.x, p.y, SEEK_RADIUS_PX);
    if (hit && onSeekTime) onSeekTime(hit.tMs);
  };

  const colorOptions = ['', ...seriesNames];
  const legendName = visibleTrack?.color?.name ?? 'speed';
  const legendUnit = visibleTrack?.color ? (visibleTrack.color.unit ?? '-') : 'm/s';
  const legendScale = useMemo(() => (visibleTrack ? colorScale(valuesForColor(visibleTrack), 16) : null), [visibleTrack]);

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
        <TermButton boxed onClick={() => setReloadNonce((n) => n + 1)} disabled={busy || !sessionId} title="Fetch the track again (the zoom stays)">
          Refresh
        </TermButton>
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
      ) : busy && !visibleTrack ? (
        <Empty>Loading track...</Empty>
      ) : noGps ? (
        <Empty>No GPS in this session.</Empty>
      ) : !visibleTrack ? (
        <Empty>No track to draw.</Empty>
      ) : visibleTrack.segments.length === 0 ? (
        <Empty>No usable GNSS samples in this session.</Empty>
      ) : (
        <>
          <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-term-rule px-[14px] py-[6px] text-term-dim">
            <span className="text-term-hi">{sessionId}</span>
            <span>
              {fmt(visibleTrack.pathLengthM)} m path · {visibleTrack.pointsTotal} samples
              {visibleTrack.downsampled ? ' (downsampled)' : ''}
            </span>
            <span>
              excluded: no-fix {visibleTrack.excluded.noFix}, stale fix {visibleTrack.excluded.staleFix}, heading {visibleTrack.excluded.untrustedHeading}
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
          {onSeekTime && !replaySynced && (
            <Note className="shrink-0 px-[14px] pb-1 text-term-amber">Open this session in Recorded sessions (E) to sync.</Note>
          )}
        </>
      )}
    </div>
  );
};
