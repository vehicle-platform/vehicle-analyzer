// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { CaptureStore, UI_REFRESH_MS } from '@/state/captureStore';
import { useCapture } from '@/state/useCapture';
import { DEFS } from '@/defs';
import { frameKey } from '@/services/capture';
import type { CanFrame } from '@/types/can';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function makeVehicleFrame(id: number, data: number[], timestamp: number): CanFrame {
  return {
    id,
    idHex: `0x${id.toString(16).toUpperCase().padStart(3, '0')}`,
    bus: 'vehicle',
    dlc: data.length,
    data,
    timestamp,
    deltaMs: 0,
    isExtended: false,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

describe('CaptureStore & useCapture', () => {
  it('labels UDS addressing IDs, tracks notches, recordedMeta, sampleSecond, and clear', () => {
    vi.useFakeTimers();
    const store = new CaptureStore(DEFS);
    const addr = DEFS.vehicle.addressing;

    // Primary request/response UDS naming
    store.ingest(makeVehicleFrame(addr.primary.requestId, [0x02, 0x10, 0x03], 1.0));
    expect(store.framesByKey.get(frameKey('vehicle', addr.primary.requestId))?.name).toBe('UDS request (tester)');

    store.ingest(makeVehicleFrame(addr.primary.responseId, [0x02, 0x50, 0x03], 1.01));
    expect(store.framesByKey.get(frameKey('vehicle', addr.primary.responseId))?.name).toBe('UDS response (ECU)');

    // Fallback & functional watch IDs if defined
    if (addr.fallback) {
      store.ingest(makeVehicleFrame(addr.fallback.requestId, [0x02, 0x3e, 0x00], 1.02));
      expect(store.framesByKey.get(frameKey('vehicle', addr.fallback.requestId))?.name).toBe('UDS request (fallback ID)');
      store.ingest(makeVehicleFrame(addr.fallback.responseId, [0x02, 0x7e, 0x00], 1.03));
      expect(store.framesByKey.get(frameKey('vehicle', addr.fallback.responseId))?.name).toBe('UDS response (fallback ID)');
    }
    if (addr.functionalWatchIds.length > 0) {
      const watchId = addr.functionalWatchIds[0].id;
      store.ingest(makeVehicleFrame(watchId, [0x02, 0x01, 0x0c], 1.04));
      expect(store.framesByKey.get(frameKey('vehicle', watchId))?.name).toBe('OBD functional request (2nd tester!)');
    }

    // Sniffer notch controls
    const key = frameKey('vehicle', addr.primary.requestId);
    store.toggleNotch('missing:key', 0);
    store.invertNotch('missing:key');
    store.toggleNotch(key, 1);
    expect(store.sniffer.get(key)?.notchedBytes[1]).toBe(true);
    store.invertNotch(key);
    expect(store.sniffer.get(key)?.notchedBytes[1]).toBe(false);
    expect(store.sniffer.get(key)?.notchedBytes[0]).toBe(true);
    store.clearNotches();
    expect(store.sniffer.get(key)?.notchedBytes.every((b) => !b)).toBe(true);

    // Recorded samples and metadata survive clear() until resetRecordedMeta()
    store.setRecordedMeta('sensor.x', { label: 'X', group: 'IMU', unit: 'g' });
    store.ingestSample('sensor.x', 5.0, 1.25);
    expect(store.lastTime).toBe(5.0);
    expect(store.history.get('sensor.x')?.length).toBe(1);

    // sampleSecond & customPlatformDbc
    store.sampleSecond(1.0);
    expect(store.busLoad.size).toBeGreaterThanOrEqual(1);
    store.setPlatformCatalog(DEFS.platform.messages, 'custom.dbc');
    expect(store.customPlatformDbc).toBe('custom.dbc');

    // Coalesced notifications via useCapture
    let renders = 0;
    const Probe = () => {
      const v = useCapture(store);
      renders += 1;
      return <span data-testid="ver">{v}</span>;
    };
    render(<Probe />);
    const initialRenders = renders;
    store.notify();
    store.notify();
    act(() => {
      vi.advanceTimersByTime(UI_REFRESH_MS + 5);
    });
    expect(renders).toBeGreaterThan(initialRenders);

    // clear() wipes captured state but keeps recordedMeta until resetRecordedMeta()
    store.clear();
    expect(store.totalRx).toBe(0);
    expect(store.framesByKey.size).toBe(0);
    expect(store.recordedMeta.has('sensor.x')).toBe(true);
    store.resetRecordedMeta();
    expect(store.recordedMeta.size).toBe(0);
  });
});
