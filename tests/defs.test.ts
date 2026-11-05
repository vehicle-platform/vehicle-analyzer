import { describe, it, expect } from 'vitest';
import { DEFS, decodeDid, encodeDid } from '../src/defs';

describe('pinned vehicle-defs', () => {
  it('loads the platform DBC with cycle times, E2E data IDs and value tables', () => {
    const lean = DEFS.platform.messages.find((m) => m.id === 0x020)!;
    expect(lean.name).toBe('EkfLean');
    expect(lean.cycleTimeMs).toBe(20);
    expect(lean.e2e).toEqual({ dataId: 0x1020 });
    expect(lean.signals.find((s) => s.name === 'LEAN_ANGLE_STATE')!.values).toMatchObject({ 0: 'ESTIMATED', 3: 'INVALID' });
    const eng = DEFS.platform.messages.find((m) => m.id === 0x110)!;
    expect(eng.name).toBe('VehicleEngine');
    expect(eng.e2e).toBeUndefined();
  });

  it('treats the CL250 vehicle DBC as the skeleton it is (no broadcast frames known)', () => {
    expect(DEFS.vehicleDbc.messages).toEqual([]);
  });

  it('loads UDS addressing, tester policy and DIDs', () => {
    expect(DEFS.vehicle.addressing.primary).toEqual({ requestId: 0x18da10f1, responseId: 0x18daf110, extended: true });
    expect(DEFS.vehicle.testerPolicy.forbidden).toContain(0x2e);
    const rpm = DEFS.vehicle.dids.find((d) => d.name === 'ENGINE_SPEED')!;
    expect(rpm.did).toBe(0xf40c);
    expect(rpm.platformSignal).toBe('VehicleEngine.ENGINE_SPEED');
    expect(decodeDid(rpm, [0x1f, 0x40])).toBe(2000);
    expect(encodeDid(rpm, 2000)).toEqual([0x1f, 0x40]);
    const ect = DEFS.vehicle.dids.find((d) => d.name === 'COOLANT_TEMP')!;
    expect(decodeDid(ect, encodeDid(ect, 85))).toBe(85);
  });

  it('loads the D-079 windows with their record DIDs', () => {
    expect(DEFS.windows.map((w) => w.key)).toEqual(['W1_KEY_ON', 'W2_CRANK', 'W3_WARM_IDLE', 'W4_CRUISE', 'W5_POST_STOP']);
    const w3 = DEFS.windows.find((w) => w.key === 'W3_WARM_IDLE')!;
    expect(w3.recordDid).toBe(0xfd4c);
    expect(w3.conditions).toContainEqual({ input: 'did.COOLANT_TEMP', op: 'gt', value: 80 });
  });

  it('loads ISO 14229 names, identification DIDs (no VIN) and cornering limits', () => {
    expect(DEFS.iso.nrcs.get(0x31)).toBe('REQUEST_OUT_OF_RANGE');
    expect(DEFS.identification.map((i) => i.did)).not.toContain(0xf190);
    expect(DEFS.identification.every((i) => i.description.length > 0)).toBe(true);
    expect(DEFS.limits.kYellow).toBeLessThan(DEFS.limits.kRed);
    expect(DEFS.ref).toMatch(/^v\d+\.\d+\.\d+$/);
  });

  it('loads non-DID sensors and the derived signal facts for coverage', () => {
    expect(DEFS.sensors).toHaveLength(18);
    const ax = DEFS.sensors.find((s) => s.name === 'imu_accel_x')!;
    expect(ax.phase0).toBe('ble.imuBlock.ax');
    expect(ax.rtCore).toBeNull();

    expect(DEFS.derivedSignals).toHaveLength(155);
    expect(DEFS.derivedSignals.filter((s) => s.class === 'A')).toHaveLength(66);
    expect(DEFS.derivedSignals.filter((s) => s.class === 'B')).toHaveLength(75);
    expect(DEFS.derivedSignals.filter((s) => s.class === 'C')).toHaveLength(12);
    expect(DEFS.derivedSignals.filter((s) => s.class === 'D')).toHaveLength(2);
    const gear = DEFS.derivedSignals.find((s) => s.name === 'gear_estimate')!;
    expect(gear.class).toBe('A');
    expect(gear.inputs).toContain('derived.gearbox_ratio_measured');
    const recorded = DEFS.derivedSignals.find((s) => s.record !== undefined)!;
    expect(recorded.record).toMatch(/^RIDE_/);
    const pending = DEFS.derivedSignals.find((s) => s.pendingInputs.length > 0)!;
    expect(pending.pendingInputs[0]).toMatch(/accelerometer|Q-/);
  });
});
