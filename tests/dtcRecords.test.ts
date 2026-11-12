import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFS } from '@/defs';
import { decodeDtcExtData, decodeDtcSnapshot } from '@/services/dtcRecords';

const vectors = parse(
  readFileSync(new URL('../external/vehicle-defs/tools/codegen/tests/vectors/dtc_records.yaml', import.meta.url), 'utf8')
);

const bytes = (text: string): number[] => {
  const clean = text.replace(/\s/g, '');
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
};

const hex = (data: number[]): string => data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');

// The vector file uses the Python decoder's snake_case keys.
const snapshotRecord = (record: any) => ({
  recordNumber: record.record_number,
  numberOfIdentifiers: record.number_of_identifiers,
  values: record.values.map((value: any) => ({ ...value, data: bytes(value.data) })),
});

describe('D-090 freeze-frame vectors from the pinned defs', () => {
  it('finds vectors in every section of the file', () => {
    for (const section of [vectors.snapshot, vectors.ext_data, vectors.invalid]) expect(section.length).toBeGreaterThan(0);
  });

  for (const vector of vectors.snapshot) {
    it(`snapshot: ${vector.name}`, () => {
      const { records, ...rest } = vector.expect;
      const expected = { ...rest, records: records.map(snapshotRecord) };
      const actual = decodeDtcSnapshot(DEFS, bytes(vector.response));
      expect({ ...actual, rest: hex(actual.rest) }).toEqual(expected);
    });
  }

  for (const vector of vectors.ext_data) {
    it(`extended data: ${vector.name}`, () => {
      const { first_record_number, first_record_kind, ...rest } = vector.expect;
      const actual = decodeDtcExtData(DEFS, bytes(vector.response));
      expect({ ...actual, rest: hex(actual.rest) }).toEqual({ ...rest, firstRecordNumber: first_record_number, firstRecordKind: first_record_kind });
    });
  }

  for (const vector of vectors.invalid) {
    it(`rejects ${vector.decoder}: ${vector.response}`, () => {
      const decode = vector.decoder === 'snapshot' ? decodeDtcSnapshot : decodeDtcExtData;
      expect(() => decode(DEFS, bytes(vector.response))).toThrow();
    });
  }
});
