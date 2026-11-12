import { describe, it, expect } from 'vitest';
import { DEFS } from '@/defs';
import { VirtualCanBus } from '@/services/virtualBus';
import { UdsMonitor } from '@/services/udsMonitor';
import { FramePipeline } from '@/services/pipeline';
import type { CanFrame } from '@/types/can';

function run(seconds: number) {
  const bus = new VirtualCanBus(DEFS);
  const frames: CanFrame[] = [];
  bus.start = () => undefined; // drive ticks by hand
  (bus as any).onFrame = (f: CanFrame) => frames.push(f);
  for (let i = 0; i < seconds * 100; i++) bus.tick();
  return { bus, frames };
}

describe('virtual bus against the defs', () => {
  const { frames } = run(70);
  const pipeline = new FramePipeline(DEFS.platform.messages, DEFS.vehicleDbc.messages);
  const monitor = new UdsMonitor(DEFS);
  const processed = frames.map((f) => pipeline.process(f));
  processed.filter((f) => f.bus === 'vehicle').forEach((f) => monitor.process(f));

  it('sends every periodic platform message at its DBC cycle time', () => {
    for (const msg of DEFS.platform.messages.filter((m) => m.cycleTimeMs)) {
      const ts = processed.filter((f) => f.bus === 'platform' && f.id === msg.id).map((f) => f.timestamp);
      expect(ts.length, msg.name).toBeGreaterThan(10);
      const period = ((ts[ts.length - 1] - ts[0]) / (ts.length - 1)) * 1000;
      expect(period, msg.name).toBeCloseTo(msg.cycleTimeMs!, 0);
    }
  });

  it('protects platform messages with valid E2E', () => {
    for (const s of pipeline.getE2EStats()) {
      expect(s.counts.WRONG_CRC ?? 0, s.name).toBe(0);
      expect(s.counts.WRONG_SEQUENCE ?? 0, s.name).toBe(0);
      expect(s.counts.OK ?? 0, s.name).toBeGreaterThan(5);
    }
  });

  it('runs a UDS conversation the passive monitor decodes, within tester_policy', () => {
    expect(monitor.getAlerts()).toEqual([]);
    const rpm = monitor.getDid('ENGINE_SPEED')!;
    expect(rpm.count).toBeGreaterThan(50);
    expect(typeof rpm.value).toBe('number');
    expect(monitor.getDid('COOLANT_TEMP')!.unit).toBe('degC');
    const unverified = DEFS.vehicle.dids.find((d) => !d.verified)!;
    expect(monitor.getDid(unverified.name)!.nrc).toBe(0x31);
    expect(monitor.getTransactions().filter((t) => t.status === 'no_response')).toEqual([]);
    // The start of the conversation (the 400-entry log of the long run has rotated it out).
    const early = new UdsMonitor(DEFS);
    run(3).frames.filter((f) => f.bus === 'vehicle').forEach((f) => early.process(f));
    const tx = early.getTransactions();
    expect(tx[0]).toMatchObject({ sid: 0x10, status: 'positive' });
    expect(tx[0].summary).toMatch(/EXTENDED.*P2=50 ms, P2\*=5000 ms/);
    expect(tx.some((t) => t.sid === 0x3e && t.status === 'suppressed')).toBe(true);
    expect(tx.some((t) => t.sid === 0x19 && t.summary.includes('no DTC'))).toBe(true);
    expect(monitor.getDtcs()).toEqual([]);
  });

  it('republishes DID values on VehicleEngine consistently', () => {
    const eng = processed.filter((f) => f.name === 'VehicleEngine' && f.decodedSignals!.ENGINE_SPEED_VALID === 1);
    expect(eng.length).toBeGreaterThan(100);
    const last = eng[eng.length - 1].decodedSignals!;
    expect(Math.abs((last.ENGINE_SPEED as number) - (monitor.getDid('ENGINE_SPEED')!.value as number))).toBeLessThan(400);
  });

  it('refuses composer requests outside the policy', () => {
    const bus = new VirtualCanBus(DEFS);
    expect(bus.injectTesterRequest([0x14, 0xff, 0xff, 0xff]).ok).toBe(false);
    expect(bus.injectTesterRequest([0x10, 0x02]).ok).toBe(false);
    expect(bus.injectTesterRequest([0x22, 0xf4, 0x0c]).ok).toBe(true);
  });
});

import { exportToVectorAsc } from '@/services/exportService';
import { parseVectorAsc } from '@/services/logParser';

describe('record and replay', () => {
  it('round-trips a simulated capture through Vector ASC with the same decoding and E2E', () => {
    const { frames } = run(5);
    const back = parseVectorAsc(exportToVectorAsc(frames));
    expect(back).toHaveLength(frames.length);
    const p1 = new FramePipeline(DEFS.platform.messages, []);
    const p2 = new FramePipeline(DEFS.platform.messages, []);
    frames.forEach((f, i) => {
      const a = p1.process(f);
      const b = p2.process(back[i]);
      expect(b.bus).toBe(a.bus);
      expect(b.decodedSignals).toEqual(a.decodedSignals);
      expect(b.e2e).toBe(a.e2e);
    });
  });
});
