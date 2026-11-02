import { useEffect, useState, type DependencyList, type RefObject } from 'react';

export interface ElementSize {
  width: number;
  height: number;
}

/**
 * CSS size of an element, kept current by a ResizeObserver (window resize as a fallback). The
 * size is null until the element is mounted; `deps` re-run the measurement when it (re)appears.
 */
export function useElementSize(ref: RefObject<HTMLElement | null>, deps: DependencyList = []): ElementSize | null {
  const [size, setSize] = useState<ElementSize | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const rect = el.getBoundingClientRect();
      const width = Math.max(1, rect.width);
      const height = Math.max(1, rect.height);
      setSize((prev) => (prev && prev.width === width && prev.height === height ? prev : { width, height }));
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, deps);

  return size;
}

/** Current devicePixelRatio; a zoom or a move to another screen changes it and re-renders the caller. */
export function useDevicePixelRatio(): number {
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    // The query matches one exact ratio, so it is registered again after every change.
    const query = window.matchMedia(`(resolution: ${dpr}dppx)`);
    const onChange = () => setDpr(window.devicePixelRatio || 1);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [dpr]);

  return dpr;
}
