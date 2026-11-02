// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useDevicePixelRatio } from '../../src/ui/useCanvas';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('useDevicePixelRatio', () => {
  it('follows a devicePixelRatio change and registers the query for the new ratio again', () => {
    const listeners = new Map<string, () => void>();
    const removed: string[] = [];
    const matchMedia = vi.fn((query: string) => ({
      addEventListener: (_type: string, fn: () => void) => listeners.set(query, fn),
      removeEventListener: () => removed.push(query),
    }));
    vi.stubGlobal('matchMedia', matchMedia);
    vi.stubGlobal('devicePixelRatio', 1);

    const { result } = renderHook(() => useDevicePixelRatio());
    expect(result.current).toBe(1);
    expect(matchMedia).toHaveBeenLastCalledWith('(resolution: 1dppx)');

    vi.stubGlobal('devicePixelRatio', 2);
    act(() => listeners.get('(resolution: 1dppx)')?.());

    expect(result.current).toBe(2);
    expect(removed).toEqual(['(resolution: 1dppx)']);
    expect(matchMedia).toHaveBeenLastCalledWith('(resolution: 2dppx)');
  });
});
