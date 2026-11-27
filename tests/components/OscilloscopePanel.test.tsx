// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { OscilloscopePanel } from '@/components/OscilloscopePanel';
import { createStore, ingestFrame, platformMessage, setThemeColors } from './helpers';

interface FakeCtx {
  fillStyle: string;
  strokeStyle: string;
  lineWidth: number;
  font: string;
  dashes: number[][];
  fillRects: number;
  strokes: number;
  lineTos: number;
  texts: string[];
  fillRect: (x: number, y: number, w: number, h: number) => void;
  beginPath: () => void;
  moveTo: (x: number, y: number) => void;
  lineTo: (x: number, y: number) => void;
  stroke: () => void;
  setLineDash: (segments: number[]) => void;
  fillText: (text: string, x: number, y: number) => void;
  drawImage: () => void;
}

function makeFakeContext(): FakeCtx {
  const ctx: FakeCtx = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    dashes: [],
    fillRects: 0,
    strokes: 0,
    lineTos: 0,
    texts: [],
    fillRect() {
      ctx.fillRects++;
    },
    beginPath() {},
    moveTo() {},
    lineTo() {
      ctx.lineTos++;
    },
    stroke() {
      ctx.strokes++;
    },
    setLineDash(segments: number[]) {
      if (segments.length > 0) ctx.dashes.push(segments);
    },
    fillText(text: string) {
      ctx.texts.push(text);
    },
    drawImage() {},
  };
  return ctx;
}

let rafQueue: FrameRequestCallback[] = [];
let fakeCtx: FakeCtx;

function flushRaf(now = 100): void {
  const pending = rafQueue;
  rafQueue = [];
  act(() => {
    for (const cb of pending) cb(now);
  });
}

beforeEach(() => {
  setThemeColors();
  document.documentElement.style.setProperty('--t-bg', '10 10 10');
  document.documentElement.style.setProperty('--t-rule', '40 40 40');
  document.documentElement.style.setProperty('--t-raise', '20 20 20');
  document.documentElement.style.setProperty('--t-dim', '140 140 140');
  rafQueue = [];
  fakeCtx = makeFakeContext();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(fakeCtx as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: 200,
    bottom: 100,
    width: 200,
    height: 100,
    toJSON: () => ({}),
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,AAAA');
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function populateStore(samples = 8) {
  const store = createStore();
  const eng = platformMessage((m) => m.name === 'VehicleEngine');
  const spd = platformMessage((m) => m.name === 'VehicleSpeed');
  const lean = platformMessage((m) => m.name === 'EkfLean');
  for (let i = 0; i < samples; i++) {
    const t = i * 0.5;
    ingestFrame(
      store,
      eng,
      t,
      {
        ENGINE_SPEED: 2000 + i * 250,
        COOLANT_TEMP: 82,
        BATTERY_VOLTAGE: 13.9,
        THROTTLE_POS: 20 + i * 5,
      },
      i
    );
    ingestFrame(store, spd, t, { VEHICLE_SPEED: 40 + i * 5, VEHICLE_SPEED_VALID: 1, VEHICLE_SPEED_AGE: 10 }, i);
    ingestFrame(store, lean, t, { LEAN_ANGLE: -5 + i * 3, LEAN_ANGLE_STATE: 0, LEAN_ANGLE_QUALITY: 90 }, i);
  }
  return store;
}

describe('OscilloscopePanel', () => {
  it('draws grid and sparse traces, handles cursors, time windows, and channel toggling', () => {
    const store = populateStore(6);
    const { container } = render(<OscilloscopePanel store={store} />);

    // First animation frame renders grid (4 horizontal + 9 vertical = 13) + 3 traces = 16 strokes.
    flushRaf(100);
    expect(fakeCtx.fillRects).toBe(1);
    expect(fakeCtx.strokes).toBe(16);

    // Second frame with no data/settings change skips redraw.
    const strokesBefore = fakeCtx.strokes;
    flushRaf(110);
    expect(fakeCtx.strokes).toBe(strokesBefore);

    // Switch time window via radio button and hotkey 'w'.
    fireEvent.click(screen.getByRole('radio', { name: /30s/ }));
    expect(screen.getByText('0.00 – 2.50 s')).toBeTruthy();
    fireEvent.keyDown(window, { key: 'w' });
    flushRaf(200);
    expect(fakeCtx.strokes).toBeGreaterThan(strokesBefore);

    // Place cursor A then cursor B on the canvas and verify readout + delta table.
    const canvas = container.querySelector('canvas');
    expect(canvas).not.toBeNull();
    fireEvent.click(canvas!, { clientX: 50 }); // frac = 0.25 -> cursor A
    expect(screen.getByText('cursor')).toBeTruthy();
    fireEvent.click(canvas!, { clientX: 150 }); // frac = 0.75 -> cursor B
    flushRaf(300);
    expect(fakeCtx.texts).toContain('A');
    expect(fakeCtx.texts).toContain('B');
    // B - A over 60s window * 0.5 = 30000.0 ms
    expect(screen.getByText('30000.0 ms')).toBeTruthy();

    // Clear cursors via button.
    fireEvent.click(screen.getByRole('button', { name: /cursors off/i }));
    expect(screen.queryByText('cursor')).toBeNull();

    // Add a fourth channel from the picker, then remove all channels.
    const picker = screen.getByLabelText('Channel to add') as HTMLSelectElement;
    const coolantOption = [...picker.options].find((o) => o.value.includes('COOLANT_TEMP'));
    expect(coolantOption).toBeTruthy();
    fireEvent.change(picker, { target: { value: coolantOption!.value } });
    fireEvent.click(screen.getByRole('button', { name: /add/i }));
    expect(screen.getByTitle(coolantOption!.text)).toBeTruthy();

    // Flat-value coolant trace (82 degC everywhere) draws cleanly without NaN.
    const strokesBeforeFlat = fakeCtx.strokes;
    flushRaf(400);
    expect(fakeCtx.strokes).toBeGreaterThan(strokesBeforeFlat);

    // Remove every plotted trace -> empty-state notice shown.
    while (screen.queryAllByRole('button', { name: /^Remove / }).length > 0) {
      fireEvent.click(screen.queryAllByRole('button', { name: /^Remove / })[0]);
    }
    expect(screen.getByText('no channel plotted')).toBeTruthy();
  });

  it('uses min-max per-pixel decimation for dense traces (> 2 * width samples)', () => {
    const store = createStore();
    const eng = platformMessage((m) => m.name === 'VehicleEngine');
    // 450 samples > 2 * 200px width forces the peak-preserving column decimation branch.
    for (let i = 0; i < 450; i++) {
      ingestFrame(store, eng, i * 0.01, { ENGINE_SPEED: 1500 + (i % 20) * 100 }, i);
    }
    render(<OscilloscopePanel store={store} />);
    flushRaf(100);
    expect(fakeCtx.strokes).toBeGreaterThan(13);
    expect(fakeCtx.lineTos).toBeGreaterThan(100);
  });

  it('adds and removes derivative and binary math channels and exports CSV and PNG', () => {
    const store = populateStore(10);
    const createdBlobs: Blob[] = [];
    const revoked: string[] = [];
    const origCreate = URL.createObjectURL;
    const origRevoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn((blob: Blob) => {
      createdBlobs.push(blob);
      return 'blob:scope-csv';
    });
    URL.revokeObjectURL = vi.fn((url: string) => {
      revoked.push(url);
    });
    const downloads: { href: string; download: string }[] = [];
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ href: this.href, download: this.download });
    });

    try {
      render(<OscilloscopePanel store={store} />);
      // Open math bar via button.
      fireEvent.click(screen.getByRole('button', { name: /math/i }));
      expect(screen.getByText(/Analysis only, not a platform signal/)).toBeTruthy();

      // Add default derivative math channel.
      fireEvent.click(screen.getByRole('button', { name: 'add math channel' }));
      expect(screen.getAllByText(/\[math\]/).length).toBeGreaterThan(0);

      // Switch op to 'difference' with custom scale and unit; invalid scale is ignored.
      fireEvent.change(screen.getByLabelText('Operation'), { target: { value: 'difference' } });
      expect(screen.getByLabelText('Input B')).toBeTruthy();
      fireEvent.change(screen.getByLabelText('Scale'), { target: { value: 'not-a-num' } });
      fireEvent.click(screen.getByRole('button', { name: 'add math channel' }));
      expect(screen.getAllByText(/\[math\]/).length).toBe(1);

      fireEvent.change(screen.getByLabelText('Scale'), { target: { value: '2' } });
      fireEvent.change(screen.getByLabelText('Unit'), { target: { value: 'u' } });
      fireEvent.click(screen.getByRole('button', { name: 'add math channel' }));
      expect(screen.getAllByText(/\[math\]/).length).toBe(2);

      // Drawing math channels applies dashed line style.
      flushRaf(150);
      expect(fakeCtx.dashes.length).toBeGreaterThan(0);

      // Export CSV and PNG snapshot.
      fireEvent.click(screen.getByRole('button', { name: /CSV/i }));
      expect(createdBlobs.length).toBe(1);
      expect(revoked).toEqual(['blob:scope-csv']);
      expect(downloads[0].download).toMatch(/^vehicle-analyzer-scope-.*\.csv$/);

      fireEvent.click(screen.getByRole('button', { name: /PNG/i }));
      expect(downloads[1].download).toMatch(/^vehicle-analyzer-scope-.*\.png$/);
      expect(downloads[1].href).toContain('data:image/png');

      // Remove a math channel.
      const removeMathBtn = screen.getAllByRole('button', { name: /^Remove \[math\]/ })[0];
      fireEvent.click(removeMathBtn);
      expect(screen.getAllByText(/\[math\]/).length).toBe(1);
    } finally {
      clickSpy.mockRestore();
      URL.createObjectURL = origCreate;
      URL.revokeObjectURL = origRevoke;
    }
  });
});
