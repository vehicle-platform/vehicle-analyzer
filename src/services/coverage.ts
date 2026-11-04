import type { Defs, DerivedClass } from '../defs/model';

/**
 * Signal coverage: one row per value the pinned vehicle-defs defines (invariant 2).
 * The rows are built from the parsed defs only; the optional session cell is read
 * from a vehicle-server report. Nothing here computes readiness or a verdict.
 */

export type CoverageGroup = 'polled_did' | 'catalog_candidate' | 'identification' | 'sensor' | 'derived';

export interface PolledDidDefsStatus {
  kind: 'polled_did';
  verified: boolean;
  pollPeriodMs: number;
}

export interface CatalogDefsStatus {
  kind: 'catalog';
  polled: false;
}

export interface SensorDefsStatus {
  kind: 'sensor';
  phase0: string | null;
  rtCore: string | null;
}

export interface DerivedDefsStatus {
  kind: 'derived';
  pendingInputs: string[];
  inputs: string[];
  window?: string;
  record?: string;
}

export type CoverageDefsStatus = PolledDidDefsStatus | CatalogDefsStatus | SensorDefsStatus | DerivedDefsStatus;

/** A cell read from a report; `status` is a server status or a fixed report-derived label. */
export interface CoverageSessionCell {
  status: string;
  detail: string;
}

export interface CoverageRow {
  group: CoverageGroup;
  name: string;
  /** DID in hex where the value has one, else ''. */
  id: string;
  class?: DerivedClass;
  unit: string;
  description: string;
  defsStatus: CoverageDefsStatus;
  session: CoverageSessionCell | null;
}

export interface CoverageSummary {
  total: number;
  groups: Record<CoverageGroup, number>;
  classes: Record<string, number>;
  defsStatuses: Record<string, number>;
  sessionStatuses: Record<string, number>;
}

const GROUPS: readonly CoverageGroup[] = ['polled_did', 'catalog_candidate', 'identification', 'sensor', 'derived'];

const didHex = (did: number): string => `0x${did.toString(16).toUpperCase().padStart(4, '0')}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

/** Builds one row per polled DID, catalog candidate, identification DID, sensor and derived signal. */
export function buildCoverage(defs: Defs): CoverageRow[] {
  const rows: CoverageRow[] = [];

  for (const did of defs.vehicle.dids) {
    rows.push({
      group: 'polled_did',
      name: did.name,
      id: didHex(did.did),
      unit: did.unit,
      description: did.description,
      defsStatus: { kind: 'polled_did', verified: did.verified, pollPeriodMs: did.pollPeriodMs },
      session: null,
    });
  }

  for (const entry of defs.catalog) {
    if (entry.status !== 'candidate') continue;
    rows.push({
      group: 'catalog_candidate',
      name: entry.name,
      id: didHex(entry.did),
      unit: entry.unit,
      description: entry.description,
      defsStatus: { kind: 'catalog', polled: false },
      session: null,
    });
  }

  for (const entry of defs.identification) {
    rows.push({
      group: 'identification',
      name: entry.name,
      id: didHex(entry.did),
      unit: '',
      description: entry.description,
      defsStatus: { kind: 'catalog', polled: false },
      session: null,
    });
  }

  for (const sensor of defs.sensors) {
    rows.push({
      group: 'sensor',
      name: sensor.name,
      id: '',
      unit: sensor.unit,
      description: sensor.description,
      defsStatus: { kind: 'sensor', phase0: sensor.phase0, rtCore: sensor.rtCore },
      session: null,
    });
  }

  for (const signal of defs.derivedSignals) {
    rows.push({
      group: 'derived',
      name: signal.name,
      id: '',
      class: signal.class,
      unit: signal.unit,
      description: signal.description,
      defsStatus: {
        kind: 'derived',
        pendingInputs: signal.pendingInputs,
        inputs: signal.inputs,
        window: signal.window,
        record: signal.record,
      },
      session: null,
    });
  }

  return rows;
}

/** Fixed, defs-only labels for what a value waits for. Nothing else is inferred. */
export function waitingFor(row: CoverageRow): string[] {
  switch (row.group) {
    case 'polled_did':
      return row.defsStatus.kind === 'polled_did' && !row.defsStatus.verified ? ['verification on the bike (G1, D-068)'] : [];
    case 'catalog_candidate':
      return ['catalog only, not polled (D-066)'];
    case 'identification':
      return ['catalog only'];
    case 'sensor':
      return row.defsStatus.kind === 'sensor' && row.defsStatus.phase0 === null ? ['no Phase 0 source (defs)'] : [];
    case 'derived':
      return row.defsStatus.kind === 'derived' ? [...row.defsStatus.pendingInputs] : [];
  }
}

/** Short category of the waiting-for list, for the view filter. */
export function waitingCategory(row: CoverageRow): string {
  switch (row.group) {
    case 'polled_did':
      return waitingFor(row).length > 0 ? 'verification' : 'none';
    case 'catalog_candidate':
      return 'catalog only';
    case 'identification':
      return 'catalog only';
    case 'sensor':
      return waitingFor(row).length > 0 ? 'no Phase 0 source' : 'none';
    case 'derived':
      return waitingFor(row).length > 0 ? 'pending inputs' : 'none';
  }
}

/** Short defs-status text, built only from the raw YAML fields. */
export function defsStatusText(row: CoverageRow): string {
  const status = row.defsStatus;
  switch (status.kind) {
    case 'polled_did':
      return `${status.verified ? 'verified' : 'not verified'} · poll ${status.pollPeriodMs} ms`;
    case 'catalog':
      return 'catalog only';
    case 'sensor':
      return `Phase 0: ${status.phase0 ?? 'none'} · rt-core: ${status.rtCore ?? 'none'}`;
    case 'derived': {
      const parts = [`class ${row.class ?? ''}`, `inputs: ${status.inputs.join(', ') || 'none'}`];
      if (status.window !== undefined) parts.push(`window: ${status.window}`);
      if (status.record !== undefined) parts.push(`record: ${status.record}`);
      return parts.join(' · ');
    }
  }
}

/**
 * Report keys used for the sensor presence cell (from vehicle_server/report.py):
 * `imu` covers ble.imuBlock.*, `gps` covers ble.gpsBlock.*, `can_health` carries the
 * telemetry CAN counters (canTxErrorCount, canRxErrorCount, canBusOffCount,
 * unansweredDidCount) and `tester_stats` carries rttMaxMs, rttNrc78Count and
 * stepGapMaxMs. ble.telemetry.leanAngle is deprecated and has no summary block here.
 */
function sensorReportKey(phase0: string | null): string | null {
  if (phase0 === null) return null;
  if (phase0.startsWith('ble.imuBlock.')) return 'imu';
  if (phase0.startsWith('ble.gpsBlock.')) return 'gps';
  if (phase0.startsWith('ble.telemetry.')) {
    const field = phase0.slice('ble.telemetry.'.length);
    if (['canTxErrorCount', 'canRxErrorCount', 'canBusOffCount', 'unansweredDidCount'].includes(field)) return 'can_health';
    if (['rttMaxMs', 'rttNrc78Count', 'stepGapMaxMs'].includes(field)) return 'tester_stats';
  }
  return null;
}

const NOT_IN_REPORT: CoverageSessionCell = { status: 'not in report', detail: '' };

function entryCell(entry: unknown): CoverageSessionCell {
  if (!isRecord(entry) || typeof entry.status !== 'string') return NOT_IN_REPORT;
  const reason = typeof entry.reason === 'string' ? entry.reason : '';
  const missing = stringList(entry.missing);
  const message = typeof entry.message === 'string' ? entry.message : '';
  return { status: entry.status, detail: reason || (missing ? missing.join(', ') : '') || message };
}

/** Adds the per-row session cell from a `GET /sessions/{id}/report` JSON. Never throws. */
export function applySession(rows: CoverageRow[], report: unknown): CoverageRow[] {
  const root = isRecord(report) ? report : {};
  const validRatios = isRecord(root.valid_ratios) ? root.valid_ratios : null;
  const derived = isRecord(root.derived) && isRecord(root.derived.signals) ? root.derived.signals : null;
  const summaryRecords = isRecord(root.derived_summary) && isRecord(root.derived_summary.records) ? root.derived_summary.records : null;

  const cellFor = (row: CoverageRow): CoverageSessionCell => {
    if (row.group === 'polled_did') {
      const ratio = validRatios?.[row.name.toLowerCase()];
      if (!isRecord(ratio)) return NOT_IN_REPORT;
      if (ratio.total_count === 0) return { status: 'no samples', detail: '' };
      if (!isFiniteNumber(ratio.valid_percent)) return NOT_IN_REPORT;
      return { status: 'valid', detail: `${Math.round(ratio.valid_percent * 10) / 10}%` };
    }
    if (row.group === 'sensor') {
      const key = row.defsStatus.kind === 'sensor' ? sensorReportKey(row.defsStatus.phase0) : null;
      if (key === null || !(key in root)) return NOT_IN_REPORT;
      return { status: root[key] === null || root[key] === undefined ? 'absent' : 'present', detail: '' };
    }
    if (row.group === 'derived') {
      if (row.class === 'A') return entryCell(derived?.[row.name]);
      if (row.class === 'B') {
        const record = row.defsStatus.kind === 'derived' ? row.defsStatus.record : undefined;
        const signals = record !== undefined && isRecord(summaryRecords?.[record]) ? summaryRecords?.[record] : undefined;
        return entryCell(isRecord(signals) && isRecord(signals.signals) ? signals.signals[row.name] : undefined);
      }
      return NOT_IN_REPORT;
    }
    return NOT_IN_REPORT;
  };

  return rows.map((row) => ({ ...row, session: cellFor(row) }));
}

/** Display text of a session cell; '' when no report row applies. */
export function sessionText(row: CoverageRow): string {
  if (row.session === null) return '';
  return row.session.detail === '' ? row.session.status : `${row.session.status} (${row.session.detail})`;
}

/** Counts for the header chips; every count comes from the rows. */
export function summarize(rows: CoverageRow[]): CoverageSummary {
  const groups = Object.fromEntries(GROUPS.map((group) => [group, 0])) as Record<CoverageGroup, number>;
  const classes: Record<string, number> = {};
  const defsStatuses: Record<string, number> = {};
  const sessionStatuses: Record<string, number> = {};
  for (const row of rows) {
    groups[row.group] += 1;
    if (row.class !== undefined) classes[row.class] = (classes[row.class] ?? 0) + 1;
    const defsLabel = defsStatusLabel(row);
    defsStatuses[defsLabel] = (defsStatuses[defsLabel] ?? 0) + 1;
    if (row.session !== null) {
      sessionStatuses[row.session.status] = (sessionStatuses[row.session.status] ?? 0) + 1;
    }
  }
  return { total: rows.length, groups, classes, defsStatuses, sessionStatuses };
}

/** Fixed short label used by the defs-status chip counts. */
export function defsStatusLabel(row: CoverageRow): string {
  switch (row.group) {
    case 'polled_did':
      return row.defsStatus.kind === 'polled_did' && row.defsStatus.verified ? 'verified' : 'not verified';
    case 'catalog_candidate':
    case 'identification':
      return 'catalog only';
    case 'sensor':
      return row.defsStatus.kind === 'sensor' && row.defsStatus.phase0 === null ? 'no Phase 0 source' : 'Phase 0 source';
    case 'derived':
      return row.defsStatus.kind === 'derived' && row.defsStatus.pendingInputs.length > 0 ? 'pending inputs' : 'no pending inputs';
  }
}

const csvCell = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);

/** CSV of exactly the rows passed in (the view exports the visible rows). */
export function coverageToCsv(rows: CoverageRow[]): string {
  const headers = ['Group', 'Name', 'ID', 'Class', 'Unit', 'Defs status', 'Waiting for', 'Session'];
  const lines = [headers.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        row.group,
        row.name,
        row.id,
        row.class ?? '',
        row.unit,
        defsStatusText(row),
        waitingFor(row).join('; '),
        sessionText(row),
      ]
        .map(csvCell)
        .join(',')
    );
  }
  return lines.join('\n');
}
