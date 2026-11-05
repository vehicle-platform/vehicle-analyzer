import { describe, expect, it } from 'vitest';
import { DEFS } from '../src/defs';
import { parseHealthWindows } from '../src/services/healthWindows';

const instance = {
  start_ms: 3_000,
  end_ms: 30_000,
  duration_ms: 27_000,
  close_reason: 'condition',
  qualifies: true,
  first_qualifying: true,
};

const report = {
  derived_summary: {
    health_windows: {
      rule: 'provisional: Claude’s reading of D-079',
      t0_device_ms: 1_000,
      windows: {
        W3_WARM_IDLE: { qualifying_count: 1, instances: [instance] },
        W1_KEY_ON: { qualifying_count: 0, instances: [] },
        W99_UNKNOWN: {
          qualifying_count: 1,
          instances: [{ ...instance, qualifies: false, first_qualifying: false }],
        },
      },
    },
  },
};

describe('parseHealthWindows', () => {
  it('parses the block, keeping report order and unknown keys', () => {
    const parsed = parseHealthWindows(report, DEFS);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.rule).toBe('provisional: Claude’s reading of D-079');
    expect(parsed.t0DeviceMs).toBe(1_000);
    expect(parsed.windows.map((window) => window.key)).toEqual(['W3_WARM_IDLE', 'W1_KEY_ON', 'W99_UNKNOWN']);
    expect(parsed.windows[0]).toMatchObject({ qualifyingCount: 1, unknownInDefs: false });
    expect(parsed.windows[0].instances[0]).toEqual({
      startMs: 3_000,
      endMs: 30_000,
      durationMs: 27_000,
      closeReason: 'condition',
      qualifies: true,
      firstQualifying: true,
    });
    expect(parsed.windows[1].instances).toEqual([]);
    expect(parsed.windows[2].unknownInDefs).toBe(true);
  });

  it('says not in report when the block or derived_summary is missing', () => {
    expect(parseHealthWindows(null, DEFS)).toEqual({ ok: false, reason: 'not in report' });
    expect(parseHealthWindows({}, DEFS)).toEqual({ ok: false, reason: 'not in report' });
    expect(parseHealthWindows({ derived_summary: { records: {} } }, DEFS)).toEqual({ ok: false, reason: 'not in report' });
  });

  it('rejects malformed fields instead of guessing', () => {
    const bad = (health_windows: unknown) => parseHealthWindows({ derived_summary: { health_windows } }, DEFS);

    expect(bad({ rule: 'r', t0_device_ms: '1', windows: {} })).toEqual({ ok: false, reason: 'malformed: t0_device_ms is not an integer' });
    expect(bad({ rule: 'r', t0_device_ms: 0, windows: [] })).toEqual({ ok: false, reason: 'malformed: windows is not an object' });
    expect(
      bad({ rule: 'r', t0_device_ms: 0, windows: { W3_WARM_IDLE: { qualifying_count: 1, instances: [{ ...instance, end_ms: 2_000 }] } } })
    ).toEqual({ ok: false, reason: 'malformed: windows.W3_WARM_IDLE.instances[0].end_ms is before start_ms' });
    expect(
      bad({ rule: 'r', t0_device_ms: 0, windows: { W3_WARM_IDLE: { qualifying_count: 1, instances: [{ ...instance, start_ms: 1.5 }] } } })
    ).toEqual({ ok: false, reason: 'malformed: windows.W3_WARM_IDLE.instances[0].start_ms is not an integer' });
    expect(
      bad({ rule: 'r', t0_device_ms: 0, windows: { W3_WARM_IDLE: { qualifying_count: 1, instances: [{ ...instance, qualifies: 'yes' }] } } })
    ).toEqual({ ok: false, reason: 'malformed: windows.W3_WARM_IDLE.instances[0].qualifies is not a boolean' });
  });
});
