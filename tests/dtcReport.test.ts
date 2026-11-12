import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { DEFS } from '@/defs';
import { decodeDtcExtData, decodeDtcSnapshot } from '@/services/dtcRecords';
import { dtcReportToCsv, dtcReportToJson } from '@/services/dtcReport';
import { didHex } from '@/services/format';
import { formatDtc, DtcEntry } from '@/services/udsMonitor';

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
const hexDtc = (dtc: number) => `0x${dtc.toString(16).toUpperCase().padStart(6, '0')}`;
const hexStatus = (status: number) => `0x${status.toString(16).toUpperCase().padStart(2, '0')}`;
const hexDtcOf = (d: DtcEntry) => hexDtc(d.dtc);
const hexStatusOf = (d: DtcEntry) => hexStatus(d.status);

const snapshotVector = (name: string) => {
  const found = vectors.snapshot.find((v: any) => v.name === name);
  if (!found) throw new Error(`missing snapshot vector: ${name}`);
  return found;
};
const extVector = (name: string) => {
  const found = vectors.ext_data.find((v: any) => v.name === name);
  if (!found) throw new Error(`missing extended-data vector: ${name}`);
  return found;
};
const snapshotExpect = (name: string) => snapshotVector(name).expect;
const extExpect = (name: string) => extVector(name).expect;

const catalogOf = (did: number) => {
  const def = DEFS.catalogByDid.get(did);
  if (!def) throw new Error(`DID ${didHex(did)} is missing from DEFS.catalogByDid`);
  return def;
};

const statusNames = (status: number): string[] =>
  DEFS.iso.dtcStatusBits.filter((bit) => status & bit.mask).map((bit) => bit.name);

const entry = (name: string): DtcEntry => {
  const response = bytes(snapshotVector(name).response);
  const decoded = decodeDtcSnapshot(DEFS, response);
  const header = 2 + DEFS.iso.dtcRecordReports.dtcAndStatusLength;
  return {
    dtc: decoded.dtc,
    code: formatDtc(decoded.dtc),
    status: decoded.status,
    statusNames: statusNames(decoded.status),
    firstSeen: 1.25,
    lastSeen: 2.5,
    snapshot: response.slice(header),
  };
};

const extEntry = (name: string): DtcEntry => {
  const response = bytes(extVector(name).response);
  const decoded = decodeDtcExtData(DEFS, response);
  const header = 2 + DEFS.iso.dtcRecordReports.dtcAndStatusLength;
  return {
    dtc: decoded.dtc,
    code: formatDtc(decoded.dtc),
    status: decoded.status,
    statusNames: statusNames(decoded.status),
    firstSeen: 3,
    lastSeen: 4,
    extData: response.slice(header),
  };
};

describe('DTC report from the pinned defs vectors', () => {
  it('writes one JSON object per DTC with the decoded snapshot, extended data and raw bytes', () => {
    const multiExpect = snapshotExpect('undefined_number_runs_to_the_end');
    const stoppedExpect = snapshotExpect('unknown_did_stops_the_walk');
    const extendedExpect = extExpect('manufacturer_record_first');
    const multi = entry('undefined_number_runs_to_the_end');
    const stopped = entry('unknown_did_stops_the_walk');
    const extended = extEntry('manufacturer_record_first');
    const report = JSON.parse(dtcReportToJson(DEFS, [multi, stopped, extended]));

    expect(report.ref).toBe(DEFS.ref);
    expect(report.dtcs).toHaveLength(3);

    const [m, s, e] = report.dtcs;
    const [speed, fuel] = multiExpect.records[0].values;
    const fuelDef = catalogOf(fuel.did);

    expect(m.dtc).toBe(hexDtc(multiExpect.dtc));
    expect(m.code).toBe(multi.code);
    expect(m.status).toBe(multiExpect.status);
    expect(m.statusNames).toEqual(statusNames(multiExpect.status));
    expect(m.firstSeen).toBe(1.25);
    expect(m.lastSeen).toBe(2.5);
    expect(m.snapshot.stop).toBe(multiExpect.stop);
    expect(m.snapshot.rest).toEqual(bytes(multiExpect.rest));
    expect(m.snapshot.records[0].values).toMatchObject([
      {
        did: speed.did,
        name: catalogOf(speed.did).name,
        data: bytes(speed.data),
        value: speed.value,
      },
      { did: fuel.did, name: fuelDef.name, data: bytes(fuel.data), value: fuel.value },
    ]);
    expect(m.snapshotRaw).toBe('0000F40D3CF4030200');
    expect(m.extData).toBeNull();
    expect(m.extDataRaw).toBeNull();

    const stoppedValue = stoppedExpect.records[0].values[0];
    expect(s.snapshot.stop).toBe(stoppedExpect.stop);
    expect(s.snapshot.rest).toEqual(bytes(stoppedExpect.rest));
    expect(s.snapshot.records[0].values[0]).toMatchObject({
      did: stoppedValue.did,
      name: catalogOf(stoppedValue.did).name,
      data: bytes(stoppedValue.data),
      value: stoppedValue.value,
    });
    expect(s.snapshotRaw).toBe('0102F40C1F40ABCD0102');

    expect(e.snapshot).toBeNull();
    expect(e.snapshotRaw).toBeNull();
    expect(e.extData).toEqual({
      firstRecordNumber: extendedExpect.first_record_number,
      firstRecordKind: extendedExpect.first_record_kind,
      rest: bytes(extendedExpect.rest),
    });
    expect(e.extDataRaw).toBe('01AABB92CC');
  });

  it('writes a CSV row per decoded value, per multi-value field, plus stop, extended-data and bare DTC rows', () => {
    const multiExpect = snapshotExpect('undefined_number_runs_to_the_end');
    const stoppedExpect = snapshotExpect('unknown_did_stops_the_walk');
    const bareExpect = snapshotExpect('no_record_stored');
    const extendedExpect = extExpect('manufacturer_record_first');
    const multi = entry('undefined_number_runs_to_the_end');
    const stopped = entry('unknown_did_stops_the_walk');
    const bare = entry('no_record_stored');
    const extended = extEntry('manufacturer_record_first');
    const rows = dtcReportToCsv(DEFS, [multi, stopped, bare, extended]).split('\n');
    const code = formatDtc(multiExpect.dtc);
    const dtc = hexDtc(multiExpect.dtc);
    const status = hexStatus(multiExpect.status);
    const [speed, fuel] = multiExpect.records[0].values;
    const speedDef = catalogOf(speed.did);
    const fuelDef = catalogOf(fuel.did);
    const fuelRaw = hex(bytes(fuel.data));

    expect(rows[0]).toBe('dtc,code,status,record_number,did,name,field,value,unit,raw');
    expect(rows).toContain(
      `${dtc},${code},${status},${multiExpect.records[0].record_number},${didHex(speed.did)},${speedDef.name},,${speed.value},${speedDef.unit},${hex(bytes(speed.data))}`
    );
    for (const field of fuelDef.fields!) {
      const value = fuel.value[field.name];
      expect(rows).toContain(
        `${dtc},${code},${status},${multiExpect.records[0].record_number},${didHex(fuel.did)},${fuelDef.name},${field.name},${value},${field.unit},${fuelRaw}`
      );
    }
    expect(rows).toContain(
      `${hexDtc(stoppedExpect.dtc)},${formatDtc(stoppedExpect.dtc)},${hexStatus(stoppedExpect.status)},,,stop:${stoppedExpect.stop},,,,${hex(bytes(stoppedExpect.rest))}`
    );
    expect(rows).toContain(`${hexDtc(bareExpect.dtc)},${formatDtc(bareExpect.dtc)},${hexStatus(bareExpect.status)},,,,,,,`);
    expect(rows.filter((row) => row.startsWith(`${dtc},${code},${status}`) && !/,(stop|ext):/.test(row))).toHaveLength(4);
    expect(rows.filter((row) => row.includes(',ext:'))).toEqual([
      `${hexDtcOf(extended)},${extended.code},${hexStatusOf(extended)},${extendedExpect.first_record_number},,ext:${extendedExpect.first_record_kind},,,,${hex(bytes(extendedExpect.rest))}`,
    ]);
  });
});
