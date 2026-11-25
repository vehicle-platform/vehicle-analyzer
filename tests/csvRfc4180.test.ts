import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { csvCell, csvQuoted, csvRow, parseCsv } from '@/services/csv';
import { exportToCsv } from '@/services/exportService';
import { parseCanCsv } from '@/services/logParser';
import type { CanFrame } from '@/types/can';

const frame = (over: Partial<CanFrame>): CanFrame => ({
  id: 0x100, idHex: '0x100', bus: 'vehicle', dlc: 2, data: [1, 2], timestamp: 1, deltaMs: 0, isExtended: false, periodMs: 0, frequencyHz: 0, count: 1, ...over,
});

describe('csvCell quoting (RFC 4180)', () => {
  it.each([
    ['line feed', 'a\nb', '"a\nb"'],
    ['CRLF', 'a\r\nb', '"a\r\nb"'],
    ['bare CR', 'a\rb', '"a\rb"'],
    ['quote', 'say "hi"', '"say ""hi"""'],
    ['separator', 'a,b', '"a,b"'],
    ['all of them', 'a,"b"\r\nc', '"a,""b""\r\nc"'],
    ['plain', 'abc', 'abc'],
    ['empty', '', ''],
  ])('%s', (_n, input, out) => {
    expect(csvCell(input)).toBe(out);
  });

  it('csvQuoted always quotes and doubles quotes, newlines kept inside', () => {
    expect(csvQuoted('a\nb"c')).toBe('"a\nb""c"');
  });
});

describe('parseCsv', () => {
  it('reads quoted newlines, CRLF, quotes and commas', () => {
    const text = 'h1,h2\r\n"a\nb","c,""d"""\r\nx,y\r\n';
    expect(parseCsv(text)).toEqual([['h1', 'h2'], ['a\nb', 'c,"d"'], ['x', 'y']]);
  });
  it('handles LF, bare CR, empty cells, blank lines and a missing final newline', () => {
    expect(parseCsv('a,,c\n\nd,e,')).toEqual([['a', '', 'c'], ['d', 'e', '']]);
    expect(parseCsv('a,b\rc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('""\n')).toEqual([['']]);
  });
  it('an unterminated quote runs to the end without throwing', () => {
    expect(parseCsv('a,"b\nc')).toEqual([['a', 'b\nc']]);
  });
  it('round-trips arbitrary text cells through csvRow', () => {
    // Formula-looking cells get a leading apostrophe by design, so use cells that cannot start with one.
    const cell = fc.string({ unit: fc.constantFrom('a', 'b', ',', '"', '\n', '\r', ' ', '1') }).map((s) => `x${s}`);
    fc.assert(
      fc.property(fc.array(fc.array(cell, { minLength: 1, maxLength: 4 }), { minLength: 1, maxLength: 4 }), (rows) => {
        const text = rows.map((r) => csvRow(r)).join('\r\n');
        expect(parseCsv(text)).toEqual(rows);
      })
    );
  });
});

describe('trace export round trip with newline cells', () => {
  it('survives a name with newline, CRLF, quote and comma', () => {
    const name = 'line1\nline2\r\nq"uote,comma';
    const csv = exportToCsv([frame({ name }), frame({ id: 0x101, idHex: '0x101', name: 'plain', data: [3] , dlc: 1})]);
    const back = parseCanCsv(csv);
    expect(back).toHaveLength(2);
    expect(back[0].data).toEqual([1, 2]);
    expect(back[1].id).toBe(0x101);
    expect(back[1].data).toEqual([3]);
  });
  it('also reads a CRLF file', () => {
    const csv = exportToCsv([frame({}), frame({ id: 0x102, idHex: '0x102' })]).replace(/\n/g, '\r\n');
    expect(parseCanCsv(csv).map((f) => f.id)).toEqual([0x100, 0x102]);
  });
});
