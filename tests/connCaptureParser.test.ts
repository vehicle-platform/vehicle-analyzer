import { describe, expect, it } from 'vitest';
import { parseConnCapture } from '../src/services/connCaptureParser';

const BANNER = '# vehicle-connectivity-node CAN capture: TWAI listen-only, 500 kbps, accept-all.';
const CLEAN = [
  BANNER,
  '# F,<t_us>,<id hex>,<S|X>,<dlc>,<data hex> | S,... summary every 10 s | FINAL,... at 300 s',
  'F,1000000,100,S,2,AABB',
  'F,2000000,200,S,1,01',
  'F,3000000,00000123,X,1,7F',
  'S,10000000,100,S,2,0.500,1.500,-',
  'S,10000000,200,S,1,-,-,-',
  'S,10000000,00000123,X,1,-,-,-',
  'S,END,10000000,frames=3,ids=3,overflow=0,lost=0,dropped=0',
].join('\n');

describe('parseConnCapture', () => {
  it('parses a clean capture on the vehicle bus', () => {
    const { frames, summary } = parseConnCapture(CLEAN);

    expect(frames).toHaveLength(3);
    expect(frames.map((f) => [f.id, f.isExtended, f.bus, f.timestamp, f.dlc, f.data])).toEqual([
      [0x100, false, 'vehicle', 1, 2, [0xaa, 0xbb]],
      [0x200, false, 'vehicle', 2, 1, [0x01]],
      [0x123, true, 'vehicle', 3, 1, [0x7f]],
    ]);
    expect(frames[2].idHex).toBe('0x00000123');
    expect(summary).toMatchObject({
      bannerSeen: true,
      frames: 3,
      skippedLines: 0,
      malformedFrames: 0,
      restarts: 0,
      durationS: 2,
      block: {
        final: false,
        rows: [
          { id: 0x100, extended: false, count: 2, minGapMs: 0.5, maxGapMs: 1.5, watched: false },
          { id: 0x200, extended: false, count: 1, minGapMs: null, maxGapMs: null, watched: false },
          { id: 0x123, extended: true, count: 1, minGapMs: null, maxGapMs: null, watched: false },
        ],
        end: { frames: 3, ids: 3, overflow: 0, lost: 0, dropped: 0 },
      },
    });
  });

  it('accepts CRLF line endings', () => {
    const { frames, summary } = parseConnCapture(CLEAN.replace(/\n/g, '\r\n'));
    expect(frames).toHaveLength(3);
    expect(summary.bannerSeen).toBe(true);
    expect(summary.skippedLines).toBe(0);
  });

  it('counts noise and a truncated frame, and still sees the banner', () => {
    const text = [
      'ets Jul 29 2019 12:21:46',
      BANNER,
      'F,1000000,100,S,1,00',
      'F,2000000,100,S,1,',
    ].join('\n');
    const { frames, summary } = parseConnCapture(text);
    expect(frames).toHaveLength(1);
    expect(summary.bannerSeen).toBe(true);
    expect(summary.skippedLines).toBe(1);
    expect(summary.malformedFrames).toBe(1);
  });

  it.each([
    ['a negative timestamp', 'F,-1,100,S,1,00'],
    ['a fractional timestamp', 'F,1.5,100,S,1,00'],
    ['a standard id above 0x7FF', 'F,1,800,S,1,00'],
    ['an extended id above 0x1FFFFFFF', 'F,1,20000000,X,1,00'],
    ['a DLC above 8', 'F,1,100,S,9,000000000000000000'],
    ['a data length that does not match the DLC', 'F,1,100,S,2,AA'],
    ['non-hex data', 'F,1,100,S,1,GG'],
    ['missing fields', 'F,1,100,S,1'],
  ])('drops %s as a malformed frame', (_name, line) => {
    const { frames, summary } = parseConnCapture(line);
    expect(frames).toHaveLength(0);
    expect(summary.malformedFrames).toBe(1);
    expect(summary.skippedLines).toBe(0);
  });

  it('keeps the last complete block when the last one is truncated', () => {
    const text = [
      'F,1000000,100,S,1,00',
      'S,10000000,100,S,1,-,-,-',
      'S,END,10000000,frames=1,ids=1,overflow=0,lost=0,dropped=0',
      'S,20000000,100,S,1,-,-,-',
    ].join('\n');
    const { summary } = parseConnCapture(text);
    expect(summary.block).toMatchObject({
      final: false,
      rows: [{ id: 0x100, count: 1 }],
      end: { frames: 1, ids: 1, overflow: 0, lost: 0, dropped: 0 },
    });
  });

  it('keeps a complete FINAL block', () => {
    const text = [
      'F,1000000,100,S,1,00',
      'FINAL,300000000,100,S,1,-,-,-',
      'FINAL,END,300000000,frames=1,ids=1,overflow=0,lost=0,dropped=0',
    ].join('\n');
    const { summary } = parseConnCapture(text);
    expect(summary.block).toMatchObject({
      final: true,
      rows: [{ id: 0x100, count: 1 }],
      end: { frames: 1, ids: 1, overflow: 0, lost: 0, dropped: 0 },
    });
  });

  it('marks a watched summary row', () => {
    const text = ['F,1000000,100,S,1,00', 'S,10000000,100,S,1,-,-,W', 'S,END,10000000,frames=1,ids=1,overflow=0,lost=0,dropped=0'].join(
      '\n'
    );
    const { summary } = parseConnCapture(text);
    expect(summary.block?.rows[0].watched).toBe(true);
  });

  it('offsets frames after a node restart so timestamps stay monotonic', () => {
    const text = [
      'F,5000000,100,S,1,00',
      'F,6000000,100,S,1,00',
      'F,0,100,S,1,00',
      'F,100000,100,S,1,00',
    ].join('\n');
    const { frames, summary } = parseConnCapture(text);
    expect(summary.restarts).toBe(1);
    expect(frames.map((f) => f.timestamp)).toEqual([5, 6, 6.000001, 6.100001]);
    for (let i = 1; i < frames.length; i++) expect(frames[i].timestamp).toBeGreaterThanOrEqual(frames[i - 1].timestamp);
    expect(summary.durationS).toBeCloseTo(1.100001, 6);
  });

  it('does not call a one-second backward jump a restart', () => {
    const text = ['F,5000000,100,S,1,00', 'F,4000000,100,S,1,00'].join('\n');
    const { summary } = parseConnCapture(text);
    expect(summary.restarts).toBe(0);
  });

  it('returns an empty summary for an empty file', () => {
    const { frames, summary } = parseConnCapture('');
    expect(frames).toEqual([]);
    expect(summary).toEqual({
      bannerSeen: false,
      frames: 0,
      skippedLines: 0,
      malformedFrames: 0,
      restarts: 0,
      durationS: 0,
      block: null,
    });
  });
});
