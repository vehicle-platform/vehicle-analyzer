import { describe, it, expect } from 'vitest';
import { crc8SaeJ1850, e2eProtect, E2EChecker } from '@/services/e2e';

describe('E2E profile', () => {
  it('uses CRC-8/SAE-J1850 (catalogue check value 0x4B)', () => {
    expect(crc8SaeJ1850([...'123456789'].map((c) => c.charCodeAt(0)))).toBe(0x4b);
  });

  it('walks the receiver states', () => {
    const id = 0x1020;
    const rx = new E2EChecker(id, 60);
    const f = (c: number) => e2eProtect(id, [0, 0, 1, 2, 3, 4, 5, 6], c);
    expect(rx.check(f(0), 0)).toBe('INITIAL');
    expect(rx.check(f(1), 20)).toBe('OK');
    expect(rx.check(f(1), 40)).toBe('REPEATED');
    expect(rx.check(f(3), 60)).toBe('WRONG_SEQUENCE');
    expect(rx.check(f(4), 80)).toBe('OK');
    const bad = f(5);
    bad[3] ^= 1;
    expect(rx.check(bad, 100)).toBe('WRONG_CRC');
    expect(rx.check(e2eProtect(0x1021, [0, 0, 1, 2, 3, 4, 5, 6], 5), 100)).toBe('WRONG_CRC'); // masquerade
    expect(rx.checkTimeout(200)).toBe('NO_NEW_DATA');
    expect(rx.check(f(6), 210)).toBe('INITIAL');
    expect(rx.check(f(15), 230)).toBe('WRONG_SEQUENCE');
    expect(rx.check(f(0), 250)).toBe('OK'); // wrap 15 -> 0
  });
});
