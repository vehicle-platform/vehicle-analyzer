import { describe, it, expect } from 'vitest';
import { parseDbcText, decodeFrameSignals, extractRawValue } from '@/services/dbcParser';
import type { DbcSignalDef } from '@/types/can';

const sig = (over: Partial<DbcSignalDef>): DbcSignalDef => ({
  name: 'S', startBit: 0, bitLength: 8, isLittleEndian: true, isSigned: false,
  factor: 1, offset: 0, min: 0, max: 0, unit: '', ...over,
});

const SAMPLE = `VERSION "1"

BO_ 272 VehicleEngine: 8 RT_CORE
 SG_ ENGINE_SPEED : 0|16@1+ (0.25,0) [0|16383.75] "rpm" CONN,LINUX
 SG_ BATTERY_VOLTAGE : 16|16@1+ (0.001,0) [0|65.535] "V" CONN,LINUX
 SG_ COOLANT_TEMP : 32|8@1+ (1,-40) [-40|215] "degC" CONN,LINUX

BO_ 2564485392 Diag: 8 TESTER
 SG_ MUX M : 0|8@1+ (1,0) [0|255] "" Vector__XXX
 SG_ BE16 m1 : 15|16@0- (1,0) [0|0] "" Vector__XXX
`;

describe('parseDbcText', () => {
  it('parses messages, signals, multiplexed names and 29-bit IDs', () => {
    const msgs = parseDbcText(SAMPLE);
    expect(msgs.map((m) => m.name)).toEqual(['VehicleEngine', 'Diag']);
    expect(msgs[0].signals).toHaveLength(3);
    expect(msgs[1].id).toBe(0x18daf110);
    expect(msgs[1].signals.map((s) => s.name)).toEqual(['MUX', 'BE16']);
  });

  it('returns an empty list for a DBC without messages instead of a substitute catalog', () => {
    expect(parseDbcText('VERSION "0.1.0"\nBU_: CL250_ECU\n')).toEqual([]);
  });
});

describe('decoding', () => {
  it('keeps full precision (no rounding in the decoder)', () => {
    const [eng] = parseDbcText(SAMPLE);
    // 12.345 V = raw 12345 = 0x3039 at bits 16..31
    const v = decodeFrameSignals([0x01, 0x00, 0x39, 0x30, 0x55, 0, 0, 0], eng);
    expect(v.BATTERY_VOLTAGE).toBeCloseTo(12.345, 9);
    expect(v.ENGINE_SPEED).toBe(0.25);
    expect(v.COOLANT_TEMP).toBe(0x55 - 40);
  });

  it('decodes Intel signed values across bytes', () => {
    expect(extractRawValue([0x18, 0xfc], sig({ bitLength: 16, isSigned: true }))).toBe(-1000);
    expect(extractRawValue([0b1010_0000], sig({ startBit: 4, bitLength: 4 }))).toBe(0b1010);
  });

  it('decodes Motorola (big-endian) signals over several bytes', () => {
    // MSB at bit 7 of byte 0, 16 bits: bytes 0x12 0x34 -> 0x1234
    expect(extractRawValue([0x12, 0x34], sig({ startBit: 7, bitLength: 16, isLittleEndian: false }))).toBe(0x1234);
    // 12-bit field starting at bit 3 of byte 0: low nibble of byte 0 then byte 1
    expect(extractRawValue([0x0a, 0xbc], sig({ startBit: 3, bitLength: 12, isLittleEndian: false }))).toBe(0xabc);
    const [, diag] = parseDbcText(SAMPLE);
    expect(decodeFrameSignals([0x01, 0xff, 0xfe, 0, 0, 0, 0, 0], diag).BE16).toBe(-2);
  });

  it('does not overflow 32-bit unsigned signals', () => {
    expect(extractRawValue([0xff, 0xff, 0xff, 0xff], sig({ bitLength: 32 }))).toBe(4294967295);
  });

  it('skips a signal that does not fit the payload', () => {
    expect(extractRawValue([0x01], sig({ startBit: 8, bitLength: 8 }))).toBeNull();
  });
});
