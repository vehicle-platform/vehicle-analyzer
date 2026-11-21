import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { parseSlcanLine, SlcanScanner, type SlcanEvent } from '@/services/webSerialCan';
import { csvCell, csvRow, csvQuoted, splitCsvLine } from '@/services/csv';
import { exportToCsv } from '@/services/exportService';
import { parseCanCsv } from '@/services/logParser';
import type { CanFrame } from '@/types/can';

// T31 / PY-3: property tests for the SLCAN parser and the CSV export escaping. Extends
// streamSchemas.test.ts (analyzer#69), which covers the stream DTO parsers. The run count is
// bounded for PR CI; FAST_CHECK_RUNS=5000 gives the deep run.
fc.configureGlobal({ numRuns: Number(process.env.FAST_CHECK_RUNS ?? 100) });

const FORMULA_START = /^[=+\-@\t\r]/;
const hex = (n: number, width: number) => n.toString(16).toUpperCase().padStart(width, '0');
const bytesHex = (bytes: number[]) => bytes.map((b) => hex(b, 2)).join('');

// ---------------------------------------------------------------- SLCAN

describe('SLCAN parser (property tests)', () => {
  it('never throws on arbitrary text and only returns well-formed frames', () => {
    const anyLine = fc.oneof(
      fc.string({ maxLength: 60 }),
      fc.string({ maxLength: 40 }).map((s) => `t${s}`),
      fc.string({ maxLength: 40 }).map((s) => `T${s}`),
      fc.stringMatching(/^[tT][0-9A-Fa-f]{0,30}$/),
    );
    fc.assert(
      fc.property(anyLine, (line) => {
        const f = parseSlcanLine(line, 'vehicle');
        if (f === null) return;
        expect(f.dlc).toBeGreaterThanOrEqual(0);
        expect(f.dlc).toBeLessThanOrEqual(8);
        expect(f.data).toHaveLength(f.dlc);
        expect(f.data.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)).toBe(true);
        expect(f.id).toBeGreaterThanOrEqual(0);
        expect(f.id).toBeLessThanOrEqual(f.isExtended ? 0x1fffffff : 0x7ff);
        expect(f.isExtended).toBe(line.startsWith('T'));
        expect(f.idHex).toBe(`0x${hex(f.id, f.isExtended ? 8 : 3)}`);
      }),
    );
  });

  it('round-trips a formatted standard or extended frame, ignoring a trailing timestamp', () => {
    const std = fc.record({
      ext: fc.constant(false),
      id: fc.integer({ min: 0, max: 0x7ff }),
      data: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 8 }),
    });
    const ext = fc.record({
      ext: fc.constant(true),
      id: fc.integer({ min: 0, max: 0x1fffffff }),
      data: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 8 }),
    });
    fc.assert(
      fc.property(fc.oneof(std, ext), fc.option(fc.integer({ min: 0, max: 0xffff })), (c, ts) => {
        const line = `${c.ext ? 'T' + hex(c.id, 8) : 't' + hex(c.id, 3)}${c.data.length}${bytesHex(c.data)}${
          ts === null ? '' : hex(ts, 4)
        }`;
        const f = parseSlcanLine(line, 'vehicle');
        expect(f).not.toBeNull();
        expect(f?.id).toBe(c.id);
        expect(f?.isExtended).toBe(c.ext);
        expect(f?.data).toEqual(c.data);
      }),
    );
  });

  it('refuses a data section shorter than the declared DLC and a DLC above 8', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 0x7ff }),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 0, max: 7 }),
        (id, dlc, have) => {
          fc.pre(have < dlc);
          const body = '00'.repeat(have);
          expect(parseSlcanLine(`t${hex(id, 3)}${dlc}${body}`, 'vehicle')).toBeNull();
        },
      ),
    );
    fc.assert(
      fc.property(fc.integer({ min: 9, max: 9 }), (dlc) => {
        expect(parseSlcanLine(`t123${dlc}${'00'.repeat(9)}`, 'vehicle')).toBeNull();
      }),
    );
  });

  it('rejects remote frames and non-data replies by prefix', () => {
    fc.assert(
      fc.property(fc.constantFrom('r', 'R', 'V', 'N', 'z', 'F', 'S', 'C', 'O'), fc.stringMatching(/^[0-9A-F]{0,20}$/), (p, rest) => {
        expect(parseSlcanLine(p + rest, 'vehicle')).toBeNull();
      }),
    );
  });
});

describe('SlcanScanner (property tests)', () => {
  const alphabet = fc.constantFrom('t', 'T', '0', '1', 'A', 'F', '\r', '\n', '\x07', ' ', 'V');
  const stream = fc.array(alphabet, { maxLength: 80 }).map((a) => a.join(''));

  const run = (chunks: string[]): SlcanEvent[] => {
    const s = new SlcanScanner();
    return chunks.flatMap((c) => s.push(c));
  };

  it('is invariant under how the stream is chunked', () => {
    fc.assert(
      fc.property(stream, fc.array(fc.nat({ max: 80 }), { maxLength: 6 }), (text, cuts) => {
        const points = [...new Set(cuts.map((c) => Math.min(c, text.length)))].sort((a, b) => a - b);
        const chunks: string[] = [];
        let last = 0;
        for (const p of points) {
          chunks.push(text.slice(last, p));
          last = p;
        }
        chunks.push(text.slice(last));
        expect(run(chunks)).toEqual(run([text]));
      }),
    );
  });

  it('emits one event per CR or BELL and line texts never hold a terminator', () => {
    fc.assert(
      fc.property(stream, (text) => {
        const events = run([text]);
        expect(events).toHaveLength([...text].filter((c) => c === '\r' || c === '\x07').length);
        for (const e of events) {
          if (e.kind === 'line') {
            expect(e.text.includes('\r') || e.text.includes('\x07')).toBe(false);
            expect(e.text).toBe(e.text.trim());
            expect(e.text.length).toBeGreaterThan(0);
          }
        }
      }),
    );
  });

  it('a BELL discards a half-received line', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[tT0-9A-F]{1,20}$/), (partial) => {
        const s = new SlcanScanner();
        s.push(partial);
        expect(s.push('\x07')).toEqual([{ kind: 'error' }]);
        expect(s.push('\r')).toEqual([{ kind: 'ok' }]);
      }),
    );
  });

  it('keeps its buffer bounded when an adapter never sends a terminator', () => {
    const s = new SlcanScanner();
    for (let i = 0; i < 2000; i++) s.push('t'.repeat(1000));
    // an overlong unterminated line is discarded, not accumulated (2 MB here)
    expect((s as unknown as { pending: string }).pending.length).toBeLessThan(10_000);
    // the skipped line's terminator produces no event; the scanner then recovers
    expect(s.push('\r')).toEqual([]);
    expect(s.push('t1101AA\r')).toEqual([{ kind: 'line', text: 't1101AA' }]);
  });

  it('a 29-bit identifier is the ceiling for an extended frame', () => {
    expect(parseSlcanLine('T1FFFFFFF0', 'vehicle')).not.toBeNull();
    expect(parseSlcanLine('T200000000', 'vehicle')).toBeNull();
    expect(parseSlcanLine('TFFFFFFFF0', 'vehicle')).toBeNull();
  });
});

// ---------------------------------------------------------------- CSV

const anyText = fc.oneof(
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'grapheme-ascii', maxLength: 20 }).map((s) => '=' + s),
  fc.constantFrom('=cmd|calc', '+1+1', '-2+3', '@SUM(A1)', '\t=1', '\r=1', '"=x"', ',', '"', '\n', ''),
  fc.stringMatching(/^[=+\-@\t\r,"\n ]{0,6}[A-Za-z]{0,4}$/),
);
const lineText = anyText.filter((s) => !/[\r\n]/.test(s));

describe('CSV escaping (property tests)', () => {
  it('a cell never starts with a spreadsheet formula character', () => {
    fc.assert(
      fc.property(anyText, (v) => {
        const cell = csvCell(v);
        const content = cell.startsWith('"') ? cell.slice(1) : cell;
        expect(content).not.toMatch(FORMULA_START);
        const q = csvQuoted(v);
        expect(q.slice(1)).not.toMatch(FORMULA_START);
      }),
    );
  });

  it('csvRow -> splitCsvLine returns the cells, with the formula guard prefix as the only change', () => {
    fc.assert(
      fc.property(fc.array(anyText, { minLength: 1, maxLength: 8 }), (cells) => {
        const expected = cells.map((c) => (FORMULA_START.test(c) ? `'${c}` : c));
        expect(splitCsvLine(csvRow(cells))).toEqual(expected);
      }),
    );
  });

  it('an escaped cell is a single field: no unquoted comma or newline survives', () => {
    fc.assert(
      fc.property(anyText, (v) => {
        const cell = csvCell(v);
        expect(splitCsvLine(cell)).toHaveLength(1);
        if (!cell.startsWith('"')) expect(cell).not.toMatch(/[",\n\r]/);
      }),
    );
  });

  it('csvQuoted is always one quoted field that decodes to the guarded text', () => {
    fc.assert(
      fc.property(anyText, (v) => {
        const q = csvQuoted(v);
        expect(q.startsWith('"') && q.endsWith('"')).toBe(true);
        expect(splitCsvLine(q)).toEqual([FORMULA_START.test(v) ? `'${v}` : v]);
      }),
    );
  });

  const frameArb = fc
    .record({
      ext: fc.boolean(),
      idRaw: fc.integer({ min: 0, max: 0x1fffffff }),
      data: fc.array(fc.integer({ min: 0, max: 255 }), { maxLength: 8 }),
      ts: fc.double({ min: 0, max: 1e6, noNaN: true }),
      bus: lineText,
      name: lineText,
      signals: fc.dictionary(lineText.filter((k) => k.length > 0 && !k.includes('=')), fc.oneof(fc.double({ noNaN: true, noDefaultInfinity: true }), lineText), { maxKeys: 3 }),
    })
    .map((r): CanFrame => {
      const id = r.ext ? r.idRaw : r.idRaw & 0x7ff;
      return {
        id,
        idHex: `0x${hex(id, r.ext ? 8 : 3)}`,
        bus: r.bus,
        dlc: r.data.length,
        data: r.data,
        timestamp: r.ts,
        deltaMs: 0,
        isExtended: r.ext,
        periodMs: 0,
        frequencyHz: 0,
        count: 1,
        name: r.name,
        decodedSignals: Object.keys(r.signals).length ? r.signals : undefined,
      };
    });

  it('exportToCsv: every text cell is formula-safe and the row structure survives', () => {
    fc.assert(
      fc.property(fc.array(frameArb, { maxLength: 6 }), (frames) => {
        const lines = exportToCsv(frames).split('\n');
        expect(lines).toHaveLength(frames.length + 1);
        lines.slice(1).forEach((line, i) => {
          const cells = splitCsvLine(line);
          expect(cells).toHaveLength(8);
          for (const idx of [2, 4, 7]) expect(cells[idx]).not.toMatch(FORMULA_START);
          expect(cells[3]).toBe(frames[i].idHex);
          expect(cells[6]).toBe(bytesHex(frames[i].data));
        });
      }),
    );
  });

  it('exportToCsv -> parseCanCsv keeps id, flags, data and timestamp', () => {
    fc.assert(
      fc.property(fc.array(frameArb, { maxLength: 6 }), (frames) => {
        const back = parseCanCsv(exportToCsv(frames));
        expect(back).toHaveLength(frames.length);
        back.forEach((b, i) => {
          expect(b.id).toBe(frames[i].id);
          expect(b.isExtended).toBe(frames[i].isExtended);
          expect(b.data).toEqual(frames[i].data);
          expect(b.timestamp).toBeCloseTo(frames[i].timestamp, 5);
        });
      }),
    );
  });

  it('keeps an extended identifier below 0x800 extended', () => {
    const f: CanFrame = {
      id: 0x12, idHex: '0x00000012', bus: 'vehicle', dlc: 1, data: [1], timestamp: 1, deltaMs: 0,
      isExtended: true, periodMs: 0, frequencyHz: 0, count: 1,
    };
    expect(parseCanCsv(exportToCsv([f]))[0]).toMatchObject({ id: 0x12, isExtended: true });
  });

  // Known limitation (documented, not fixed): parseCanCsv splits the file on newlines before it
  // honours quotes, so a Name or signal text holding a line break loses its frame on re-import.
  // Names come from DBC/defs and never contain one today; a record-aware reader would fix it.
  it.fails('a quoted line break inside a cell survives the CSV round trip', () => {
    const f: CanFrame = {
      id: 0x110, idHex: '0x110', bus: 'vehicle', dlc: 1, data: [1], timestamp: 1, deltaMs: 0,
      isExtended: false, periodMs: 0, frequencyHz: 0, count: 1, name: 'a\nb',
    };
    expect(parseCanCsv(exportToCsv([f]))).toHaveLength(1);
  });

  it('parseCanCsv never throws on arbitrary text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), fc.array(lineText, { maxLength: 5 }), (head, rows) => {
        const out = parseCanCsv([head, ...rows].join('\n'));
        expect(Array.isArray(out)).toBe(true);
        for (const f of out) expect(Number.isFinite(f.id)).toBe(true);
      }),
    );
  });
});
