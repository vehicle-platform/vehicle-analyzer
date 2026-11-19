import { useEffect, useRef } from 'react';
import type { CaptureStore } from '@/state/captureStore';

/** Once per second: advance the store's rate windows (scaled by the replay speed) and publish the frame rate. */
export function useSampling(
  store: CaptureStore,
  isReplaying: boolean,
  playbackSpeed: number,
  rxCounterRef: { current: number },
  setMsgPerSec: (n: number) => void
) {
  const isReplayingRef = useRef(isReplaying);
  const playbackSpeedRef = useRef(playbackSpeed);
  useEffect(() => {
    isReplayingRef.current = isReplaying;
    playbackSpeedRef.current = playbackSpeed;
  }, [isReplaying, playbackSpeed]);

  useEffect(() => {
    let last = performance.now();
    const interval = setInterval(() => {
      const now = performance.now();
      const wallSec = (now - last) / 1000;
      last = now;
      store.sampleSecond(wallSec * (isReplayingRef.current ? playbackSpeedRef.current : 1));
      setMsgPerSec(Math.round(rxCounterRef.current / wallSec));
      rxCounterRef.current = 0;
    }, 1000);
    return () => clearInterval(interval);
  }, [store, setMsgPerSec, rxCounterRef]);
}
