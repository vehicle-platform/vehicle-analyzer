// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_LAYOUT, LAYOUT_STORAGE_KEY, parseLayout, readLayout, writeLayout } from '@/ui/layout';

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, String(value));
    },
  };
}

let storage: Storage;

beforeEach(() => {
  storage = memoryStorage();
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
});
afterEach(() => vi.restoreAllMocks());

describe('layout persistence', () => {
  it('uses the original startup layout when storage is empty', () => {
    expect(readLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it('uses the original startup layout for invalid JSON', () => {
    expect(parseLayout('{not json')).toEqual(DEFAULT_LAYOUT);
  });

  it('uses defaults for unknown fields and values', () => {
    expect(parseLayout(JSON.stringify({ view: 'not-a-view', hud: 'yes' }))).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout(JSON.stringify({ view: 'health', hud: false }))).toEqual({ view: 'health', hud: false });
  });

  it('behaves like a first visit when storage reads are blocked', () => {
    vi.spyOn(storage, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(readLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it('does not throw when storage writes are blocked', () => {
    vi.spyOn(storage, 'setItem').mockImplementation(() => {
      throw new Error('storage blocked');
    });
    expect(() => writeLayout({ view: 'compare', hud: false })).not.toThrow();
  });

  it('round-trips the last view and panel layout', () => {
    writeLayout({ view: 'cluster', hud: false });
    expect(JSON.parse(storage.getItem(LAYOUT_STORAGE_KEY)!)).toEqual({ view: 'cluster', hud: false });
    expect(readLayout()).toEqual({ view: 'cluster', hud: false });
  });
});
