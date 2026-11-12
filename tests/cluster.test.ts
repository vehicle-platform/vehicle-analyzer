import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFS } from '@/defs';
import { READOUTS, ClusterInput, clusterInput, evaluateReadout, readoutSpec, staleLimitMs } from '@/services/cluster';
import { CaptureStore } from '@/state/captureStore';
import { formatSignal } from '@/services/format';
import type { CanFrame, DbcMessageDef } from '@/types/can';

const catalog = DEFS.platform.messages;

/** A frame of `msg` at time `t` seconds with the given decoded (physical) signals. */
function frame(msg: DbcMessageDef, t: number, sigs: Record<string, number>, periodMs = 0): CanFrame {
  return { id: msg.id, idHex: '', bus: 'platform', dlc: 8, data: [], timestamp: t, deltaMs: 0, isExtended: false, periodMs, frequencyHz: 0, count: 1, name: msg.name, decodedSignals: sigs };
}

function input(over: Partial<ClusterInput> & { frames?: CanFrame[] } = {}): ClusterInput {
  const frames = over.frames ?? [];
  return {
    catalog,
    frameOf: (id) => frames.find((f) => f.id === id),
    dids: DEFS.vehicle.dids,
    didSample: () => undefined,
    now: 0,
    ...over,
  };
}

const msgOf = (name: string) => catalog.find((m) => m.name === name)!;

describe('cluster readouts against the pinned defs', () => {
  it('only references messages, signals and validity signals that exist', () => {
    for (const spec of READOUTS) {
      const msg = catalog.find((m) => m.name === spec.message);
      expect(msg, `${spec.message} missing`).toBeDefined();
      const sig = msg!.signals.find((s) => s.name === spec.signal);
      expect(sig, `${spec.message}.${spec.signal} missing`).toBeDefined();
      if (spec.kind === 'enum') expect(sig!.values, `${spec.signal} has no value table`).toBeDefined();
      if (spec.valid) {
        const v = msg!.signals.find((s) => s.name === spec.valid!.signal);
        expect(v, `${spec.valid.signal} missing`).toBeDefined();
        if (spec.valid.when !== 'nonzero') {
          const names = Object.values(v!.values ?? {});
          for (const n of spec.valid.when) expect(names).toContain(n);
        }
      }
    }
  });

  it('has a cycle time for every message it needs staleness for', () => {
    for (const spec of READOUTS) expect(msgOf(spec.message).cycleTimeMs, spec.message).toBeGreaterThan(0);
  });

  it('shows no gear readout', () => {
    expect(READOUTS.some((r) => /gear/i.test(r.signal))).toBe(false);
  });
});

describe('readout state', () => {
  const eng = msgOf('VehicleEngine');
  const rpm = readoutSpec('rpm');
  const sigs = { ENGINE_SPEED: 3000, ENGINE_SPEED_VALID: 1 };

  it('ok with the DBC range and unit', () => {
    const r = evaluateReadout(rpm, input({ frames: [frame(eng, 10, sigs)], now: 10.04 }));
    expect(r.state).toBe('ok');
    expect(r.value).toBe(3000);
    expect(r.unit).toBe('rpm');
    expect(r.min).toBe(0);
    expect(r.max).toBeCloseTo(16383.75);
    expect(r.source).toBe('platform');
  });

  it('invalid when the validity signal says so', () => {
    const r = evaluateReadout(rpm, input({ frames: [frame(eng, 10, { ...sigs, ENGINE_SPEED_VALID: 0 })], now: 10 }));
    expect(r.state).toBe('invalid');
    expect(r.note).toContain('ENGINE_SPEED_VALID');
  });

  it('lean is invalid unless the state is ESTIMATED or CLAMPED', () => {
    const lean = msgOf('EkfLean');
    const spec = readoutSpec('lean');
    const stateSig = lean.signals.find((s) => s.name === 'LEAN_ANGLE_STATE')!;
    const raw = (name: string) => Number(Object.entries(stateSig.values!).find(([, n]) => n === name)![0]);
    const mk = (state: string) => evaluateReadout(spec, input({ frames: [{ ...frame(lean, 1, { LEAN_ANGLE: 12.5, LEAN_ANGLE_STATE: raw(state) }), e2e: 'OK' }], now: 1 }));
    expect(mk('ESTIMATED').state).toBe('ok');
    expect(mk('CLAMPED').state).toBe('ok');
    expect(mk('INVALID').state).toBe('invalid');
    expect(formatSignal(stateSig, raw('INVALID'))).toBe('INVALID');
  });

  it('stale after 3 x the cycle time, still ok just inside it', () => {
    const cycle = eng.cycleTimeMs!;
    expect(staleLimitMs(eng, frame(eng, 0, {}))).toBe(3 * cycle);
    const f = frame(eng, 10, sigs);
    expect(evaluateReadout(rpm, input({ frames: [f], now: 10 + (3 * cycle - 1) / 1000 })).state).toBe('ok');
    const stale = evaluateReadout(rpm, input({ frames: [f], now: 10 + (3 * cycle + 1) / 1000 }));
    expect(stale.state).toBe('stale');
    expect(stale.value).toBe(3000);
  });

  it('falls back to the observed period when the DBC has no cycle time', () => {
    const noCycle: DbcMessageDef = { ...eng, cycleTimeMs: undefined };
    const f = frame(noCycle, 5, sigs, 20);
    expect(staleLimitMs(noCycle, f)).toBe(60);
    expect(staleLimitMs(noCycle, frame(noCycle, 5, sigs, 0))).toBeNull();
    const cat = catalog.map((m) => (m.id === eng.id ? noCycle : m));
    expect(evaluateReadout(rpm, input({ catalog: cat, frames: [f], now: 5.05 })).state).toBe('ok');
    expect(evaluateReadout(rpm, input({ catalog: cat, frames: [f], now: 5.07 })).state).toBe('stale');
  });

  it('no_data without a frame', () => {
    expect(evaluateReadout(rpm, input()).state).toBe('no_data');
  });

  it('not_in_defs when the message, the signal or the validity signal is missing', () => {
    const noMsg = catalog.filter((m) => m.name !== 'VehicleEngine');
    expect(evaluateReadout(rpm, input({ catalog: noMsg })).state).toBe('not_in_defs');
    const noSig = catalog.map((m) => (m.name === 'VehicleEngine' ? { ...m, signals: m.signals.filter((s) => s.name !== 'ENGINE_SPEED') } : m));
    const r = evaluateReadout(rpm, input({ catalog: noSig, frames: [frame(eng, 1, sigs)], now: 1 }));
    expect(r.state).toBe('not_in_defs');
    expect(r.min).toBeNull();
    const noValid = catalog.map((m) => (m.name === 'VehicleEngine' ? { ...m, signals: m.signals.filter((s) => s.name !== 'ENGINE_SPEED_VALID') } : m));
    expect(evaluateReadout(rpm, input({ catalog: noValid })).state).toBe('not_in_defs');
  });

  it('enum readouts use the value-table name', () => {
    const warn = msgOf('SafetyWarningStatus');
    const spec = readoutSpec('cornering');
    const sig = warn.signals.find((s) => s.name === 'CORNERING_LEVEL')!;
    const yellow = Number(Object.entries(sig.values!).find(([, n]) => n === 'YELLOW')![0]);
    const r = evaluateReadout(spec, input({ frames: [{ ...frame(warn, 2, { CORNERING_LEVEL: yellow }), e2e: 'OK' }], now: 2 }));
    expect(r.text).toBe('YELLOW');
    expect(r.state).toBe('ok');
  });

  it('an E2E-protected frame that failed its check is invalid, not ok', () => {
    const warn = msgOf('SafetyWarningStatus');
    const r = evaluateReadout(readoutSpec('cornering'), input({ frames: [{ ...frame(warn, 2, { CORNERING_LEVEL: 1 }), e2e: 'WRONG_CRC' }], now: 2 }));
    expect(r.state).toBe('invalid');
  });
});

describe('DID fallback', () => {
  const eng = msgOf('VehicleEngine');
  const rpm = readoutSpec('rpm');
  const did = DEFS.vehicle.dids.find((d) => d.platformSignal === 'VehicleEngine.ENGINE_SPEED')!;

  it('maps a DID by platformSignal', () => {
    expect(did.name).toBe('ENGINE_SPEED');
  });

  it('uses a fresh DID when the platform frame is absent', () => {
    const r = evaluateReadout(rpm, input({ didSample: (n) => (n === did.name ? { value: 2500, t: 9.9 } : undefined), now: 10 }));
    expect(r.state).toBe('ok');
    expect(r.value).toBe(2500);
    expect(r.source).toBe(`DID ${did.name}`);
  });

  it('ignores a DID older than its staleAfterMs', () => {
    const r = evaluateReadout(rpm, input({ didSample: () => ({ value: 2500, t: 10 - (did.staleAfterMs + 1) / 1000 }), now: 10 }));
    expect(r.state).toBe('no_data');
    expect(r.source).toBe('platform');
  });

  it('prefers a fresh platform frame over the DID', () => {
    const r = evaluateReadout(rpm, input({ frames: [frame(eng, 10, { ENGINE_SPEED: 3000, ENGINE_SPEED_VALID: 1 })], didSample: () => ({ value: 2500, t: 10 }), now: 10 }));
    expect(r.value).toBe(3000);
    expect(r.source).toBe('platform');
  });

  it('a stale platform frame yields to a fresh DID, otherwise it stays stale', () => {
    const f = frame(eng, 1, { ENGINE_SPEED: 3000, ENGINE_SPEED_VALID: 1 });
    expect(evaluateReadout(rpm, input({ frames: [f], didSample: () => ({ value: 2500, t: 10 }), now: 10 })).source).toBe(`DID ${did.name}`);
    expect(evaluateReadout(rpm, input({ frames: [f], now: 10 })).state).toBe('stale');
  });
});

describe('cluster source clock', () => {
  afterEach(() => vi.restoreAllMocks());

  const store = (lastTime: number, lastIngestWallMs: number) =>
    ({
      pipeline: { catalog: () => catalog },
      framesByKey: new Map(),
      defs: DEFS,
      monitor: { getDid: () => undefined },
      lastTime,
      lastIngestWallMs,
    }) as unknown as CaptureStore;

  it('advances with the wall clock while live, so a silent source goes stale', () => {
    vi.spyOn(performance, 'now').mockReturnValue(15_000);
    expect(clusterInput(store(100, 10_000), 1).now).toBeCloseTo(105);
  });

  it('scales with the replay speed and freezes when paused', () => {
    vi.spyOn(performance, 'now').mockReturnValue(15_000);
    expect(clusterInput(store(100, 10_000), 2).now).toBeCloseTo(110);
    expect(clusterInput(store(100, 10_000), 0).now).toBe(100);
  });

  it('does not advance before the first frame', () => {
    vi.spyOn(performance, 'now').mockReturnValue(15_000);
    expect(clusterInput(store(0, 0), 1).now).toBe(0);
  });
});

describe('cluster cornering colours', () => {
  it('uses only names of the CORNERING_LEVEL value table', () => {
    const sig = catalog.find((m) => m.name === 'SafetyWarningStatus')?.signals.find((x) => x.name === 'CORNERING_LEVEL');
    const names = Object.values(sig?.values ?? {});
    for (const n of ['GREEN', 'YELLOW', 'RED']) expect(names).toContain(n);
  });
});
