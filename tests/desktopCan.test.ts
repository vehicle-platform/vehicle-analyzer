import { describe, it, expect, vi } from 'vitest';
import { DesktopCanAdapter, frameFromEvent, isDesktop, FRAME_EVENT, TauriBridge, DesktopFrameEvent } from '@/services/desktopCan';

function fakeBridge(openResult: 'ok' | string) {
  let handler: ((e: { payload: DesktopFrameEvent }) => void) | null = null;
  const calls: string[] = [];
  let unlistened = 0;
  const bridge: TauriBridge = {
    invoke: vi.fn(async (cmd: string) => {
      calls.push(cmd);
      if (cmd === 'hal_open' && openResult !== 'ok') throw openResult;
      return undefined;
    }),
    listen: vi.fn(async (_event: string, h) => {
      handler = h;
      return () => {
        unlistened += 1;
        handler = null;
      };
    }),
  };
  const emit = (payload: DesktopFrameEvent) => handler?.({ payload });
  return { bridge, calls, emit, unlistened: () => unlistened };
}

const ev: DesktopFrameEvent = { id: 0x110, extended: false, data: [1, 2, 3], rx_time: 0.5, bus: 'platform' };

describe('DesktopCanAdapter', () => {
  it('delivers frames only after hal_open confirmed listen-only', async () => {
    const f = fakeBridge('ok');
    const frames: number[] = [];
    const adapter = new DesktopCanAdapter(async () => f.bridge);
    const pending = adapter.connect({ kind: 'slcan', name: '/dev/ttyACM0', bitrate: 500000, bus: 'vehicle' }, (fr) => frames.push(fr.id));
    await pending;
    expect(f.calls).toEqual(['hal_open']);
    f.emit(ev);
    expect(frames).toEqual([0x110]);
    expect(adapter.isOpen()).toBe(true);
    await adapter.disconnect();
    f.emit(ev);
    expect(frames).toEqual([0x110]);
    expect(f.calls).toEqual(['hal_open', 'hal_close']);
    expect(f.unlistened()).toBe(1);
  });

  it('surfaces a refusal and leaves nothing open', async () => {
    const f = fakeBridge('the adapter refused listen-only mode (L); not opened');
    const adapter = new DesktopCanAdapter(async () => f.bridge);
    await expect(adapter.connect({ kind: 'slcan', name: 'COM3', bitrate: 500000, bus: 'vehicle' }, () => undefined)).rejects.toThrow(
      /refused listen-only/
    );
    expect(adapter.isOpen()).toBe(false);
    expect(f.unlistened()).toBe(1);
    f.emit(ev); // no handler left, nothing happens
  });

  it('never invokes anything but hal_open and hal_close', async () => {
    const f = fakeBridge('ok');
    const adapter = new DesktopCanAdapter(async () => f.bridge);
    await adapter.connect({ kind: 'socketcan', name: 'can1', bitrate: 500000, bus: 'vehicle' }, () => undefined);
    await adapter.disconnect();
    expect(new Set(f.calls)).toEqual(new Set(['hal_open', 'hal_close']));
    expect(f.bridge.listen).toHaveBeenCalledWith(FRAME_EVENT, expect.any(Function));
  });
});

describe('frameFromEvent / isDesktop', () => {
  it('builds a pipeline frame with the HAL bus label', () => {
    const fr = frameFromEvent({ ...ev, id: 0x18daf110, extended: true }, 10);
    expect(fr.idHex).toBe('0x18DAF110');
    expect(fr.bus).toBe('platform');
    expect(fr.dlc).toBe(3);
    expect(fr.timestamp).toBeCloseTo(10.5);
    expect(frameFromEvent(ev, 0).idHex).toBe('0x110');
  });

  it('detects the Tauri webview by its internals global', () => {
    expect(isDesktop({})).toBe(false);
    expect(isDesktop({ __TAURI_INTERNALS__: {} })).toBe(true);
    expect(isDesktop(null)).toBe(false);
  });
});
