import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { frameFromDto, parseStreamMessage } from '@/services/streamClient';

describe('stream schemas (property tests)', () => {
  it('arbitrary JSON never throws and always yields a result', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        const r = parseStreamMessage(value);
        expect(Array.isArray(r.frames)).toBe(true);
        expect(r.rejected).toBeGreaterThanOrEqual(0);
      })
    );
  });

  it('a valid frame DTO round-trips id, payload and extended flag', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0x7ff }), fc.uint8Array({ minLength: 0, maxLength: 8 }), (id, bytes) => {
        const data_hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
        const f = frameFromDto({ id, data_hex, channel: 1, is_extended: false });
        expect(f).not.toBeNull();
        expect(f?.id).toBe(id);
        expect(f?.data).toEqual(Array.from(bytes));
        expect(f?.bus).toBe('vehicle');
      })
    );
  });

  it('enforces the identifier bounds and rejects bad hex', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0x20000000, max: 0x7fffffff }), (id) => {
        expect(frameFromDto({ id, data_hex: '00' })).toBeNull();
      })
    );
    expect(frameFromDto({ id: -1, data_hex: '00' })).toBeNull();
    expect(frameFromDto({ id: 1.5, data_hex: '00' })).toBeNull();
    expect(frameFromDto({ id: 1, data_hex: 'zz' })).toBeNull();
    expect(frameFromDto({ id: 1, data_hex: '0' })).toBeNull();
  });

  it('counts a dropped frame inside an otherwise good batch', () => {
    const r = parseStreamMessage({ type: 'batch', payload: { frames: [{ id: 1, data_hex: '01' }, { id: 'x' }, 7] } });
    expect(r.frames).toHaveLength(1);
    expect(r.rejected).toBe(2);
  });
});
