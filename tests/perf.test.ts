import { describe, it, expect } from 'vitest';
import { DEFS } from '@/defs';
import { VirtualCanBus } from '@/services/virtualBus';
import { CaptureStore, LOG_CAPACITY, HISTORY_CAPACITY } from '@/state/captureStore';
import { SeriesRing, RingBuffer, lowerBound, sampleAt } from '@/state/ring';
import type { CanFrame } from '@/types/can';

describe('ring buffers', () => {
  it('keep the newest samples in order and search by time', () => {
    const r = new SeriesRing(4);
    for (let i = 0; i < 10; i++) r.push(i, i * 10);
    expect(r.length).toBe(4);
    expect([0, 1, 2, 3].map((i) => r.timeAt(i))).toEqual([6, 7, 8, 9]);
    expect(lowerBound(r, 7.5)).toBe(2);
    expect(sampleAt(r, 7.5)).toBe(70);
    expect(sampleAt(r, 5)).toBeUndefined();
    const b = new RingBuffer<number>(3);
    [1, 2, 3, 4].forEach((x) => b.push(x));
    expect(b.toArray()).toEqual([2, 3, 4]);
  });
});

describe('capture throughput', () => {
  it('ingests a fully loaded bus (>= 4500 frames/s) many times faster than real time with bounded memory', () => {
    const bus = new VirtualCanBus(DEFS);
    const frames: CanFrame[] = [];
    (bus as any).onFrame = (f: CanFrame) => frames.push(f);
    for (let i = 0; i < 60 * 100; i++) bus.tick(); // 60 s of simulated traffic
    // Replay the 60 s capture 8 times back to back with shifted timestamps: 8 min of data.
    const store = new CaptureStore(DEFS);
    store.notify = () => undefined; // no UI in the test
    const n = frames.length * 8;
    const t0 = performance.now();
    for (let k = 0; k < 8; k++) {
      for (const f of frames) store.ingest({ ...f, timestamp: f.timestamp + k * 60 });
    }
    const sec = (performance.now() - t0) / 1000;
    const rate = n / sec;
    console.log(`ingest: ${n} frames in ${sec.toFixed(2)} s = ${Math.round(rate).toLocaleString()} frames/s`);
    // A 500 kbit/s bus at 100 % load carries about 4 500 8-byte standard frames per second.
    expect(rate).toBeGreaterThan(4500 * 5);
    expect(store.log.length).toBe(LOG_CAPACITY);
    for (const ring of store.history.values()) expect(ring.length).toBeLessThanOrEqual(HISTORY_CAPACITY);
  });
});
