import { z } from 'zod';

/**
 * WEB-3: shared pieces of the vehicle-server REST schemas (sessions, series, track, summary,
 * rides, bring-up, report). Every message is a predicate ("is not a finite number") so an issue
 * reads as `<path> <message>`; the first issue becomes the `RestSchemaError` message.
 *
 * Convention (same as the stream schemas): objects strip unknown keys, so a newer server that
 * adds a field never breaks the analyzer; a list that can fail item by item is parsed item by
 * item, the bad items are dropped and counted.
 */

/** A response that does not match its schema. `issues` lists every problem, `message` the first. */
export class RestSchemaError extends Error {
  constructor(
    readonly endpoint: string,
    readonly issues: readonly string[]
  ) {
    super(`Malformed ${endpoint}: ${issues[0] ?? 'unknown problem'}.`);
    this.name = 'RestSchemaError';
  }
}

export const isRecord = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);

export const str = z.string({ error: 'is not a string' });
export const nonEmptyStr = z.string({ error: 'is not a string' }).min(1, { error: 'is empty' });
export const finite = z.number({ error: 'is not a finite number' });
export const nullableFinite = z.number({ error: 'is not null or a finite number' }).nullable();
export const nullableStr = z.string({ error: 'is not null or a string' }).nullable();
export const strList = z.array(str, { error: 'is not a list of strings' });
export const bool = z.boolean({ error: 'is not a boolean' });

/** `rows[2].values.x` style path; the root is "root". */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = '';
  for (const key of path) out += typeof key === 'number' ? `[${key}]` : out === '' ? String(key) : `.${String(key)}`;
  return out === '' ? 'root' : out;
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => `${formatPath(issue.path)} ${issue.message}`);
}

/** `safeParse` at the boundary: returns the parsed value or throws a typed `RestSchemaError`. */
export function parseStrict<S extends z.ZodType>(schema: S, json: unknown, endpoint: string): z.output<S> {
  const result = schema.safeParse(json);
  if (!result.success) throw new RestSchemaError(endpoint, formatIssues(result.error));
  return result.data;
}

/** Item-by-item parse of a list: the valid items and how many were dropped. */
export function parseItems<S extends z.ZodType>(schema: S, items: readonly unknown[]): { items: z.output<S>[]; rejected: number } {
  const out: z.output<S>[] = [];
  let rejected = 0;
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) out.push(result.data);
    else rejected++;
  }
  return { items: out, rejected };
}
