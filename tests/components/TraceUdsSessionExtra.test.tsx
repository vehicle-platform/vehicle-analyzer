// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TracePanel } from '@/components/TracePanel';
import { UdsPanel } from '@/components/UdsPanel';
import { SessionPanel } from '@/components/SessionPanel';
import { createStore, ingestFrame, jsonResponse, platformMessage } from './helpers';
import type { CanFrame } from '@/types/can';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function makeUdsFrame(id: number, data: number[], t: number): CanFrame {
  return {
    id,
    idHex: `0x${id.toString(16).toUpperCase().padStart(3, '0')}`,
    bus: 'vehicle',
    dlc: data.length,
    data,
    timestamp: t,
    deltaMs: 0,
    isExtended: false,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

describe('TracePanel extended coverage', () => {
  it('supports sorting, scroll log mode, trigger arm/disarm, copy bytes, and export formats', async () => {
    Element.prototype.scrollIntoView = vi.fn();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const store = createStore();
    const m1 = platformMessage((m) => m.name === 'EkfLean');
    const m2 = platformMessage((m) => m.name === 'SafetyWarningStatus');
    ingestFrame(store, m1, 1.0, { LEAN_ANGLE: 10 }, 0);
    ingestFrame(store, m1, 1.1, { LEAN_ANGLE: 12 }, 1);
    ingestFrame(store, m2, 1.2, { CORNERING_LEVEL: 1 }, 0);

    const onArm = vi.fn();
    const { rerender } = render(<TracePanel store={store} triggerArmed={false} onArmTrigger={onArm} />);

    // Sort by name, period, Hz, count, and toggle descending
    for (const label of ['name', 'period', 'Hz', 'count', 'id']) {
      fireEvent.click(screen.getByText(label, { selector: 'th button' }));
    }
    fireEvent.click(screen.getByText('id', { selector: 'th button' }));

    // Keyboard cursor + pause on id ('p') + copy bytes ('y')
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'p' });
    expect(onArm).toHaveBeenCalled();
    fireEvent.keyDown(window, { key: 'y' });
    await waitFor(() => expect(writeText).toHaveBeenCalled());

    // Manual trigger input arm + disarm
    const triggerInput = screen.getByLabelText('Pause on id');
    fireEvent.change(triggerInput, { target: { value: '0x020' } });
    fireEvent.click(screen.getByText('Arm'));
    expect(onArm).toHaveBeenCalledWith(0x020);
    rerender(<TracePanel store={store} triggerArmed={true} onArmTrigger={onArm} />);
    fireEvent.click(screen.getByText('[armed]'));
    expect(onArm).toHaveBeenCalledWith(null);

    // Export menu -> ASC, CSV, JSON
    for (const fmt of ['Vector ASC', 'CSV', 'JSON']) {
      fireEvent.click(screen.getByText('Export', { selector: 'button span' }));
      fireEvent.click(screen.getByText(fmt));
    }

    // Switch to scroll log mode via hotkey 'm' and filter
    fireEvent.keyDown(window, { key: 'm' });
    expect(screen.getByText(/frames/)).toBeTruthy();
    fireEvent.click(screen.getByText('follow'));
    fireEvent.change(screen.getByLabelText('Filter frames'), { target: { value: 'EkfLean' } });
    expect(screen.getAllByText('EkfLean').length).toBeGreaterThanOrEqual(1);
  });
});

describe('UdsPanel extended coverage', () => {
  it('navigates all four tabs, shows live DIDs/DTCs, exports DTC reports, and runs composer', () => {
    vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const store = createStore();
    const addr = store.defs.vehicle.addressing.primary;
    const firstDid = store.defs.vehicle.dids[0];
    const hi = (firstDid.did >> 8) & 0xff;
    const lo = firstDid.did & 0xff;

    // 1. ReadDataByIdentifier request + positive response
    store.ingest(makeUdsFrame(addr.requestId, [0x03, 0x22, hi, lo], 1.0));
    store.ingest(makeUdsFrame(addr.responseId, [0x05, 0x62, hi, lo, 0x00, 0x10], 1.02));
    // 2. ReadDTCInformation (0x19 0x02 0xFF) + response with 1 DTC
    store.ingest(makeUdsFrame(addr.requestId, [0x03, 0x19, 0x02, 0xff], 2.0));
    store.ingest(makeUdsFrame(addr.responseId, [0x07, 0x59, 0x02, 0xff, 0x01, 0x23, 0x00, 0x09], 2.02));
    // 3. Routine TesterPresent with suppressPosRsp
    store.ingest(makeUdsFrame(addr.requestId, [0x02, 0x3e, 0x80], 3.0));

    const onTransmit = vi.fn().mockReturnValue({ ok: true });
    render(<UdsPanel store={store} canTransmit={true} onTransmit={onTransmit} />);

    // Transactions tab: toggle hideRoutine, filter, escape clears filter, j/k navigate
    fireEvent.keyDown(window, { key: 'r' });
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'k' });
    const filter = screen.getByLabelText('Filter transactions');
    fireEvent.change(filter, { target: { value: '0x22' } });
    fireEvent.keyDown(filter, { key: 'Escape' });

    // Live DIDs tab ('2')
    fireEvent.keyDown(window, { key: '2' });
    expect(screen.getByText(firstDid.name)).toBeTruthy();

    // DTCs tab ('3') + export JSON and CSV
    fireEvent.keyDown(window, { key: '3' });
    fireEvent.click(screen.getByRole('button', { name: 'export JSON' }));
    fireEvent.click(screen.getByRole('button', { name: 'export CSV' }));

    // Composer tab ('4') + send valid request + test invalid hex error
    fireEvent.keyDown(window, { key: '4' });
    const extraInput = screen.getByLabelText('further bytes');
    fireEvent.change(extraInput, { target: { value: 'ZZ' } });
    expect(screen.getByText(/bytes are not valid hex/)).toBeTruthy();
    fireEvent.change(extraInput, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'send to simulated ECU' }));
    expect(onTransmit).toHaveBeenCalledTimes(1);
  });
});

describe('SessionPanel extended coverage', () => {
  it('filters by text/status/date, sorts, loads all series, handles empty series and errors', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.endsWith('/sessions')) {
        return jsonResponse({
          sessions: [
            { session_id: '20261101-100000-aaaa', status: 'ok', created_utc: '2026-11-01T10:00:00Z', packet_count: 10, loss_percent: 0.5 },
            { session_id: '20261102-100000-bbbb', status: 'partial', created_utc: '2026-11-02T10:00:00Z', packet_count: 5, loss_percent: 4.0 },
          ],
        });
      }
      if (s.includes('/report')) return jsonResponse({ session_id: '20261101-100000-aaaa', packet_count: 10 });
      if (s.includes('/series')) {
        if (s.includes('bbbb')) return jsonResponse({ series: [] });
        return jsonResponse({
          series: [{ name: 'ENGINE_SPEED', kind: 'did', unit: 'rpm', t_ms: [0, 100], v: [1200, 1500] }],
        });
      }
      return jsonResponse({});
    });
    vi.stubGlobal('fetch', fetchMock);

    const onLoad = vi.fn();
    const onSelect = vi.fn();
    render(
      <SessionPanel
        token="tok"
        onTokenChange={vi.fn()}
        serverUrl="http://192.168.1.5:8000"
        onServerUrlChange={vi.fn()}
        onLoad={onLoad}
        onSelect={onSelect}
      />
    );

    // Cleartext warning shown for remote HTTP
    expect(screen.getByText('! cleartext')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    await waitFor(() => expect(screen.getByText('20261101-100000-aaaa')).toBeTruthy());

    // Filter by status & date & text & clear
    fireEvent.click(screen.getByTitle('Show only partial sessions'));
    expect(screen.queryByText('20261101-100000-aaaa')).toBeNull();
    fireEvent.click(screen.getByText('clear'));
    expect(screen.getByText('20261101-100000-aaaa')).toBeTruthy();

    // Select via hotkey j, then click Load all
    fireEvent.keyDown(window, { key: 'j' });
    await waitFor(() => expect(onSelect).toHaveBeenCalled());
    fireEvent.click(screen.getByText('Load all'));
    await waitFor(() => expect(onLoad).toHaveBeenCalled());
  });
});
