import { describe, it, expect } from 'vitest';
import { FrameTimingTracker, BusLoadMeter, frameBits } from '@/services/capture';
import { updateSnifferRecord, classifyBit } from '@/services/sniffer';
import type { CanFrame } from '@/types/can';

const f = (id: number, t: number, data = [0, 0, 0, 0, 0, 0, 0, 0], bus = 'platform'): CanFrame => ({
  id, idHex: '', bus, dlc: data.length, data, timestamp: t, deltaMs: 0, isExtended: false, periodMs: 0, frequencyHz: 0, count: 0,
});

describe('FrameTimingTracker', () => {
  it('computes the period per ID, not across IDs', () => {
    const t = new FrameTimingTracker();
    t.stamp(f(0x20, 0.0));
    t.stamp(f(0x110, 0.01));
    const a = t.stamp(f(0x20, 0.02));
    expect(a.periodMs).toBeCloseTo(20);
    expect(a.frequencyHz).toBeCloseTo(50);
    expect(a.deltaMs).toBeCloseTo(10);
    expect(a.count).toBe(2);
  });
});

describe('BusLoadMeter', () => {
  it('measures load from wire bits', () => {
    const m = new BusLoadMeter();
    // 1000 standard 8-byte frames = 1000 * 111 bits in 1 s on 500 kbit/s = 22.2 %
    for (let i = 0; i < 1000; i++) m.add(f(0x20, i / 1000));
    expect(frameBits(8, false)).toBe(111);
    expect(m.sample(1).get('platform')!.loadPct).toBeCloseTo(22.2, 5);
    expect(m.sample(1).get('platform')!.loadPct).toBe(0);
  });
});

describe('sniffer', () => {
  it('marks direction reversals as toggling', () => {
    let r = updateSnifferRecord(undefined, f(1, 0, [1]));
    r = updateSnifferRecord(r, f(1, 1, [2]));
    expect(r.byteStatuses[0]).toBe('inc');
    r = updateSnifferRecord(r, f(1, 2, [1]));
    expect(r.byteStatuses[0]).toBe('toggling');
    r = updateSnifferRecord(r, f(1, 3, [0]));
    expect(r.byteStatuses[0]).toBe('dec');
  });
  it('classifies bits by flip rate, not by absolute count', () => {
    expect(classifyBit(0, 100)).toBe('STATIC');
    expect(classifyBit(2, 100)).toBe('RARE');
    expect(classifyBit(100, 100)).toBe('FAST');
    expect(classifyBit(100, 10_000)).toBe('RARE');
  });
});
