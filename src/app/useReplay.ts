import { useEffect, useRef, useState } from 'react';
import type { CaptureStore } from '@/state/captureStore';
import type { CanFrame, TelemetrySource } from '@/types/can';
import { ReplayItem, framesToItems, mergeSamples, replayMatchesSession } from '@/services/replay';
import { RecordedSeries, mapSeriesKey } from '@/services/sessionClient';
import { didKey } from '@/services/pipeline';

/** Frames replayed silently to rebuild the views after a backward seek. */
const REPLAY_REBUILD_WINDOW = 2000;
/** Longest real wait between two replayed frames (a gap in the log is not waited out). */
const REPLAY_MAX_GAP_MS = 1000;

interface ReplayDeps {
  store: CaptureStore;
  source: TelemetrySource;
  recordedSessionId: string | null;
  ingest: (frame: CanFrame) => void;
  ingestItem: (item: ReplayItem) => void;
  rxCounterRef: { current: number };
  /** Stops live capture, pauses the run state and switches the source (shared prelude of a load). */
  beginReplayLoad: (source: TelemetrySource) => void;
}

/** Time Machine replay: loaded items, transport state, seeking and the log / session loaders. */
export function useReplay({ store, source, recordedSessionId, ingest, ingestItem, rxCounterRef, beginReplayLoad }: ReplayDeps) {
  const [replayFrames, setReplayFrames] = useState<ReplayItem[]>([]);
  const [replayIndex, setReplayIndex] = useState<number>(0);
  // The recorded session the loaded replay came from (null for a log file); selecting a session does not load it.
  const [replaySessionId, setReplaySessionId] = useState<string | null>(null);
  const [isReplaying, setIsReplaying] = useState<boolean>(false);
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(1.0);
  // replayIndexRef is the source of truth for the replay position; every writer sets
  // it and the state together (a state-to-ref sync effect would lag and rewind it).
  const replayIndexRef = useRef<number>(0);

  const resetPosition = () => {
    setReplayIndex(0);
    replayIndexRef.current = 0;
  };

  const handleLogLoaded = (frames: CanFrame[]) => {
    beginReplayLoad('local_file');
    setIsReplaying(false);
    store.clear();
    store.resetRecordedMeta();
    setReplayFrames(framesToItems(frames));
    setReplaySessionId(null);
    resetPosition();
    if (frames.length > 0) ingest(frames[0]);
  };

  /** Recorded session series -> replay items (or pushed at once). Display metadata goes to the store. */
  const handleSessionLoaded = (series: RecordedSeries[], mode: 'replay' | 'all', sessionId: string) => {
    beginReplayLoad('server_session');
    setIsReplaying(false);
    store.clear();
    store.resetRecordedMeta();
    rxCounterRef.current = 0;
    const perKey = series.map((sr) => {
      const m = mapSeriesKey(sr.name, sr.kind);
      if (!m.fromDefs) store.setRecordedMeta(m.key, { label: m.label, group: m.group, unit: sr.unit });
      else if (!store.defs.vehicle.dids.some((d) => didKey(d.name) === m.key)) store.setRecordedMeta(m.key, { label: `DID ${m.label}`, group: 'session · DID (not in defs)', unit: sr.unit });
      return { key: m.key, t: sr.tMs.map((ms) => ms / 1000), v: sr.v };
    });
    setReplaySessionId(sessionId);
    if (mode === 'all') {
      for (const s of perKey) for (let i = 0; i < s.t.length; i++) store.ingestSample(s.key, s.t[i], s.v[i]);
      setReplayFrames([]);
      resetPosition();
      return;
    }
    const items = mergeSamples(perKey);
    setReplayFrames(items);
    resetPosition();
    if (items.length > 0) ingestItem(items[0]);
  };

  // Each frame is scheduled after the recorded gap to the previous one, divided by the
  // speed; frames closer than a timer tick are emitted together.
  useEffect(() => {
    if (!isReplaying || replayFrames.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;

    const step = () => {
      if (cancelled) return;
      let idx = replayIndexRef.current;
      const startT = replayFrames[idx]?.t ?? 0;
      while (idx + 1 < replayFrames.length) {
        const gapMs = ((replayFrames[idx + 1].t - startT) * 1000) / playbackSpeed;
        if (gapMs > 4) break;
        idx += 1;
        ingestItem(replayFrames[idx]);
      }
      replayIndexRef.current = idx;
      setReplayIndex(idx);
      if (idx + 1 >= replayFrames.length) {
        setIsReplaying(false);
        return;
      }
      const waitMs = Math.min(
        REPLAY_MAX_GAP_MS,
        Math.max(0, ((replayFrames[idx + 1].t - replayFrames[idx].t) * 1000) / playbackSpeed)
      );
      timer = setTimeout(() => {
        if (cancelled) return;
        // Read the index again: a seek during playback moves it.
        const next = replayIndexRef.current + 1;
        if (next >= replayFrames.length) {
          setIsReplaying(false);
          return;
        }
        replayIndexRef.current = next;
        ingestItem(replayFrames[next]);
        step();
      }, waitMs);
    };
    step();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [isReplaying, replayFrames, playbackSpeed, ingestItem]);

  // Forward seeks feed the skipped frames; backward seeks rebuild the views from a
  // window before the target, so no view keeps frames from "the future".
  const seekTo = (index: number) => {
    if (index < 0 || index >= replayFrames.length) return;
    const current = replayIndexRef.current;
    if (index > current && index - current <= REPLAY_REBUILD_WINDOW) {
      for (let i = current + 1; i <= index; i++) ingestItem(replayFrames[i]);
    } else if (index !== current) {
      store.clear();
      for (let i = Math.max(0, index - REPLAY_REBUILD_WINDOW); i <= index; i++) ingestItem(replayFrames[i]);
    }
    replayIndexRef.current = index;
    setReplayIndex(index);
  };

  const trackReplaySynced = replayMatchesSession(replaySessionId, recordedSessionId, source);

  /** Seek the replay transport to the frame nearest a track point time (ms). Only the same session shares the axis. */
  const seekToTime = (tMs: number) => {
    if (replayFrames.length === 0 || !trackReplaySynced) return;
    const target = tMs / 1000;
    let lo = 0;
    let hi = replayFrames.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (replayFrames[mid].t < target) lo = mid + 1;
      else hi = mid;
    }
    const previous = Math.max(0, lo - 1);
    const index = Math.abs(replayFrames[previous].t - target) <= Math.abs(replayFrames[lo].t - target) ? previous : lo;
    seekTo(index);
  };

  return {
    replayFrames,
    replayIndex,
    replayIndexRef,
    replaySessionId,
    isReplaying,
    setIsReplaying,
    playbackSpeed,
    setPlaybackSpeed,
    handleLogLoaded,
    handleSessionLoaded,
    seekTo,
    seekToTime,
    trackReplaySynced,
    currentReplayTime: replayFrames[replayIndex]?.t ?? 0,
    totalReplayDuration: replayFrames[replayFrames.length - 1]?.t ?? 0,
  };
}
