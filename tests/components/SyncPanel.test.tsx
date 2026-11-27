// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SyncPanel } from '@/components/SyncPanel';
import { startLogIngest, type LogIngestHandlers, type LogIngestJob } from '@/services/ingestClient';
import { MAX_LOG_FILE_BYTES } from '@/services/importLimits';
import type { CanFrame } from '@/types/can';
import type { ConnCaptureSummary } from '@/services/connCaptureParser';
import { createStore } from './helpers';

vi.mock('@/services/ingestClient', () => ({
  startLogIngest: vi.fn(),
}));

const startLogIngestMock = vi.mocked(startLogIngest);

function makeFrame(id = 0x021, t = 1.0): CanFrame {
  return {
    id,
    idHex: `0x${id.toString(16).toUpperCase().padStart(3, '0')}`,
    bus: 'platform',
    dlc: 8,
    data: [0, 0, 0, 0, 0, 0, 0, 0],
    timestamp: t,
    deltaMs: 0,
    isExtended: false,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

function getInputs(container: HTMLElement): { dbc: HTMLInputElement; log: HTMLInputElement } {
  const inputs = Array.from(container.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
  const dbc = inputs.find((el) => el.accept === '.dbc');
  const log = inputs.find((el) => el.accept.includes('.asc'));
  if (!dbc || !log) throw new Error('expected DBC and log file inputs');
  return { dbc, log };
}

beforeEach(() => {
  startLogIngestMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe('SyncPanel', () => {
  it('displays pinned defs messages and UDS DIDs and navigates via clicks and hotkeys', () => {
    const store = createStore();
    const catalog = store.pipeline.catalog('platform');
    expect(catalog.length).toBeGreaterThanOrEqual(2);

    render(<SyncPanel store={store} source="virtual" onLogLoaded={vi.fn()} />);

    expect(screen.getByText(/decoding from the pinned defs only/i)).toBeTruthy();
    expect(screen.getAllByText(catalog[0].name).length).toBeGreaterThanOrEqual(1);

    // Hotkey j advances to the second platform message; k returns to the first
    fireEvent.keyDown(window, { key: 'j' });
    expect(screen.getByRole('button', { name: new RegExp(catalog[1].name) }).getAttribute('aria-current')).toBe('true');

    fireEvent.keyDown(window, { key: 'k' });
    expect(screen.getByRole('button', { name: new RegExp(catalog[0].name) }).getAttribute('aria-current')).toBe('true');

    // Switch to UDS DIDs view
    fireEvent.click(screen.getByRole('button', { name: /UDS DIDs/i }));
    expect(screen.getByText(/identification DIDs in uds\/obd_catalog\.yaml/i)).toBeTruthy();
    expect(screen.getByText(/republished as/i)).toBeTruthy();
  });

  it('loads a valid custom DBC via FileReader, rejects an empty DBC, and resets to pinned defs', async () => {
    const store = createStore();
    const { container } = render(<SyncPanel store={store} source="virtual" onLogLoaded={vi.fn()} />);
    const { dbc } = getInputs(container);

    // Invalid DBC with no BO_ messages leaves catalog unchanged
    const badDbc = new File(['VERSION "1.0"\nNS_ :\n'], 'empty.dbc', { type: 'text/plain' });
    fireEvent.change(dbc, { target: { files: [badDbc] } });

    await waitFor(() => {
      expect(screen.getByText(/empty\.dbc defines no messages/i)).toBeTruthy();
    });
    expect(store.customPlatformDbc).toBeNull();

    // Valid custom DBC replaces platform catalog and enables reset
    const goodDbcText = [
      'VERSION "custom"',
      'BO_ 256 CustomMsg: 8 TESTNODE',
      ' SG_ CustomSig : 0|16@1+ (0.1,0) [0|100] "rpm" Vector__XXX',
      '',
    ].join('\n');
    const goodDbc = new File([goodDbcText], 'custom.dbc', { type: 'text/plain' });
    fireEvent.change(dbc, { target: { files: [goodDbc] } });

    await waitFor(() => {
      expect(screen.getByText(/! custom DBC: custom\.dbc/i)).toBeTruthy();
    });
    expect(store.customPlatformDbc).toBe('custom.dbc');
    expect(screen.getByText('CustomSig')).toBeTruthy();

    // Hotkey r resets back to pinned defs
    fireEvent.keyDown(window, { key: 'r' });
    await waitFor(() => {
      expect(screen.getByText(/Back to platform\.dbc of defs/i)).toBeTruthy();
    });
    expect(store.customPlatformDbc).toBeNull();
  });

  it('imports a log through the worker client with progress, capture summary, and completion', async () => {
    const store = createStore();
    const onLogLoaded = vi.fn();
    const captured: { current: LogIngestHandlers | null } = { current: null };
    const cancel = vi.fn();

    startLogIngestMock.mockImplementation((_req, cbs): LogIngestJob => {
      captured.current = cbs;
      return { cancel };
    });

    const { container } = render(<SyncPanel store={store} source="local_file" onLogLoaded={onLogLoaded} />);
    const { log } = getInputs(container);

    const ascFile = new File(['date Fri Nov 27\n0.001 2 021 Rx d 8 00 00 00 00 00 00 00 00\n'], 'ride.asc', {
      type: 'text/plain',
    });
    fireEvent.change(log, { target: { files: [ascFile] } });

    await waitFor(() => {
      expect(startLogIngestMock).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole('progressbar', { name: /Importing ride\.asc/i })).toBeTruthy();

    const frame = makeFrame(0x021, 0.5);
    const summary: ConnCaptureSummary = {
      bannerSeen: true,
      frames: 1,
      skippedLines: 0,
      malformedFrames: 0,
      restarts: 0,
      durationS: 10,
      finalSeen: true,
      runBlocks: [],
      block: null,
    };

    act(() => {
      captured.current?.onProgress(1, 2);
      captured.current?.onBatch([frame]);
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');

    act(() => {
      captured.current?.onDone(1, summary);
    });

    expect(onLogLoaded).toHaveBeenCalledWith([frame], 'ride.asc');
    expect(screen.getByText(/Loaded 1 frames from ride\.asc for replay/i)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
  });

  it('handles empty log, worker error, oversized file, cancel button, source switch, and unmount', async () => {
    const store = createStore();
    const onLogLoaded = vi.fn();
    const captured: { current: LogIngestHandlers | null } = { current: null };
    const cancel = vi.fn();

    startLogIngestMock.mockImplementation((_req, cbs): LogIngestJob => {
      captured.current = cbs;
      return { cancel };
    });

    const { container, rerender, unmount } = render(
      <SyncPanel store={store} source="local_file" onLogLoaded={onLogLoaded} />
    );
    const { log } = getInputs(container);

    // 1. Oversized file fails before starting worker ingest
    const huge = new File(['x'], 'huge.asc', { type: 'text/plain' });
    Object.defineProperty(huge, 'size', { value: MAX_LOG_FILE_BYTES + 1 });
    fireEvent.change(log, { target: { files: [huge] } });
    expect(startLogIngestMock).not.toHaveBeenCalled();

    // 2. Empty parsed log reports no frames and does not call onLogLoaded
    const emptyLog = new File(['not-a-frame'], 'empty.csv', { type: 'text/plain' });
    fireEvent.change(log, { target: { files: [emptyLog] } });
    await waitFor(() => expect(startLogIngestMock).toHaveBeenCalledTimes(1));
    act(() => {
      captured.current?.onDone(0);
    });
    expect(screen.getByText(/No CAN frame could be read from empty\.csv/i)).toBeTruthy();
    expect(onLogLoaded).not.toHaveBeenCalled();

    // 3. Worker error surfaces error message
    const errLog = new File(['bad'], 'broken.csv', { type: 'text/plain' });
    fireEvent.change(log, { target: { files: [errLog] } });
    await waitFor(() => expect(startLogIngestMock).toHaveBeenCalledTimes(2));
    act(() => {
      captured.current?.onError('corrupt header');
    });
    expect(screen.getByText(/Could not import broken\.csv: corrupt header/i)).toBeTruthy();

    // 4. Cancel button cancels active job and drops late callbacks
    const cancelLog = new File(['0.001 2 021 Rx d 8 00'], 'cancel.asc', { type: 'text/plain' });
    fireEvent.change(log, { target: { files: [cancelLog] } });
    await waitFor(() => expect(startLogIngestMock).toHaveBeenCalledTimes(3));
    const staleCallbacks = captured.current;
    act(() => {
      staleCallbacks?.onProgress(10, 100);
    });
    fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/Import of cancel\.asc cancelled/i)).toBeTruthy();
    // Late batch/done from cancelled job is ignored
    act(() => {
      staleCallbacks?.onBatch([makeFrame()]);
      staleCallbacks?.onDone(1);
    });
    expect(onLogLoaded).not.toHaveBeenCalled();

    // 5. Switching live source away from local_file cancels an active import
    const switchLog = new File(['0.001 2 021 Rx d 8 00'], 'switch.asc', { type: 'text/plain' });
    fireEvent.change(log, { target: { files: [switchLog] } });
    await waitFor(() => expect(startLogIngestMock).toHaveBeenCalledTimes(4));
    rerender(<SyncPanel store={store} source="virtual" onLogLoaded={onLogLoaded} />);
    await waitFor(() => expect(cancel).toHaveBeenCalledTimes(2));

    // 6. Unmounting cancels an active import
    const unmountLog = new File(['0.001 2 021 Rx d 8 00'], 'unmount.asc', { type: 'text/plain' });
    fireEvent.change(log, { target: { files: [unmountLog] } });
    await waitFor(() => expect(startLogIngestMock).toHaveBeenCalledTimes(5));
    unmount();
    expect(cancel).toHaveBeenCalledTimes(3);
  });
});
