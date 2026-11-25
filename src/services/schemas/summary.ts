import { z } from 'zod';
import { bool, finite, formatIssues, nonEmptyStr, nullableFinite, nullableStr, parseStrict, str, strList } from './restCommon';

/** Wire schemas of GET /sessions/{id}/summary and GET /rides (vehicle-server ride_summary.py). */

export type RideSummaryStatus = 'computed' | 'not_ready' | 'not_implemented' | 'missing_inputs' | 'error';
export type RideSummaryRange = [number, number];

const NOT_COMPUTED = ['not_ready', 'not_implemented', 'missing_inputs', 'error'] as const;
const FINITE_RANGE = 'is not a finite range';

const RangeSchema = z
  .tuple([finite, finite], { error: FINITE_RANGE })
  .refine(([lo, hi]) => lo <= hi, { error: FINITE_RANGE });

const AxisSchema = z
  .object({ input: nonEmptyStr, unit: str, edges: z.array(RangeSchema, { error: 'is not a list of finite ranges' }).min(1, { error: 'is not a list of finite ranges' }) })
  .transform((a): RideSummaryAxis => a);
export type RideSummaryAxis = { input: string; unit: string; edges: RideSummaryRange[] };

const CellSchema = z.object({
  index: z.number({ error: 'is not a non-negative integer' }).int({ error: 'is not a non-negative integer' }).min(0, { error: 'is not a non-negative integer' }),
  axes: z.array(z.number({ error: 'does not match the axes' }).int({ error: 'does not match the axes' }).min(0, { error: 'does not match the axes' }), { error: 'does not match the axes' }),
  value: nullableFinite,
  flag: nullableStr,
});
export type RideSummaryCell = z.output<typeof CellSchema>;

const Computed = { name: nonEmptyStr, status: z.literal('computed'), unit: str, range: RangeSchema };

const ScalarSchema = z.object({ ...Computed, kind: z.literal('scalar'), value: nullableFinite, flag: nullableStr });
export type RideSummaryScalar = z.output<typeof ScalarSchema>;

const BinnedSchema = z
  .object({
    ...Computed,
    kind: z.literal('binned'),
    axes: z.array(AxisSchema, { error: 'is not a non-empty list' }).min(1, { error: 'is not a non-empty list' }),
    cells: z.array(CellSchema, { error: 'is not a list' }),
    total_s: finite,
    outside_s: finite,
    defs_mismatch: bool.optional(),
  })
  .superRefine((s, ctx) => {
    for (const [i, cell] of s.cells.entries()) {
      if (cell.axes.length !== s.axes.length) {
        ctx.addIssue({ code: 'custom', path: ['cells', i, 'axes'], message: 'does not match the axes' });
        continue;
      }
      if (cell.axes.some((bin, a) => bin >= s.axes[a].edges.length)) {
        ctx.addIssue({ code: 'custom', path: ['cells', i, 'axes'], message: 'has an out-of-range bin' });
      }
    }
  })
  .transform((s) => ({
    name: s.name,
    status: s.status,
    kind: s.kind,
    unit: s.unit,
    range: s.range,
    axes: s.axes,
    cells: s.cells,
    totalS: s.total_s,
    outsideS: s.outside_s,
    defsMismatch: s.defs_mismatch === true,
  }));
export type RideSummaryBinned = z.output<typeof BinnedSchema>;

/** The server's `gears` list (gear = stored cell + 1, so >= 1, each once). */
const GearEntrySchema = z.object(
  {
    gear: z.number({ error: 'is not a positive integer' }).int({ error: 'is not a positive integer' }).min(1, { error: 'is not a positive integer' }),
    value: nullableFinite,
    flag: nullableStr,
  },
  { error: 'is not an object' }
);
const GearsSchema = z.object({
  gears: z.array(GearEntrySchema, { error: 'is not a list' }).superRefine((gears, ctx) => {
    const seen = new Set<number>();
    for (const [i, g] of gears.entries()) {
      if (seen.has(g.gear)) ctx.addIssue({ code: 'custom', path: [i, 'gear'], message: `${g.gear} is repeated` });
      seen.add(g.gear);
    }
  }),
});
export interface PerGearValue {
  gear: number;
  value: number | null;
  flag: string | null;
}

const PerGearHeaderSchema = z.object({ ...Computed, kind: z.literal('per_gear'), gears: z.unknown() });
export type PerGearSummary = {
  name: string;
  status: 'computed';
  kind: 'per_gear';
  unit: string;
  range: RideSummaryRange;
  gears: PerGearValue[];
};

const UnavailableSchema = z
  .object({
    name: nonEmptyStr,
    status: z.enum(NOT_COMPUTED),
    reason: str.optional(),
    message: str.optional(),
    pending_inputs: strList.optional(),
    missing: strList.optional(),
  })
  .transform(({ pending_inputs, ...rest }) => ({ ...rest, ...(pending_inputs === undefined ? {} : { pendingInputs: pending_inputs }) }));
export type RideSummaryUnavailable = z.output<typeof UnavailableSchema>;

export type RideSummarySignal = RideSummaryScalar | RideSummaryBinned | PerGearSummary | RideSummaryUnavailable;

const SignalHeaderSchema = z.object({
  name: nonEmptyStr,
  status: z.enum(['computed', ...NOT_COMPUTED], { error: 'is an unknown status' }),
  kind: z.unknown().optional(),
});

/** Dispatches on status/kind so each variant keeps its own precise messages. */
const SignalSchema = z.unknown().transform((raw, ctx): RideSummarySignal => {
  const fail = (error: z.ZodError): typeof z.NEVER => {
    for (const issue of error.issues) ctx.addIssue({ code: 'custom', path: [...issue.path], message: issue.message });
    return z.NEVER;
  };
  const head = SignalHeaderSchema.safeParse(raw);
  if (!head.success) return fail(head.error);
  if (head.data.status !== 'computed') {
    const r = UnavailableSchema.safeParse(raw);
    return r.success ? r.data : fail(r.error);
  }
  switch (head.data.kind) {
    case 'scalar': {
      const r = ScalarSchema.safeParse(raw);
      return r.success ? r.data : fail(r.error);
    }
    case 'binned': {
      const r = BinnedSchema.safeParse(raw);
      return r.success ? r.data : fail(r.error);
    }
    case 'per_gear': {
      const h = PerGearHeaderSchema.safeParse(raw);
      if (!h.success) return fail(h.error);
      // A malformed gear list costs only this signal: one error row, not a failed card.
      const gears = GearsSchema.safeParse({ gears: h.data.gears });
      if (!gears.success) {
        return { name: h.data.name, status: 'error', message: `malformed per_gear: ${formatIssues(gears.error)[0]}` };
      }
      return { name: h.data.name, status: 'computed', kind: 'per_gear', unit: h.data.unit, range: h.data.range, gears: gears.data.gears };
    }
    default:
      ctx.addIssue({ code: 'custom', path: ['kind'], message: 'is neither scalar, binned nor per_gear' });
      return z.NEVER;
  }
});

export const RideSummarySchema = z
  .object({
    session_id: nonEmptyStr,
    ride_definition: nullableStr,
    defs_version: nullableStr,
    signals: z.array(SignalSchema, { error: 'is not a list' }),
  })
  .transform((s) => ({ sessionId: s.session_id, rideDefinition: s.ride_definition, defsVersion: s.defs_version, signals: s.signals }));
export type RideSummary = z.output<typeof RideSummarySchema>;

/** Strict parser: a partial or inconsistent summary is rejected (RestSchemaError) instead of drawn wrongly. */
export function parseRideSummary(json: unknown): RideSummary {
  return parseStrict(RideSummarySchema, json, 'ride summary');
}

// ------------------------------------------------------------------ GET /rides

const ColumnSchema = z.object({ name: nonEmptyStr, unit: str });
export type RidesColumn = z.output<typeof ColumnSchema>;

const RideRowWireSchema = z.object({
  session_id: nonEmptyStr,
  created_utc: nullableStr,
  values: z.record(z.string(), z.unknown(), { error: 'is not an object' }),
  flags: z.record(z.string(), z.unknown(), { error: 'is not an object' }),
});

export interface RidesRow {
  sessionId: string;
  createdUtc: string | null;
  values: Record<string, number | null>;
  flags: Record<string, string | null>;
}

export interface RidesResponse {
  columns: RidesColumn[];
  rows: RidesRow[];
  skipped: number;
}

/** Every cell must belong to a returned column and be null or finite (value) / null or a string (flag). */
export const RidesResponseSchema = z
  .object({
    columns: z.array(ColumnSchema, { error: 'is not a list' }),
    rows: z.array(RideRowWireSchema, { error: 'is not a list' }),
    skipped: z.number({ error: 'is not a non-negative integer' }).int({ error: 'is not a non-negative integer' }).min(0, { error: 'is not a non-negative integer' }),
  })
  .transform((raw, ctx): RidesResponse => {
    const seen = new Set<string>();
    for (const [i, c] of raw.columns.entries()) {
      if (seen.has(c.name)) ctx.addIssue({ code: 'custom', path: ['columns', i], message: `duplicate column ${c.name}` });
      seen.add(c.name);
    }
    const rows: RidesRow[] = [];
    for (const [i, row] of raw.rows.entries()) {
      const values: Record<string, number | null> = {};
      const flags: Record<string, string | null> = {};
      for (const { name } of raw.columns) {
        const value = row.values[name];
        if (value !== null && !(typeof value === 'number' && Number.isFinite(value))) {
          ctx.addIssue({ code: 'custom', path: ['rows', i, 'values', name], message: 'is not null or a finite number' });
        }
        const flag = row.flags[name];
        if (flag !== null && typeof flag !== 'string') {
          ctx.addIssue({ code: 'custom', path: ['rows', i, 'flags', name], message: 'is not null or a string' });
        }
        values[name] = value as number | null;
        flags[name] = flag as string | null;
      }
      rows.push({ sessionId: row.session_id, createdUtc: row.created_utc, values, flags });
    }
    return { columns: raw.columns, rows, skipped: raw.skipped };
  });

export function parseRidesResponse(json: unknown): RidesResponse {
  return parseStrict(RidesResponseSchema, json, 'rides response');
}
