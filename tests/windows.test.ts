import { describe, it, expect } from 'vitest';
import { DEFS } from '@/defs';
import { evaluateWindow } from '@/services/windows';
import { seriesOf } from '@/state/ring';

const series = (pts: [number, number][]) => seriesOf(pts.map(([time, value]) => ({ time, value })));

describe('D-079 window entry evaluation', () => {
  const w3 = DEFS.windows.find((w) => w.key === 'W3_WARM_IDLE')!;

  it('qualifies warm idle after min_duration of all conditions holding', () => {
    const h = new Map([
      ['DID.COOLANT_TEMP', series([[0, 85], [30, 86]])],
      ['DID.VEHICLE_SPEED', series([[0, 0], [30, 0]])],
      ['DID.ENGINE_SPEED', series([[0, 900], [5, 1300], [30, 1320]])],
    ]);
    const s = evaluateWindow(DEFS, w3, h, 30);
    expect(s.conditionsHold).toBe(true);
    expect(s.heldForSec).toBeCloseTo(25);
    expect(s.qualified).toBe(true);
    expect(evaluateWindow(DEFS, w3, h, 20).qualified).toBe(false);
  });

  it('falls back to the republished platform signal when no DID answer was seen', () => {
    const h = new Map([['VehicleEngine.COOLANT_TEMP', series([[0, 50]])]]);
    const s = evaluateWindow(DEFS, w3, h, 1);
    expect(s.conditions[0].input.note).toBe('via VehicleEngine.COOLANT_TEMP');
    expect(s.conditions[0].holds).toBe(false);
  });

  it('reports derived inputs as not observable and event-only windows as not evaluated', () => {
    const w4 = DEFS.windows.find((w) => w.key === 'W4_CRUISE')!;
    expect(evaluateWindow(DEFS, w4, new Map(), 0).conditions[0].holds).toBeNull();
    const w2 = DEFS.windows.find((w) => w.key === 'W2_CRANK')!;
    expect(evaluateWindow(DEFS, w2, new Map(), 0).conditionsHold).toBeNull();
  });
});
