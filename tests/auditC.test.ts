import { describe, expect, it } from 'vitest';
import { csvCell, splitCsvLine } from '../src/services/csv';
import { exportToCsv } from '../src/services/exportService';
import { parseCanCsv, parseVectorAsc } from '../src/services/logParser';
import { logFileSizeError, MAX_LOG_FILE_BYTES } from '../src/services/importLimits';
import { isCleartextRemoteUrl } from '../src/services/cleartext';
import type { CanFrame } from '../src/types/can';

const frame = (over: Partial<CanFrame>): CanFrame => ({
  id: 0x100,
  idHex: '0x100',
  bus: 'vehicle',
  dlc: 2,
  data: [1, 2],
  timestamp: 1,
  deltaMs: 0,
  isExtended: false,
  periodMs: 0,
  frequencyHz: 0,
  count: 1,
  ...over,
});

describe('csvCell (C-1)', () => {
  it('passes plain text through', () => expect(csvCell('RPM')).toBe('RPM'));
  it('doubles quotes and quotes cells with commas or line breaks', () => {
    expect(csvCell('a"b')).toBe('"a""b"');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('a\nb')).toBe('"a\nb"');
  });
  it('neutralises leading formula characters', () => {
    for (const lead of ['=', '+', '-', '@']) expect(csvCell(`${lead}1+1`)).toBe(`'${lead}1+1`);
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('\rx')).toBe('"\'\rx"');
    expect(csvCell('=HYPERLINK("http://x","y")')).toBe('"\'=HYPERLINK(""http://x"",""y"")"');
  });
});

describe('trace CSV export and import (C-1)', () => {
  it('escapes the bus and name and round-trips through the parser', () => {
    const csv = exportToCsv([frame({ bus: '=cmd', name: 'a,"b"' })]);
    const row = csv.split('\n')[1];
    expect(row).toContain("'=cmd");
    const cells = splitCsvLine(row);
    expect(cells[2]).toBe("'=cmd");
    expect(cells[4]).toBe('a,"b"');
    const back = parseCanCsv(csv);
    expect(back).toHaveLength(1);
    expect(back[0].data).toEqual([1, 2]);
  });
});

describe('log import hardening (C-9)', () => {
  it('rejects ASC lines with a non-finite timestamp or an oversized dlc', () => {
    const asc = ['   . 1  0x100 Rx d 2 01 02', '0.1 1 0x100 Rx d 200 01 02', '0.2 1 0x100 Rx d 2 01 02'].join('\n');
    const frames = parseVectorAsc(asc);
    expect(frames).toHaveLength(1);
    expect(frames[0].timestamp).toBeCloseTo(0.2);
  });
  it('rejects CSV rows with an oversized dlc', () => {
    expect(parseCanCsv('h\n1,0,vehicle,0x100,n,65,0102,')).toHaveLength(0);
  });
  it('limits the import size with a clear message', () => {
    expect(logFileSizeError('a.asc', MAX_LOG_FILE_BYTES)).toBeNull();
    expect(logFileSizeError('a.asc', MAX_LOG_FILE_BYTES + 1)).toMatch(/a\.asc is .* MB; the import limit is 200 MB/);
  });
});

describe('cleartext warning (C-8)', () => {
  it('flags ws/http to a remote host only', () => {
    expect(isCleartextRemoteUrl('ws://192.168.1.5:8000/ws/live')).toBe(true);
    expect(isCleartextRemoteUrl('http://server.example.com')).toBe(true);
    expect(isCleartextRemoteUrl('ws://localhost:8000/ws/live')).toBe(false);
    expect(isCleartextRemoteUrl('http://127.0.0.1:8000')).toBe(false);
    expect(isCleartextRemoteUrl('ws://[::1]:8000')).toBe(false);
    expect(isCleartextRemoteUrl('wss://server.example.com')).toBe(false);
    expect(isCleartextRemoteUrl('https://server.example.com')).toBe(false);
    expect(isCleartextRemoteUrl('not a url')).toBe(false);
  });
});
