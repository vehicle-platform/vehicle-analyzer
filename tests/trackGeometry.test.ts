import { describe, expect, it } from 'vitest';
import {
  MAX_VIEW_SCALE,
  MIN_VIEW_SCALE,
  boundsOfSegments,
  colorScale,
  fitView,
  formatDistance,
  nearestByScreen,
  nearestByTime,
  panView,
  resizeView,
  scaleBar,
  screenToWorld,
  worldToScreen,
  zoomAt,
} from '../src/services/trackGeometry';

const segment = (tMs: number[], xM: number[], yM: number[]) => ({ tMs, xM, yM });

describe('fitView', () => {
  it('never uses a negative padding on a canvas under one pixel', () => {
    const view = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0.2, 0.2, 24);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(view.scale).toBeGreaterThan(0);
    expect(worldToScreen(view, 5, 5)).toEqual({ x: 0.5, y: 0.5 });
  });

  it('preserves the aspect ratio, flips y (north up) and centres', () => {
    const view = fitView({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 200, 200, 0);
    expect(view.scale).toBe(2);
    expect(worldToScreen(view, 0, 0)).toEqual({ x: 0, y: 150 });
    expect(worldToScreen(view, 100, 50)).toEqual({ x: 200, y: 50 });
    const east = worldToScreen(view, 1, 0);
    const north = worldToScreen(view, 0, 1);
    expect(Math.hypot(east.x - worldToScreen(view, 0, 0).x, east.y - worldToScreen(view, 0, 0).y)).toBeCloseTo(2);
    expect(Math.hypot(north.x - worldToScreen(view, 0, 0).x, north.y - worldToScreen(view, 0, 0).y)).toBeCloseTo(2);
    expect(worldToScreen(view, 50, 25)).toEqual({ x: 100, y: 100 });
  });

  it('handles degenerate and empty bounds', () => {
    expect(boundsOfSegments([])).toBeNull();
    const point = fitView({ minX: 5, minY: 5, maxX: 5, maxY: 5 }, 100, 100, 10);
    expect(worldToScreen(point, 5, 5)).toEqual({ x: 50, y: 50 });
    const line = fitView({ minX: 0, minY: 0, maxX: 0, maxY: 10 }, 100, 100, 10);
    expect(line.scale).toBe(8);
    expect(worldToScreen(line, 0, 0).x).toBe(50);
    expect(worldToScreen(line, 0, 10).x).toBe(50);
  });

  it('keeps a zero-size canvas finite', () => {
    const view = fitView({ minX: 0, minY: 0, maxX: 10, maxY: 10 }, 0, 0, 28);
    expect(Number.isFinite(view.scale)).toBe(true);
    expect(view.scale).toBeGreaterThan(0);
    expect(Number.isFinite(view.tx) && Number.isFinite(view.ty)).toBe(true);
    const at = worldToScreen(view, 0, 0);
    expect(Number.isFinite(at.x) && Number.isFinite(at.y)).toBe(true);
    expect(scaleBar(view).px).toBeGreaterThanOrEqual(0);
  });

  it('clamps absurd bounds to the sane zoom range', () => {
    const tiny = fitView({ minX: 0, minY: 0, maxX: 1e-9, maxY: 1e-9 }, 100, 100, 0);
    const huge = fitView({ minX: 0, minY: 0, maxX: 1e12, maxY: 1e12 }, 100, 100, 0);
    expect(tiny.scale).toBe(MAX_VIEW_SCALE);
    expect(huge.scale).toBe(MIN_VIEW_SCALE);
  });
});

describe('zoom and pan', () => {
  it('keeps the world point under the cursor fixed', () => {
    const view = fitView({ minX: 0, minY: 0, maxX: 100, maxY: 100 }, 300, 300, 10);
    const before = screenToWorld(view, 120, 80);
    const zoomed = zoomAt(view, 120, 80, 2.5);
    const after = screenToWorld(zoomed, 120, 80);
    expect(after.x).toBeCloseTo(before.x, 10);
    expect(after.y).toBeCloseTo(before.y, 10);
    expect(zoomed.scale).toBeCloseTo(view.scale * 2.5);
  });

  it('clamps the zoom and pans in screen pixels', () => {
    const view = { scale: 10, tx: 0, ty: 0 };
    expect(zoomAt(view, 0, 0, 1e9).scale).toBe(MAX_VIEW_SCALE);
    expect(zoomAt(view, 0, 0, 1e-9).scale).toBe(MIN_VIEW_SCALE);
    const panned = panView(view, 15, -5);
    expect(panned).toEqual({ scale: 10, tx: 15, ty: -5 });
    expect(screenToWorld(panned, 15, -5)).toEqual(screenToWorld(view, 0, 0));
  });
});

describe('nearest points', () => {
  const segments = [segment([0, 1000], [0, 10], [0, 0]), segment([5000, 6000], [100, 110], [0, 0])];

  it('finds the nearest point by time and returns null in a gap', () => {
    expect(nearestByTime(segments, 0)).toMatchObject({ segmentIndex: 0, pointIndex: 0, x: 0, tMs: 0 });
    expect(nearestByTime(segments, 900)).toMatchObject({ segmentIndex: 0, pointIndex: 1, x: 10 });
    expect(nearestByTime(segments, 3000)).toBeNull();
    expect(nearestByTime(segments, 5500)).toMatchObject({ segmentIndex: 1, pointIndex: 0, x: 100 });
    expect(nearestByTime(segments, -1)).toBeNull();
    expect(nearestByTime(segments, 7000)).toBeNull();
  });

  it('finds the nearest point by screen distance within maxPx', () => {
    const view = fitView({ minX: 0, minY: 0, maxX: 110, maxY: 1 }, 220, 220, 0);
    const at = worldToScreen(view, 100, 0);
    expect(nearestByScreen(segments, view, at.x + 2, at.y, 5)).toMatchObject({ segmentIndex: 1, pointIndex: 0 });
    expect(nearestByScreen(segments, view, at.x, at.y + 20, 5)).toBeNull();
  });
});

describe('colorScale', () => {
  it('bins finite values, maps nulls to neutral and handles a constant series', () => {
    const scale = colorScale([0, 5, 10, null, Number.NaN], 4);
    expect(scale.min).toBe(0);
    expect(scale.max).toBe(10);
    expect(scale.binOf(0)).toBe(0);
    expect(scale.binOf(5)).toBe(2);
    expect(scale.binOf(10)).toBe(3);
    expect(scale.binOf(null)).toBeNull();
    expect(scale.binOf(Number.NaN)).toBeNull();
    expect(scale.colorOf(null)).toBe(scale.neutral);
    expect(scale.colors).toHaveLength(4);

    const constant = colorScale([7, 7, 7], 16);
    expect(constant.binOf(7)).not.toBeNull();
    expect(constant.colorOf(7)).toBe(constant.colorOf(7));
    expect(constant.colorOf(7)).not.toContain('NaN');
    expect(constant.binOf(8)).not.toBeNull();
  });

  it('handles an empty or all-null series', () => {
    const empty = colorScale([], 8);
    expect(empty.min).toBe(0);
    expect(empty.max).toBe(0);
    expect(empty.binOf(0)).not.toBeNull();
    expect(empty.binOf(null)).toBeNull();
  });
});

describe('scaleBar', () => {
  const nice = (meters: number) => {
    const exponent = Math.floor(Math.log10(meters));
    const factor = meters / 10 ** exponent;
    return [1, 2, 5].some((f) => Math.abs(f - factor) < 1e-9);
  };

  it('returns a 1/2/5 x 10^k bar normally 60..150 px long', () => {
    for (const scale of [0.5, 1, 2, 10, 100, 1000]) {
      const bar = scaleBar({ scale, tx: 0, ty: 0 });
      expect(bar.px).toBeGreaterThanOrEqual(60);
      expect(bar.px).toBeLessThanOrEqual(150);
      expect(nice(bar.meters)).toBe(true);
      expect(bar.label.length).toBeGreaterThan(0);
    }
    expect(scaleBar({ scale: 10, tx: 0, ty: 0 })).toMatchObject({ meters: 10, px: 100, label: '10 m' });
  });

  it('formats metres and kilometres', () => {
    expect(formatDistance(0.1)).toBe('0.1 m');
    expect(formatDistance(250)).toBe('250 m');
    expect(formatDistance(1000)).toBe('1 km');
  });
});

describe('resizeView', () => {
  it('keeps the scale and the world point at the canvas centre', () => {
    const view = zoomAt(fitView({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 200, 200, 0), 30, 40, 3);
    const centre = screenToWorld(view, 100, 100);
    const resized = resizeView(view, 200, 200, 300, 120);
    expect(resized.scale).toBe(view.scale);
    const after = screenToWorld(resized, 150, 60);
    expect(after.x).toBeCloseTo(centre.x);
    expect(after.y).toBeCloseTo(centre.y);
  });
});
