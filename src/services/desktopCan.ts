import { BusRole, CanFrame } from '../types/can';

/**
 * Desktop (Tauri) listen-only CAN source over the Rust HAL (`src-tauri/hal`).
 *
 * `hal_open` resolves only once the adapter is confirmed listen-only (SLCAN
 * `L` acknowledged, or a SocketCAN interface that reports listen-only mode);
 * a refusal rejects with the HAL's message and nothing stays open. Frames
 * arrive as `can-frame` events. There is no transmit command (invariant 1).
 */

export type DesktopAdapterKind = 'slcan' | 'socketcan';

export interface DesktopOpenRequest {
  kind: DesktopAdapterKind;
  /** Serial port path (SLCAN) or interface name (SocketCAN). */
  name: string;
  bitrate: number;
  bus: BusRole;
}

export interface DesktopFrameEvent {
  id: number;
  extended: boolean;
  data: number[];
  rx_time: number;
  bus: string;
}

/** The Tauri bindings the adapter needs; injectable for tests. */
export interface TauriBridge {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, handler: (e: { payload: DesktopFrameEvent }) => void) => Promise<() => void>;
}

export const FRAME_EVENT = 'can-frame';

/** True inside the Tauri webview (the web host never sees these globals). */
export function isDesktop(w: unknown = globalThis): boolean {
  return typeof w === 'object' && w !== null && '__TAURI_INTERNALS__' in (w as Record<string, unknown>);
}

async function defaultBridge(): Promise<TauriBridge> {
  const [{ invoke }, { listen }] = await Promise.all([import('@tauri-apps/api/core'), import('@tauri-apps/api/event')]);
  return { invoke, listen };
}

/** Builds the pipeline frame; timing fields are filled in by the capture pipeline. */
export function frameFromEvent(ev: DesktopFrameEvent, openedAt: number): CanFrame {
  const idLen = ev.extended ? 8 : 3;
  return {
    id: ev.id,
    idHex: `0x${ev.id.toString(16).toUpperCase().padStart(idLen, '0')}`,
    bus: ev.bus,
    dlc: ev.data.length,
    data: [...ev.data],
    timestamp: openedAt + ev.rx_time,
    deltaMs: 0,
    isExtended: ev.extended,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

export class DesktopCanAdapter {
  private unlisten: (() => void) | null = null;
  private open = false;

  constructor(private readonly bridgeFactory: () => Promise<TauriBridge> = defaultBridge) {}

  /** Opens listen-only; rejects on refusal with the HAL's reason. No frame is delivered before it resolves. */
  public async connect(request: DesktopOpenRequest, onFrame: (frame: CanFrame) => void): Promise<void> {
    const bridge = await this.bridgeFactory();
    const openedAt = performance.now() / 1000;
    let unlisten: (() => void) | null = null;
    unlisten = await bridge.listen(FRAME_EVENT, (e) => {
      if (!this.open) return; // never before hal_open confirmed listen-only
      onFrame(frameFromEvent(e.payload, openedAt));
    });
    try {
      await bridge.invoke('hal_open', { request });
    } catch (err) {
      unlisten();
      throw new Error(typeof err === 'string' ? err : (err as Error).message ?? String(err));
    }
    this.unlisten = unlisten;
    this.open = true;
  }

  public async disconnect(): Promise<void> {
    this.open = false;
    this.unlisten?.();
    this.unlisten = null;
    try {
      const bridge = await this.bridgeFactory();
      await bridge.invoke('hal_close');
    } catch {
      // closing a never-opened adapter is not an error
    }
  }

  public isOpen(): boolean {
    return this.open;
  }
}
