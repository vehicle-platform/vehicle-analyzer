// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  MATH_OP_LABEL,
  captureBrandedSnapshot,
  computeMathChannel,
  exportOscilloscopeCsv,
  type MathChannelDef,
} from '@/services/mathChannels';
import { SeriesRing } from '@/state/ring';

function ringFrom(points: [number, number][]): SeriesRing {
  const ring = new SeriesRing(Math.max(16, points.length));
  for (const [t, v] of points) ring.push(t, v);
  return ring;
}

describe('computeMathChannel', () => {
  const base: Omit<MathChannelDef, 'op'> = {
    id: 'm1',
    label: 'M1',
    a: 'A',
    b: 'B',
    scale: 1,
    unit: 'u',
    color: '#fff',
    enabled: true,
  };

  it('computes scaled derivatives and skips gaps >= 1 s or <= 1e-6 s', () => {
    const history = new Map([
      [
        'A',
        ringFrom([
          [0.0, 10],
          [0.0, 10], // dt == 0 -> skipped
          [0.5, 20], // (20 - 10) / 0.5 = 20
          [2.0, 50], // dt == 1.5 >= 1.0 -> skipped
          [2.25, 60], // (60 - 50) / 0.25 = 40
        ]),
      ],
    ]);
    const out = computeMathChannel({ ...base, op: 'derivative', scale: 2 }, history);
    expect(out).toEqual([
      { time: 0.5, value: 40 },
      { time: 2.25, value: 80 },
    ]);
    // Respects fromTime lower bound
    const sliced = computeMathChannel({ ...base, op: 'derivative', scale: 1 }, history, 2.1);
    expect(sliced).toEqual([{ time: 2.25, value: 40 }]);
  });

  it('computes difference, product, and ratio with nearest-neighbor alignment and zero-division guard', () => {
    const history = new Map([
      [
        'A',
        ringFrom([
          [1.0, 10],
          [1.5, 20],
          [3.0, 30], // > 150 ms away from any B sample -> dropped
        ]),
      ],
      [
        'B',
        ringFrom([
          [0.95, 2],
          [1.55, 0], // zero denominator for ratio
          [2.5, 5],
        ]),
      ],
    ]);

    expect(computeMathChannel({ ...base, op: 'difference', scale: 1 }, history)).toEqual([
      { time: 1.0, value: 8 },
      { time: 1.5, value: 20 },
    ]);
    expect(computeMathChannel({ ...base, op: 'product', scale: 0.5 }, history)).toEqual([
      { time: 1.0, value: 10 },
      { time: 1.5, value: 0 },
    ]);
    expect(computeMathChannel({ ...base, op: 'ratio', scale: 1 }, history)).toEqual([
      { time: 1.0, value: 5 },
    ]);
  });

  it('returns empty series when input A or B is missing', () => {
    const history = new Map([['A', ringFrom([[1, 5]])]]);
    expect(computeMathChannel({ ...base, op: 'difference', b: undefined }, history)).toEqual([]);
    expect(computeMathChannel({ ...base, op: 'derivative', a: 'MISSING' }, history)).toEqual([]);
    expect(Object.keys(MATH_OP_LABEL)).toEqual(['derivative', 'difference', 'product', 'ratio']);
  });
});

describe('exportOscilloscopeCsv', () => {
  it('aligns channels on the union of timestamps with sample-and-hold and respects bounds', () => {
    expect(exportOscilloscopeCsv([])).toBe('Time_s\n');

    const csv = exportOscilloscopeCsv([
      { name: 'a', label: 'A', unit: 'rpm', data: [{ time: 1, value: 3000 }, { time: 2, value: 3500 }] },
      { name: 'b', label: 'B', unit: 'km/h', data: [{ time: 1, value: 45 }, { time: 2.5, value: 55 }] },
    ]);
    expect(csv.trim().split('\n')).toEqual([
      'Time_s,"A (rpm)","B (km/h)"',
      '1.000,3000,45',
      '2.000,3500,45',
      '2.500,3500,55',
    ]);

    const windowed = exportOscilloscopeCsv(
      [{ name: 'a', label: 'A', unit: 'V', data: [{ time: 0.5, value: 12 }, { time: 1.5, value: 13 }, { time: 2.5, value: 14 }] }],
      1.0,
      2.0
    );
    expect(windowed.trim().split('\n')).toEqual(['Time_s,"A (V)"', '1.500,13']);
  });
});

describe('captureBrandedSnapshot', () => {
  it('falls back to original canvas data URL when 2D context is unavailable', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const toDataURL = vi.spyOn(canvas, 'toDataURL').mockReturnValue('data:image/png;base64,orig');
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'canvas') {
        vi.spyOn(el as HTMLCanvasElement, 'getContext').mockReturnValue(null);
      }
      return el;
    }) as typeof document.createElement);

    const out = captureBrandedSnapshot(canvas, { activeChannelsCount: 2, timeWindowSec: 10 });
    expect(out).toBe('data:image/png;base64,orig');
    expect(toDataURL).toHaveBeenCalledWith('image/png');
    vi.restoreAllMocks();
  });

  it('draws watermark banner and footer onto offscreen canvas when 2D context exists', () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 320;
    const ctx = {
      drawImage: vi.fn(),
      fillRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      fillText: vi.fn(),
      fillStyle: '',
      strokeStyle: '',
      lineWidth: 0,
      font: '',
    };
    const origCreate = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      const el = origCreate(tag);
      if (tag === 'canvas') {
        vi.spyOn(el as HTMLCanvasElement, 'getContext').mockReturnValue(ctx as unknown as CanvasRenderingContext2D);
        vi.spyOn(el as HTMLCanvasElement, 'toDataURL').mockReturnValue('data:image/png;base64,branded');
      }
      return el;
    }) as typeof document.createElement);

    const out = captureBrandedSnapshot(canvas, {
      activeChannelsCount: 3,
      timeWindowSec: 30,
      platformName: 'CL250',
      footer: 'custom footer',
    });
    expect(out).toBe('data:image/png;base64,branded');
    expect(ctx.drawImage).toHaveBeenCalledWith(canvas, 0, 0);
    expect(ctx.fillText).toHaveBeenCalledWith('vehicle-analyzer oscilloscope', 14, 23);
    expect(ctx.fillText).toHaveBeenCalledWith('custom footer', 14, 314);
    vi.restoreAllMocks();
  });
});
