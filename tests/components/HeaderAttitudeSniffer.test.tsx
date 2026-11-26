// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Header, TABS } from '@/components/Header';
import { AttitudeGauge } from '@/components/AttitudeGauge';
import { SnifferPanel } from '@/components/SnifferPanel';
import { createStore, ingestFrame, platformMessage } from './helpers';
import { frameKey } from '@/services/capture';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Header', () => {
  const baseProps = () => ({
    activeTab: 'trace' as const,
    onTabChange: vi.fn(),
    isRunning: true,
    onTogglePlay: vi.fn(),
    onClear: vi.fn(),
    busLoad: new Map(),
    msgPerSec: 42,
    totalRx: 1200,
    source: 'virtual' as const,
    onSourceChange: vi.fn(),
    usbRole: 'vehicle' as const,
    onUsbRoleChange: vi.fn(),
    wsUrl: 'ws://192.168.1.20:8000/ws',
    onWsUrlChange: vi.fn(),
    wsToken: '',
    onWsTokenChange: vi.fn(),
    wsSource: 'mock',
    wsStatus: 'connected' as const,
    defsRef: 'v0.33.0',
    customDbc: null,
    showAttitudeHud: false,
    onToggleAttitudeHud: vi.fn(),
    theme: 'dark' as const,
    onToggleTheme: vi.fn(),
  });

  it('renders virtual/websocket/webserial/desktop sources, bus meters, and tab controls', () => {
    const props = baseProps();
    const { rerender } = render(<Header {...props} />);
    expect(screen.getByText('defs v0.33.0')).toBeTruthy();
    expect(screen.getByText('1,200')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /Sniffer/ }));
    expect(props.onTabChange).toHaveBeenCalledWith('sniffer');
    fireEvent.click(screen.getByText('Pause'));
    expect(props.onTogglePlay).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('Clear'));
    expect(props.onClear).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('HUD'));
    expect(props.onToggleAttitudeHud).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('light'));
    expect(props.onToggleTheme).toHaveBeenCalledTimes(1);

    // WebSocket mode with remote cleartext warning and custom DBC badge
    const loads = new Map([
      ['platform', { loadPct: 12.5, framesPerSec: 100, peakPct: 20 }],
      ['vehicle', { loadPct: 5.0, framesPerSec: 40, peakPct: 9 }],
    ]);
    rerender(
      <Header
        {...props}
        source="websocket"
        customDbc="bench.dbc"
        busLoad={loads}
        theme="light"
        isRunning={false}
      />
    );
    expect(screen.getByText('! custom DBC: bench.dbc')).toBeTruthy();
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('WebSocket URL'), { target: { value: 'wss://example.com/ws' } });
    expect(props.onWsUrlChange).toHaveBeenCalledWith('wss://example.com/ws');
    fireEvent.change(screen.getByLabelText('vehicle-server API token'), { target: { value: 'sec' } });
    expect(props.onWsTokenChange).toHaveBeenCalledWith('sec');

    // WebSerial mode
    rerender(<Header {...props} source="webserial" />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'platform' } });
    expect(props.onUsbRoleChange).toHaveBeenCalledWith('platform');

    // Desktop mode
    const onKindChange = vi.fn();
    const onNameChange = vi.fn();
    rerender(
      <Header
        {...props}
        source="desktop"
        desktop={{ kind: 'slcan', name: '/dev/ttyACM0', onKindChange, onNameChange }}
      />
    );
    fireEvent.change(screen.getByLabelText('Adapter kind'), { target: { value: 'socketcan' } });
    expect(onKindChange).toHaveBeenCalledWith('socketcan');
    fireEvent.change(screen.getByLabelText('Adapter port or interface'), { target: { value: 'can0' } });
    expect(onNameChange).toHaveBeenCalledWith('can0');
    expect(TABS.length).toBe(12);
  });
});

function enumValue(msg: ReturnType<typeof platformMessage>, signalName: string, label: string): number {
  const sig = msg.signals.find((s) => s.name === signalName);
  const entry = Object.entries(sig?.values ?? {}).find(([, v]) => v === label);
  if (!entry) throw new Error(`enum ${signalName}=${label} not found in defs`);
  return Number(entry[0]);
}

describe('AttitudeGauge', () => {
  it('shows NO DATA and UNAVAILABLE before valid frames, then renders EKF lean and safety levels', () => {
    const store = createStore();
    const { rerender } = render(<AttitudeGauge store={store} />);
    expect(screen.getByText('NO DATA')).toBeTruthy();
    expect(screen.getByText('UNAVAILABLE')).toBeTruthy();

    const leanMsg = platformMessage((m) => m.name === 'EkfLean');
    const warnMsg = platformMessage((m) => m.name === 'SafetyWarningStatus');
    const est = enumValue(leanMsg, 'LEAN_ANGLE_STATE', 'ESTIMATED');
    const green = enumValue(warnMsg, 'CORNERING_LEVEL', 'GREEN');
    const yellow = enumValue(warnMsg, 'CORNERING_LEVEL', 'YELLOW');
    const red = enumValue(warnMsg, 'CORNERING_LEVEL', 'RED');

    // Valid EKF lean right + RED safety level (counter 1 after initial 0 so E2E is OK)
    ingestFrame(store, leanMsg, 1.0, { LEAN_ANGLE: 24.5, LEAN_ANGLE_STATE: est, LEAN_ANGLE_QUALITY: 95 }, 0);
    ingestFrame(store, leanMsg, 1.02, { LEAN_ANGLE: 24.5, LEAN_ANGLE_STATE: est, LEAN_ANGLE_QUALITY: 95 }, 1);
    ingestFrame(store, warnMsg, 1.0, { CORNERING_LEVEL: red, CORNERING_SOURCE: 1, BSM_LEFT: 1, BSM_RIGHT: 0, IMMOBILIZER_STATE: 0 }, 0);
    ingestFrame(store, warnMsg, 1.02, { CORNERING_LEVEL: red, CORNERING_SOURCE: 1, BSM_LEFT: 1, BSM_RIGHT: 0, IMMOBILIZER_STATE: 0 }, 1);

    rerender(<AttitudeGauge store={store} />);
    expect(screen.getByText(/lean, right/)).toBeTruthy();
    expect(screen.getByText('95 %')).toBeTruthy();
    expect(screen.getByText(/RED/)).toBeTruthy();

    // Left lean + YELLOW / GREEN branches
    ingestFrame(store, leanMsg, 1.04, { LEAN_ANGLE: -18.0, LEAN_ANGLE_STATE: est, LEAN_ANGLE_QUALITY: 90 }, 2);
    ingestFrame(store, warnMsg, 1.04, { CORNERING_LEVEL: yellow, CORNERING_SOURCE: 1 }, 2);
    rerender(<AttitudeGauge store={store} />);
    expect(screen.getByText(/lean, left/)).toBeTruthy();
    expect(screen.getByText(/YELLOW/)).toBeTruthy();

    ingestFrame(store, warnMsg, 1.06, { CORNERING_LEVEL: green, CORNERING_SOURCE: 1 }, 3);
    rerender(<AttitudeGauge store={store} />);
    expect(screen.getByText(/GREEN/)).toBeTruthy();
  });
});

describe('SnifferPanel', () => {
  it('renders empty state, heatmap bytes, notch actions, hotkeys, and flow view', () => {
    Element.prototype.scrollIntoView = vi.fn();
    const store = createStore();
    const { rerender } = render(<SnifferPanel store={store} />);
    expect(screen.getByText(/No CAN activity yet/)).toBeTruthy();

    const msg1 = platformMessage((m) => m.name === 'EkfLean');
    const msg2 = platformMessage((m) => m.name === 'SafetyWarningStatus');
    ingestFrame(store, msg1, 1.0, { LEAN_ANGLE: 5 }, 0);
    ingestFrame(store, msg1, 1.1, { LEAN_ANGLE: 15 }, 1);
    ingestFrame(store, msg1, 1.2, { LEAN_ANGLE: 10 }, 2);
    ingestFrame(store, msg2, 1.3, { CORNERING_LEVEL: 1 }, 0);

    rerender(<SnifferPanel store={store} />);
    const key1 = frameKey('platform', msg1.id);

    // Click a byte button to notch it
    const byteButtons = screen.getAllByTitle(/^Byte 0:/);
    fireEvent.click(byteButtons[0]);
    expect(store.sniffer.get(key1)?.notchedBytes[0]).toBe(true);

    // Hotkey navigation & invert/reset notches
    fireEvent.keyDown(window, { key: 'j' });
    fireEvent.keyDown(window, { key: 'k' });
    fireEvent.click(screen.getByRole('button', { name: /Invert notch/ }));
    expect(store.sniffer.get(key1)?.notchedBytes[0]).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Reset notches/ }));
    expect(store.sniffer.get(key1)?.notchedBytes.every((b) => !b)).toBe(true);

    // Toggle to Flow view via hotkey 'v'
    fireEvent.keyDown(window, { key: 'v' });
    expect(screen.getByText('Flow')).toBeTruthy();
    expect(screen.getByText('anchor')).toBeTruthy();
  });
});
