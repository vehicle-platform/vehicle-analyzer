import { describe, it, expect } from 'vitest';
import { exportOscilloscopeCsv } from '@/services/mathChannels';

describe('exportOscilloscopeCsv', () => {
  it('aligns channels on the union of timestamps with sample-and-hold', () => {
    const csv = exportOscilloscopeCsv([
      { name: 'a', label: 'A', unit: 'rpm', data: [{ time: 1, value: 3000 }, { time: 2, value: 3500 }] },
      { name: 'b', label: 'B', unit: 'km/h', data: [{ time: 1, value: 45 }, { time: 2.5, value: 55 }] },
    ]);
    expect(csv.trim().split('\n')).toEqual(['Time_s,"A (rpm)","B (km/h)"', '1.000,3000,45', '2.000,3500,45', '2.500,3500,55']);
  });
});
