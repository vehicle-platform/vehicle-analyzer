import { describe, expect, it } from 'vitest';
import { DEFS } from '@/defs';
import {
  applySession,
  buildCoverage,
  coverageToCsv,
  defsStatusText,
  enumValuesText,
  sessionText,
  summarize,
  waitingFor,
  type CoverageRow,
} from '@/services/coverage';

describe('buildCoverage', () => {
  const rows = buildCoverage(DEFS);

  it('has one row per defs value in each group', () => {
    expect(rows.filter((row) => row.group === 'polled_did')).toHaveLength(DEFS.vehicle.dids.length);
    expect(rows.filter((row) => row.group === 'catalog_candidate')).toHaveLength(DEFS.catalog.filter((entry) => entry.status === 'candidate').length);
    expect(rows.filter((row) => row.group === 'identification')).toHaveLength(DEFS.identification.length);
    expect(rows.filter((row) => row.group === 'sensor')).toHaveLength(DEFS.sensors.length);
    expect(rows.filter((row) => row.group === 'derived')).toHaveLength(DEFS.derivedSignals.length);
    expect(rows).toHaveLength(
      DEFS.vehicle.dids.length +
        DEFS.catalog.filter((entry) => entry.status === 'candidate').length +
        DEFS.identification.length +
        DEFS.sensors.length +
        DEFS.derivedSignals.length
    );
  });

  it('puts known defs names in the right group', () => {
    expect(rows.find((row) => row.name === 'ENGINE_SPEED')?.group).toBe('polled_did');
    expect(rows.find((row) => row.name === DEFS.identification[0].name)?.group).toBe('identification');
    expect(rows.find((row) => row.name === DEFS.sensors[0].name)?.group).toBe('sensor');
    expect(rows.find((row) => row.name === 'gear_estimate')?.group).toBe('derived');
  });

  it('keeps the raw defs facts in defsStatus', () => {
    const rpm = rows.find((row) => row.name === 'ENGINE_SPEED')!;
    expect(rpm.defsStatus).toMatchObject({ kind: 'polled_did', verified: true });
    const candidate = rows.find((row) => row.group === 'catalog_candidate')!;
    expect(candidate.defsStatus).toEqual({ kind: 'catalog', polled: false });
    const sensor = rows.find((row) => row.group === 'sensor')!;
    expect(sensor.defsStatus.kind).toBe('sensor');
    const derived = rows.find((row) => row.name === 'gear_estimate')!;
    expect(derived.defsStatus.kind).toBe('derived');
    expect(derived.class).toBe('A');
  });
});

describe('waitingFor', () => {
  const rows = buildCoverage(DEFS);
  const find = (predicate: (row: CoverageRow) => boolean) => rows.find(predicate)!;

  it('uses the fixed defs labels only', () => {
    expect(waitingFor(find((row) => row.group === 'polled_did' && row.defsStatus.kind === 'polled_did' && !row.defsStatus.verified))).toEqual([
      'verification on the bike (G1, D-068)',
    ]);
    expect(waitingFor(find((row) => row.group === 'catalog_candidate'))).toEqual(['catalog only, not polled (D-066)']);
    expect(waitingFor(find((row) => row.group === 'identification'))).toEqual(['catalog only']);
    const noPhase0: CoverageRow = {
      ...find((row) => row.group === 'sensor'),
      defsStatus: { kind: 'sensor', phase0: null, rtCore: null },
    };
    expect(waitingFor(noPhase0)).toEqual(['no Phase 0 source (defs)']);
    const pending = find((row) => row.group === 'derived' && row.defsStatus.kind === 'derived' && row.defsStatus.pendingInputs.length > 0);
    expect(waitingFor(pending)).toEqual(pending.defsStatus.kind === 'derived' ? pending.defsStatus.pendingInputs : []);
  });

  it('says nothing for a verified polled DID or a sensor with a Phase 0 source', () => {
    expect(waitingFor(find((row) => row.group === 'polled_did' && row.defsStatus.kind === 'polled_did' && row.defsStatus.verified))).toEqual([]);
    expect(waitingFor(find((row) => row.group === 'sensor' && row.defsStatus.kind === 'sensor' && row.defsStatus.phase0 !== null))).toEqual([]);
  });
});

describe('applySession', () => {
  const rows = buildCoverage(DEFS);
  const polled = DEFS.vehicle.dids[0];
  const sensorImu = DEFS.sensors.find((sensor) => sensor.phase0?.startsWith('ble.imuBlock.'))!;
  const sensorGps = DEFS.sensors.find((sensor) => sensor.phase0?.startsWith('ble.gpsBlock.'))!;
  const classA = DEFS.derivedSignals.find((signal) => signal.class === 'A' && signal.pendingInputs.length === 0)!;
  const classB = DEFS.derivedSignals.find((signal) => signal.class === 'B' && signal.record !== undefined)!;

  const report = {
    valid_ratios: { [polled.name.toLowerCase()]: { total_count: 10, valid_count: 9, valid_percent: 90 } },
    imu: { sample_count: 1 },
    gps: null,
    can_health: { max_tec: 0 },
    tester_stats: { step_gap_max_ms: 1 },
    derived: { signals: { [classA.name]: { status: 'not_implemented', reason: 'no formula' } } },
    derived_summary: { records: { [classB.record!]: { signals: { [classB.name]: { status: 'missing_inputs', missing: ['did.X'] } } } } },
  };

  it('does not guess a report block for sources without a one-to-one block', () => {
    const telemetry = DEFS.sensors.find((sensor) => sensor.phase0?.startsWith('ble.telemetry.'));
    if (telemetry === undefined) return;
    expect(applySession(rows, report).find((row) => row.name === telemetry.name)?.session).toEqual({ status: 'not in report', detail: '' });
  });

  it('reads the report keys the server provides', () => {
    const next = applySession(rows, report);
    expect(next.find((row) => row.name === polled.name)?.session).toEqual({ status: 'valid', detail: '90%' });
    expect(next.find((row) => row.name === sensorImu.name)?.session).toEqual({ status: 'present', detail: '' });
    expect(next.find((row) => row.name === sensorGps.name)?.session).toEqual({ status: 'absent', detail: '' });
    expect(next.find((row) => row.name === classA.name)?.session).toEqual({ status: 'not_implemented', detail: 'no formula' });
    expect(next.find((row) => row.name === classB.name)?.session).toEqual({ status: 'missing_inputs', detail: 'did.X' });
  });

  it('says no samples when the DID has no report samples', () => {
    const next = applySession(rows, { valid_ratios: { [polled.name.toLowerCase()]: { total_count: 0, valid_count: 0, valid_percent: 0 } } });
    expect(next.find((row) => row.name === polled.name)?.session).toEqual({ status: 'no samples', detail: '' });
  });

  it('keeps an unknown server status verbatim', () => {
    const next = applySession(rows, { derived: { signals: { [classA.name]: { status: 'vendor_weird', reason: 'from the server' } } } });
    expect(next.find((row) => row.name === classA.name)?.session).toEqual({ status: 'vendor_weird', detail: 'from the server' });
  });

  it('says not in report for a missing block or entry', () => {
    const next = applySession(rows, {});
    expect(next.every((row) => row.session?.status === 'not in report')).toBe(true);
    const missingEntry = applySession(rows, { derived: { signals: {} }, derived_summary: { records: {} } });
    expect(missingEntry.find((row) => row.name === classA.name)?.session?.status).toBe('not in report');
    expect(missingEntry.find((row) => row.name === classB.name)?.session?.status).toBe('not in report');
  });

  it('does not throw on a non-object report', () => {
    expect(applySession(rows, null).every((row) => row.session?.status === 'not in report')).toBe(true);
    expect(applySession(rows, 'nope').every((row) => row.session?.status === 'not in report')).toBe(true);
  });
});

describe('summarize and CSV', () => {
  const rows = buildCoverage(DEFS);

  it('counts every group from the rows', () => {
    const summary = summarize(rows);
    expect(summary.total).toBe(rows.length);
    expect(summary.groups.polled_did).toBe(DEFS.vehicle.dids.length);
    expect(summary.groups.catalog_candidate).toBe(DEFS.catalog.filter((entry) => entry.status === 'candidate').length);
    expect(summary.groups.identification).toBe(DEFS.identification.length);
    expect(summary.groups.sensor).toBe(DEFS.sensors.length);
    expect(summary.groups.derived).toBe(DEFS.derivedSignals.length);
    expect(summary.classes.A).toBe(DEFS.derivedSignals.filter((signal) => signal.class === 'A').length);
    expect(Object.values(summary.defsStatuses).reduce((sum, n) => sum + n, 0)).toBe(rows.length);
  });

  it('exports exactly the rows it is given', () => {
    const visible = rows.slice(0, 3);
    const csv = coverageToCsv(visible);
    const lines = csv.split('\n');
    expect(lines).toHaveLength(visible.length + 1);
    expect(lines[0]).toBe('Group,Name,ID,Class,Unit,Defs status,Waiting for,Session');
    for (const row of visible) expect(csv).toContain(row.name);
    expect(csv).not.toContain(rows[3].name);
  });

  it('formats the raw defs status and the session cell', () => {
    const polled = rows.find((row) => row.name === 'ENGINE_SPEED')!;
    expect(defsStatusText(polled)).toContain('verified');
    const next = applySession([polled], { valid_ratios: { engine_speed: { total_count: 1, valid_count: 1, valid_percent: 100 } } })[0];
    expect(sessionText(next)).toBe('valid (100%)');
  });
});

describe('enum values (defs v0.25.0)', () => {
  it('parses the named codes of the enum signals and shows them in the defs facts', () => {
    const clutch = DEFS.derivedSignals.find((s) => s.name === 'clutch_state')!;
    expect(clutch.values).toEqual({ 0: 'engaged', 1: 'disengaged', 2: 'slipping' });
    expect(DEFS.derivedSignals.find((s) => s.name === 'gear_estimate')!.values).toEqual({ 0: 'no_gear' });
    expect(DEFS.derivedSignals.find((s) => s.name === 'vehicle_accel')!.values).toBeUndefined();
    const row = buildCoverage(DEFS).find((r) => r.name === 'neutral_coasting_state')!;
    expect(defsStatusText(row)).toContain('values: 0 driven, 1 neutral, 2 coasting');
    expect(enumValuesText({ 2: 'b', 0: 'a' })).toBe('0 a, 2 b');
  });
});
