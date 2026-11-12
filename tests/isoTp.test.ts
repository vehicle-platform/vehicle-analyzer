import { describe, it, expect } from 'vitest';
import { IsoTpReassembler } from '@/services/isoTp';

const ID = 0x18daf110;

describe('IsoTpReassembler', () => {
  it('passes a Single Frame through', () => {
    const r = new IsoTpReassembler();
    const res = r.processFrame(ID, [0x04, 0x62, 0xf4, 0x0c, 0x1f, 0xaa, 0xaa, 0xaa], 0);
    expect(res).toMatchObject({ type: 'SF', isComplete: true, reassembledPayload: [0x62, 0xf4, 0x0c, 0x1f] });
  });

  it('reassembles First + Consecutive Frames and reports completion once', () => {
    const done: number[][] = [];
    const r = new IsoTpReassembler((_, p) => done.push(p));
    r.processFrame(ID, [0x10, 0x0e, 1, 2, 3, 4, 5, 6], 0);
    expect(r.processFrame(ID, [0x21, 7, 8, 9, 10, 11, 12, 13], 1).isComplete).toBe(false);
    const res = r.processFrame(ID, [0x22, 14, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa], 2);
    expect(res.isComplete).toBe(true);
    expect(res.reassembledPayload).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
    expect(done).toHaveLength(1);
  });

  it('aborts on a sequence skip and ignores the rest of that reception', () => {
    const r = new IsoTpReassembler();
    r.processFrame(ID, [0x10, 0x14, 1, 2, 3, 4, 5, 6], 0);
    expect(r.processFrame(ID, [0x22, 0, 0, 0, 0, 0, 0, 0], 1).aborted).toMatch(/sequence/);
    expect(r.processFrame(ID, [0x23, 0, 0, 0, 0, 0, 0, 0], 2)).toEqual({ type: 'CF', isComplete: false });
  });

  it('aborts when the next CF exceeds N_Cr', () => {
    const r = new IsoTpReassembler(undefined, 100);
    r.processFrame(ID, [0x10, 0x0e, 1, 2, 3, 4, 5, 6], 0);
    expect(r.processFrame(ID, [0x21, 7, 8, 9, 10, 11, 12, 13], 150).aborted).toBe('N_Cr timeout');
  });

  it('rejects malformed Single Frame lengths', () => {
    const r = new IsoTpReassembler();
    expect(r.processFrame(ID, [0x00, 0, 0, 0, 0, 0, 0, 0]).isComplete).toBe(false);
    expect(r.processFrame(ID, [0x07, 1, 2]).isComplete).toBe(false);
  });
});
