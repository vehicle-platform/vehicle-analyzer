// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { hex2, hexBytes, parseHexBytes } from '@/components/uds/hex';
import { StatusText } from '@/components/uds/UdsParts';
import type { UdsTransaction } from '@/services/udsMonitor';

afterEach(cleanup);

describe('uds/hex', () => {
  it('formats bytes as upper-case two-digit hex', () => {
    expect(hex2(0x0a)).toBe('0A');
    expect(hex2(255)).toBe('FF');
    expect(hexBytes([0x22, 0xf1, 0x90])).toBe('22 F1 90');
    expect(hexBytes([])).toBe('');
  });

  it('parses tester input with 0x prefixes, spaces and commas', () => {
    expect(parseHexBytes('22 f1,90')).toEqual([0x22, 0xf1, 0x90]);
    expect(parseHexBytes('0x220x01')).toEqual([0x22, 0x01]);
    expect(parseHexBytes('  ')).toEqual([]);
  });

  it('rejects an odd length or a non-hex character', () => {
    expect(parseHexBytes('abc')).toBeNull();
    expect(parseHexBytes('zz')).toBeNull();
  });
});

describe('uds/UdsParts StatusText', () => {
  const base = { seq: 1, sid: 0x22, request: [0x22], summary: '' } as unknown as UdsTransaction;
  const text = (t: Partial<UdsTransaction>) =>
    render(<StatusText t={{ ...base, ...t } as UdsTransaction} nrcName={(n) => (n === 0x31 ? 'requestOutOfRange' : undefined)} />).container.textContent;

  it('renders each transaction status', () => {
    expect(text({ status: 'positive' })).toBe('ok');
    expect(text({ status: 'pending' })).toBe('…');
    expect(text({ status: 'no_response' })).toBe('no response');
    expect(text({ status: 'suppressed' })).toBe('suppressed');
  });

  it('names a negative response code', () => {
    expect(text({ status: 'negative', nrc: 0x31 })).toBe('nrc 0x31 requestOutOfRange');
    expect(text({ status: 'negative' })).toBe('nrc');
  });
});
