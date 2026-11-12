import { DEFS } from '@/defs';
import { CaptureStore } from '@/state/captureStore';
import { encodeFrameSignals } from '@/services/dbcParser';
import { e2eProtect } from '@/services/e2e';
import type { CanFrame, DbcMessageDef } from '@/types/can';

export const createStore = () => new CaptureStore(DEFS);

export function platformMessage(predicate: (message: DbcMessageDef) => boolean): DbcMessageDef {
  const message = DEFS.platform.messages.find(predicate);
  if (!message) throw new Error('test message not found in defs');
  return message;
}

/** Builds a platform frame from defs, optionally signing it through the real E2E sender. */
export function ingestFrame(
  store: CaptureStore,
  message: DbcMessageDef,
  timestamp: number,
  values: Record<string, number>,
  counter = 0
): CanFrame {
  const payload = encodeFrameSignals(message, values);
  const data = message.e2e ? e2eProtect(message.e2e.dataId, payload, counter) : payload;
  const frame: CanFrame = {
    id: message.id,
    idHex: `0x${message.id.toString(16).toUpperCase().padStart(message.isExtended ? 8 : 3, '0')}`,
    bus: 'platform',
    dlc: message.dlc,
    data,
    timestamp,
    deltaMs: 0,
    isExtended: message.isExtended ?? false,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
  store.ingest(frame);
  return frame;
}

/** Sets the CSS tokens that themeColor reads, so SVG panels do not get `rgb()` colours in jsdom. */
export function setThemeColors(): void {
  document.documentElement.style.setProperty('--t-hi', '230 230 230');
  document.documentElement.style.setProperty('--t-amber', '255 180 0');
}

export const jsonResponse = (body: unknown) =>
  ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;
