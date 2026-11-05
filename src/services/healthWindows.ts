import type { Defs } from '../defs/model';

/**
 * D-079 window instances as vehicle-server stores them in
 * `report.derived_summary.health_windows`. This module only parses that block; it never
 * recomputes a window and never invents times or signal facts.
 */

export interface HealthWindowInstance {
  startMs: number;
  endMs: number;
  durationMs: number;
  closeReason: string;
  qualifies: boolean;
  firstQualifying: boolean;
}

export interface HealthWindowInstances {
  key: string;
  qualifyingCount: number;
  instances: HealthWindowInstance[];
  /** The key is not in the bundled defs (defs mismatch); kept, never dropped. */
  unknownInDefs: boolean;
}

export type HealthWindowsResult =
  | {
      ok: true;
      rule: string;
      t0DeviceMs: number;
      windows: HealthWindowInstances[];
    }
  | { ok: false; reason: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

const malformed = (what: string): HealthWindowsResult => ({ ok: false, reason: `malformed: ${what}` });

function parseInstance(value: unknown, where: string): HealthWindowInstance | string {
  if (!isRecord(value)) return `${where} is not an object`;
  const { start_ms, end_ms, duration_ms, close_reason, qualifies, first_qualifying } = value;
  if (!isInteger(start_ms)) return `${where}.start_ms is not an integer`;
  if (!isInteger(end_ms)) return `${where}.end_ms is not an integer`;
  if (end_ms < start_ms) return `${where}.end_ms is before start_ms`;
  if (!isInteger(duration_ms)) return `${where}.duration_ms is not an integer`;
  if (typeof close_reason !== 'string') return `${where}.close_reason is not a string`;
  if (typeof qualifies !== 'boolean') return `${where}.qualifies is not a boolean`;
  if (typeof first_qualifying !== 'boolean') return `${where}.first_qualifying is not a boolean`;
  return {
    startMs: start_ms,
    endMs: end_ms,
    durationMs: duration_ms,
    closeReason: close_reason,
    qualifies,
    firstQualifying: first_qualifying,
  };
}

/** Parses the report block defensively. A missing block is `not in report`, never a guess. */
export function parseHealthWindows(report: unknown, defs: Pick<Defs, 'windows'>): HealthWindowsResult {
  if (!isRecord(report) || !isRecord(report.derived_summary)) return { ok: false, reason: 'not in report' };
  const block = report.derived_summary.health_windows;
  if (block === undefined) return { ok: false, reason: 'not in report' };
  if (!isRecord(block)) return malformed('derived_summary.health_windows is not an object');

  if (typeof block.rule !== 'string') return malformed('rule is not a string');
  if (!isInteger(block.t0_device_ms)) return malformed('t0_device_ms is not an integer');
  if (!isRecord(block.windows)) return malformed('windows is not an object');

  const known = new Set(defs.windows.map((window) => window.key));
  const windows: HealthWindowInstances[] = [];
  for (const [key, value] of Object.entries(block.windows)) {
    const where = `windows.${key}`;
    if (!isRecord(value)) return malformed(`${where} is not an object`);
    if (!isInteger(value.qualifying_count) || value.qualifying_count < 0) {
      return malformed(`${where}.qualifying_count is not a non-negative integer`);
    }
    if (!Array.isArray(value.instances)) return malformed(`${where}.instances is not an array`);

    const instances: HealthWindowInstance[] = [];
    for (let index = 0; index < value.instances.length; index += 1) {
      const instance = parseInstance(value.instances[index], `${where}.instances[${index}]`);
      if (typeof instance === 'string') return malformed(instance);
      instances.push(instance);
    }
    windows.push({
      key,
      qualifyingCount: value.qualifying_count,
      instances,
      unknownInDefs: !known.has(key),
    });
  }

  return { ok: true, rule: block.rule, t0DeviceMs: block.t0_device_ms, windows };
}
