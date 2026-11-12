// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { UdsPanel } from '@/components/UdsPanel';
import { createStore } from './helpers';
import { DEFS } from '@/defs';
import { composerServices } from '@/services/udsComposer';
import { CanFrame } from '@/types/can';

afterEach(cleanup);

const REQ = 0x18da10f1;
const RSP = 0x18daf110;

const frame = (id: number, data: number[], t: number): CanFrame => ({
  id,
  idHex: '',
  bus: 'vehicle',
  dlc: 8,
  data,
  timestamp: t,
  deltaMs: 0,
  isExtended: true,
  periodMs: 0,
  frequencyHz: 0,
  count: 1,
});

function ingestIsoTp(store: ReturnType<typeof createStore>, id: number, payload: number[], t: number) {
  const padded = (data: number[]) => [...data, ...Array(8 - data.length).fill(0xaa)];
  if (payload.length <= 7) {
    store.ingest(frame(id, padded([payload.length, ...payload]), t));
    return;
  }
  store.ingest(frame(id, [0x10 | (payload.length >> 8), payload.length & 0xff, ...payload.slice(0, 6)], t));
  let seq = 1;
  for (let i = 6; i < payload.length; i += 7) {
    store.ingest(frame(id, padded([0x20 | seq, ...payload.slice(i, i + 7)]), t + seq / 1000));
    seq++;
  }
}

function exchange(store: ReturnType<typeof createStore>, dtc: number, response: number[], t: number) {
  ingestIsoTp(store, REQ, [0x19, response[1], (dtc >> 16) & 0xff, (dtc >> 8) & 0xff, dtc & 0xff, 0x08], t);
  ingestIsoTp(store, RSP, response, t + 0.01);
}

describe('UdsPanel freeze frames', () => {
  it('shows decoded snapshot values, extended-data kind and a stopped walk', () => {
    const store = createStore();
    exchange(store, 0x123456, [0x59, 0x04, 0x12, 0x34, 0x56, 0x08, 0x01, 0x02, 0xf4, 0x0c, 0x1f, 0x40, 0xf4, 0x05, 0x5a], 0);
    exchange(store, 0x123456, [0x59, 0x06, 0x12, 0x34, 0x56, 0x08, 0x01, 0xaa, 0xbb], 1);
    exchange(store, 0x654321, [0x59, 0x04, 0x65, 0x43, 0x21, 0x08, 0x01, 0x02, 0xf4, 0x0c, 0x1f, 0x40, 0xab, 0xcd, 0x01, 0x02], 2);

    render(<UdsPanel store={store} canTransmit={false} onTransmit={() => ({ ok: true })} />);
    fireEvent.click(screen.getByRole('radio', { name: /dtcs/i }));

    expect(screen.getByText(/snapshot · 1 record · 2 values/)).toBeTruthy();
    expect(document.body.textContent).toContain('ENGINE_SPEED');
    expect(document.body.textContent).toContain('2000 rpm');
    expect(document.body.textContent).toContain('COOLANT_TEMP');
    expect(document.body.textContent).toContain('50 degC');
    expect(screen.getByText(/extended data · record 1 \(manufacturer-specific\)/)).toBeTruthy();
    expect(screen.getByText(/stopped at unknown DID/)).toBeTruthy();
    expect(document.body.textContent).toContain('rest AB CD 01 02');
  });

  it('offers the JSON and CSV export on the DTCs tab when DTCs are present', () => {
    const store = createStore();
    exchange(store, 0x123456, [0x59, 0x04, 0x12, 0x34, 0x56, 0x08], 0);

    render(<UdsPanel store={store} canTransmit={false} onTransmit={() => ({ ok: true })} />);
    expect(screen.queryByRole('button', { name: /export json/i })).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /dtcs/i }));

    expect(screen.getByRole('button', { name: /export json/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /export csv/i })).toBeTruthy();
  });

  it('defaults the composer DID to the first defs DID', () => {
    const store = createStore();
    render(<UdsPanel store={store} canTransmit={false} onTransmit={() => ({ ok: true })} />);
    fireEvent.click(screen.getByRole('radio', { name: /composer/i }));

    const didService = composerServices(DEFS).find((s) => s.allowed && s.takesDid)!;
    fireEvent.change(screen.getByLabelText('service'), { target: { value: String(didService.sid) } });
    const first = DEFS.vehicle.dids[0];
    const expected = `0x${first.did.toString(16).toUpperCase().padStart(4, '0')}`;
    expect((screen.getByLabelText('did') as HTMLSelectElement).value).toBe(expected);
  });

  it('starts the composer on the first allowed service and sub-function from defs', () => {
    const store = createStore();
    render(<UdsPanel store={store} canTransmit={false} onTransmit={() => ({ ok: true })} />);
    fireEvent.click(screen.getByRole('radio', { name: /composer/i }));

    const first = composerServices(DEFS).find((s) => s.allowed)!;
    expect((screen.getByLabelText('service') as HTMLSelectElement).value).toBe(String(first.sid));
    const sub = screen.queryByLabelText('sub-function') as HTMLSelectElement | null;
    if (first.subFunctions) expect(sub?.value).toBe(String(first.subFunctions[0].id));
    else expect(sub).toBeNull();
  });

  it('clears the sub-function when switching to a service without sub-functions', () => {
    const store = createStore();
    render(<UdsPanel store={store} canTransmit={false} onTransmit={() => ({ ok: true })} />);
    fireEvent.click(screen.getByRole('radio', { name: /composer/i }));

    const none = composerServices(DEFS).find((s) => s.allowed && !s.subFunctions)!;
    expect(none).toBeTruthy();
    fireEvent.change(screen.getByLabelText('service'), { target: { value: String(none.sid) } });
    expect(screen.queryByLabelText('sub-function')).toBeNull();
  });
});
