import { describe, it, expect } from 'vitest';
import { DEFS } from '@/defs';
import { composeUdsRequest, checkTesterPolicy, composerServices } from '@/services/udsComposer';
import { UdsMonitor, formatDtc } from '@/services/udsMonitor';
import type { CanFrame } from '@/types/can';

describe('tester policy from defs', () => {
  it('builds a padded Single Frame for ReadDataByIdentifier', () => {
    const req = composeUdsRequest(DEFS, [0x22, 0xf4, 0x0c]);
    expect(req.valid).toBe(true);
    expect(req.canFrameData).toEqual([0x03, 0x22, 0xf4, 0x0c, 0xaa, 0xaa, 0xaa, 0xaa]);
  });

  it('allows the default and extended session, refuses the programming session', () => {
    expect(checkTesterPolicy(DEFS, [0x10, 0x01]).allowed).toBe(true);
    expect(checkTesterPolicy(DEFS, [0x10, 0x03]).allowed).toBe(true);
    expect(checkTesterPolicy(DEFS, [0x10, 0x02])).toMatchObject({ allowed: false, reason: expect.stringMatching(/forbidden/) });
  });

  it('ignores the suppressPosRsp bit in sub-function checks', () => {
    expect(checkTesterPolicy(DEFS, [0x3e, 0x80]).allowed).toBe(true);
    expect(checkTesterPolicy(DEFS, [0x10, 0x82]).allowed).toBe(false);
  });

  it('requires a sub-function where the policy lists them', () => {
    expect(checkTesterPolicy(DEFS, [0x10]).allowed).toBe(false);
  });

  it('refuses every forbidden service and anything outside the allow-list', () => {
    for (const sid of DEFS.vehicle.testerPolicy.forbidden) expect(checkTesterPolicy(DEFS, [sid, 0x01]).allowed).toBe(false);
    expect(checkTesterPolicy(DEFS, [0x23, 0x00]).allowed).toBe(false);
  });

  it('refuses requests that need a First Frame (D-059)', () => {
    expect(composeUdsRequest(DEFS, [0x22, 1, 2, 3, 4, 5, 6, 7]).valid).toBe(false);
  });

  it('offers only allowed sub-functions in the composer', () => {
    const svc = composerServices(DEFS);
    expect(svc.find((s) => s.sid === 0x10)!.subFunctions!.map((s) => s.id)).toEqual([0x01, 0x03]);
    expect(svc.find((s) => s.sid === 0x2e)!.allowed).toBe(false);
  });
});

const frame = (id: number, data: number[], t: number): CanFrame => ({
  id, idHex: '', bus: 'vehicle', dlc: 8, data, timestamp: t, deltaMs: 0, isExtended: true, periodMs: 0, frequencyHz: 0, count: 1,
});

describe('UdsMonitor', () => {
  const REQ = 0x18da10f1;
  const RSP = 0x18daf110;

  it('flags a forbidden request seen on the bus', () => {
    const m = new UdsMonitor(DEFS);
    m.process(frame(REQ, [0x04, 0x14, 0xff, 0xff, 0xff, 0xaa, 0xaa, 0xaa], 0));
    expect(m.getAlerts()[0]).toMatchObject({ kind: 'policy_violation' });
  });

  it('flags a functional request (second tester, D-040)', () => {
    const m = new UdsMonitor(DEFS);
    m.process({ ...frame(0x7df, [0x02, 0x01, 0x0c, 0, 0, 0, 0, 0], 0), isExtended: false });
    expect(m.getAlerts()[0].kind).toBe('functional_request');
  });

  it('decodes a multi-frame DTC list and the status bits', () => {
    const m = new UdsMonitor(DEFS);
    m.process(frame(REQ, [0x03, 0x19, 0x02, 0x0c, 0xaa, 0xaa, 0xaa, 0xaa], 0));
    // 0x59 0x02 avail, then 2 records = 11 bytes -> FF + CF
    m.process(frame(RSP, [0x10, 0x0b, 0x59, 0x02, 0xff, 0x01, 0x15, 0x00], 0.01));
    m.process(frame(REQ, [0x30, 0x00, 0x00, 0xaa, 0xaa, 0xaa, 0xaa, 0xaa], 0.011));
    m.process(frame(RSP, [0x21, 0x08, 0xc0, 0x01, 0x88, 0x04, 0xaa, 0xaa], 0.012));
    const dtcs = m.getDtcs();
    expect(dtcs.map((d) => d.code)).toEqual(['P0115-00', 'U0001-88']);
    expect(dtcs[0].statusNames).toEqual(['CONFIRMED_DTC']);
    expect(dtcs[1].statusNames).toEqual(['PENDING_DTC']);
    expect(m.getTransactions()[0].frames.map((f) => f.pci)).toEqual(['SF', 'FF', 'FC', 'CF']);
  });

  it('names NRCs and marks unanswered requests', () => {
    const m = new UdsMonitor(DEFS);
    m.process(frame(REQ, [0x03, 0x22, 0xf4, 0x04, 0xaa, 0xaa, 0xaa, 0xaa], 0));
    m.process(frame(RSP, [0x03, 0x7f, 0x22, 0x31, 0xaa, 0xaa, 0xaa, 0xaa], 0.01));
    expect(m.getTransactions()[0].summary).toMatch(/REQUEST_OUT_OF_RANGE/);
    m.process(frame(REQ, [0x03, 0x22, 0xf4, 0x0c, 0xaa, 0xaa, 0xaa, 0xaa], 1));
    m.process(frame(REQ, [0x03, 0x22, 0xf4, 0x0d, 0xaa, 0xaa, 0xaa, 0xaa], 10));
    expect(m.getTransactions()[1].status).toBe('no_response');
  });

  it('formats DTCs as SAE J2012 text', () => {
    expect(formatDtc(0x011500)).toBe('P0115-00');
    expect(formatDtc(0xc00188)).toBe('U0001-88');
  });
});
