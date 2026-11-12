import { describe, it, expect } from 'vitest';
import { parseSlcanLine, SlcanScanner, WebSerialCanAdapter, type SlcanPort } from '@/services/webSerialCan';
import { parseStreamMessage } from '@/services/streamClient';
import { exportToVectorAsc } from '@/services/exportService';
import { parseVectorAsc, parseCanCsv } from '@/services/logParser';
import { exportToCsv } from '@/services/exportService';
import type { CanFrame } from '@/types/can';

const frame = (over: Partial<CanFrame>): CanFrame => ({
  id: 0x110, idHex: '0x110', bus: 'platform', dlc: 8, data: [1, 2, 3, 4, 5, 6, 7, 8], timestamp: 1.5,
  deltaMs: 0, isExtended: false, periodMs: 0, frequencyHz: 0, count: 1, ...over,
});

describe('SLCAN', () => {
  it('parses standard and extended data frames', () => {
    expect(parseSlcanLine('t1102AABB', 'vehicle')).toMatchObject({ id: 0x110, dlc: 2, data: [0xaa, 0xbb], isExtended: false });
    expect(parseSlcanLine('T18DAF1108046240C1FAAAAAAAA', 'vehicle')).toMatchObject({ id: 0x18daf110, dlc: 8, isExtended: true });
  });
  it('rejects malformed lines and non-data replies', () => {
    for (const l of ['t11', 't1109AA', 'tFFF1AA'.replace('FFF', '8FF'), 'z', '\x07', 't110', 'r1100']) {
      expect(parseSlcanLine(l, 'vehicle')).toBeNull();
    }
  });
  it('scans replies and lines across chunk boundaries', () => {
    const s = new SlcanScanner();
    expect(s.push('\rt110')).toEqual([{ kind: 'ok' }]);
    expect(s.push('1AA\r\n\x07V1013\r')).toEqual([
      { kind: 'line', text: 't1101AA' }, { kind: 'error' }, { kind: 'line', text: 'V1013' }]);
    expect(s.push('\n\r')).toEqual([{ kind: 'ok' }]);
  });
});

/** A fake serial port: `reply` maps each command the adapter writes to the adapter's answer. */
function fakePort(reply: (cmd: string) => string | null) {
  const enc = new TextEncoder();
  const written: string[] = [];
  let rx!: ReadableStreamDefaultController<Uint8Array>;
  let cancelled = false;
  const port: SlcanPort & { written: string[]; emit(s: string): void } = {
    written,
    emit: (s) => { if (!cancelled) rx.enqueue(enc.encode(s)); },
    open: async () => undefined,
    close: async () => undefined,
    readable: new ReadableStream<Uint8Array>({ start: (c) => { rx = c; }, cancel: () => { cancelled = true; } }),
    writable: new WritableStream<Uint8Array>({
      write: (chunk) => {
        const cmd = new TextDecoder().decode(chunk).replace(/\r$/, '');
        written.push(cmd);
        const r = reply(cmd);
        if (r !== null) setTimeout(() => port.emit(r), 0);
      },
    }),
  };
  return port;
}

describe('SLCAN listen-only open (invariant 1, E-25 (2))', () => {
  it('opens only after C, S6 and L are each confirmed, and never sends O', async () => {
    const port = fakePort(() => '\r');
    const frames: CanFrame[] = [];
    const adapter = new WebSerialCanAdapter('vehicle', 200);
    await expect(adapter.openPort(port, 115200, (f) => frames.push(f))).resolves.toBe(true);
    expect(port.written).toEqual(['C', 'S6', 'L']);
    expect(adapter.isConnected()).toBe(true);
    port.emit('t1102AABB\r');
    await new Promise((r) => setTimeout(r, 10));
    expect(frames).toHaveLength(1);
    await adapter.disconnect();
    expect(port.written.at(-1)).toBe('C');
    expect(port.written).not.toContain('O');
  });

  it('accepts a BELL for C (channel already closed)', async () => {
    const port = fakePort((c) => (c === 'C' ? '\x07' : '\r'));
    await expect(new WebSerialCanAdapter('vehicle', 200).openPort(port, 115200, () => undefined)).resolves.toBe(true);
  });

  it('refuses an adapter that rejects L and delivers no frame', async () => {
    const frames: CanFrame[] = [];
    const port = fakePort((c) => (c === 'L' ? 't1102AABB\r\x07' : '\r'));
    const adapter = new WebSerialCanAdapter('vehicle', 200);
    await expect(adapter.openPort(port, 115200, (f) => frames.push(f))).rejects.toThrow(/refused listen-only/);
    expect(adapter.isConnected()).toBe(false);
    expect(frames).toHaveLength(0);
  });

  it('refuses an adapter that never confirms L', async () => {
    const port = fakePort((c) => (c === 'L' ? null : '\r'));
    const adapter = new WebSerialCanAdapter('vehicle', 50);
    await expect(adapter.openPort(port, 115200, () => undefined)).rejects.toThrow(/did not confirm listen-only/);
    expect(adapter.isConnected()).toBe(false);
  });

  it('refuses a silent port and a refused bit rate', async () => {
    await expect(new WebSerialCanAdapter('vehicle', 50).openPort(fakePort(() => null), 115200, () => undefined))
      .rejects.toThrow(/does not answer/);
    await expect(new WebSerialCanAdapter('vehicle', 50).openPort(fakePort((c) => (c === 'S6' ? '\x07' : '\r')), 115200, () => undefined))
      .rejects.toThrow(/S6/);
  });
});

describe('vehicle-server stream protocol', () => {
  it('reads CanFrameDto fields (data_hex, timestamp_us, is_extended, channel)', () => {
    const { frames } = parseStreamMessage(
      { type: 'frame', payload: { timestamp_us: 2_500_000, channel: 1, id: 0x18daf110, is_extended: true, dlc: 8, data_hex: '04620c1faaaaaaaa' } });
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ bus: 'vehicle', isExtended: true, timestamp: 2.5, data: [4, 0x62, 0x0c, 0x1f, 0xaa, 0xaa, 0xaa, 0xaa] });
  });
  it('reads batches and stats; ignores malformed frames', () => {
    const r = parseStreamMessage(
      { type: 'batch', payload: { timestamp_us: 0, frames: [{ id: 1, data_hex: 'zz' }, { id: 0x20, channel: 2, dlc: 1, data_hex: '01' }], stats: { bus_load_pct: 12.5, frame_rate_hz: 300 } } });
    expect(r.frames.map((f) => f.id)).toEqual([0x20]);
    expect(r.stats).toEqual({ busLoadPct: 12.5, msgPerSec: 300 });
  });
});

describe('log export/import', () => {
  it('writes Vector ASC without 0x prefixes and reads it back', () => {
    const frames = [frame({}), frame({ id: 0x18da10f1, idHex: '0x18DA10F1', isExtended: true, bus: 'vehicle', timestamp: 2, data: [2, 0x10, 3, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa] })];
    const asc = exportToVectorAsc(frames);
    expect(asc).not.toMatch(/0x/);
    expect(asc).toMatch(/18DA10F1x/);
    const back = parseVectorAsc(asc);
    expect(back.map((f) => [f.id, f.isExtended, f.bus, f.data.length])).toEqual([
      [0x110, false, 'platform', 8],
      [0x18da10f1, true, 'vehicle', 8],
    ]);
    expect(back[1].timestamp).toBe(2);
  });
  it('round-trips CSV', () => {
    const back = parseCanCsv(exportToCsv([frame({})]));
    expect(back[0]).toMatchObject({ id: 0x110, bus: 'platform', data: [1, 2, 3, 4, 5, 6, 7, 8], timestamp: 1.5 });
  });
});
