import { z } from 'zod';
import { nonEmptyStr, parseStrict, str, strList } from './restCommon';

/** Wire schema of GET /sessions/{id}/bringup (vehicle-server bringup.py `Result.to_dict`). */

export const BRINGUP_GATES = ['B0', 'V0', 'V1'] as const;
export type BringupGate = (typeof BRINGUP_GATES)[number];
export const BRINGUP_VERDICTS = ['pass', 'fail', 'incomplete'] as const;
export type BringupVerdict = (typeof BRINGUP_VERDICTS)[number];
export const BRINGUP_STATUSES = ['pass', 'fail', 'warn', 'manual', 'unknown'] as const;
export type BringupStatus = (typeof BRINGUP_STATUSES)[number];

const CheckSchema = z.object({
  id: nonEmptyStr,
  status: z.enum(BRINGUP_STATUSES, { error: 'is an unknown status' }),
  /** Any JSON the server measured (null, number, object); shown, never re-computed. */
  measured: z.unknown().optional().transform((v) => v ?? null),
  expected: z.string().catch(''),
  source: z.string().catch(''),
  note: z.string().catch(''),
});
export type BringupCheck = z.output<typeof CheckSchema>;

export const BringupResultSchema = z
  .object({
    session_id: str,
    gate: z.enum(BRINGUP_GATES, { error: 'is an unknown gate' }),
    verdict: z.enum(BRINGUP_VERDICTS, { error: 'is an unknown verdict' }),
    checks: z.array(CheckSchema, { error: 'is not a list' }),
    needs_you: strList,
    warnings: strList,
  })
  .transform((r) => ({
    sessionId: r.session_id,
    gate: r.gate,
    verdict: r.verdict,
    checks: r.checks,
    /** Ids of the manual checks still pending. */
    needsYou: r.needs_you,
    /** Ids of the warn checks. */
    warnings: r.warnings,
  }));
export type BringupResult = z.output<typeof BringupResultSchema>;

/** Strict parser: the verdict and every check are shown as the server sent them. */
export function parseBringupResult(json: unknown): BringupResult {
  return parseStrict(BringupResultSchema, json, 'bring-up result');
}
