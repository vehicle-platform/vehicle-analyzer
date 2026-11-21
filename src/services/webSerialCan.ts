import { BusRole, CanFrame } from '../types/can';

/** One unit of SLCAN adapter output: a bare CR (command OK), a BELL (command refused) or a text line. */
export type SlcanEvent = { kind: 'ok' } | { kind: 'error' } | { kind: 'line'; text: string };

/**
 * Splits adapter output into SLCAN events. Lawicel answers a command with a bare `\r` (OK) or
 * `\a` (BELL, error); received frames and text replies (`V1013`) are text terminated by `\r`.
 * Stray `\n` (some adapters send CR LF) is ignored. Chunks may split anywhere.
 */
/** Longest legal receive line is about 30 characters; text replies are shorter than this. */
const MAX_SLCAN_LINE = 256;

export class SlcanScanner {
  private pending = '';
  /** True while an over-long unterminated line is being skipped (until the next CR or BELL). */
  private overflow = false;

  public push(chunk: string): SlcanEvent[] {
    const events: SlcanEvent[] = [];
    for (const ch of chunk) {
      if (ch === '\x07') {
        this.pending = '';
        this.overflow = false;
        events.push({ kind: 'error' });
      } else if (ch === '\r') {
        const text = this.pending.trim();
        const skipped = this.overflow;
        this.pending = '';
        this.overflow = false;
        if (!skipped) events.push(text ? { kind: 'line', text } : { kind: 'ok' });
      } else if (!this.overflow) {
        this.pending += ch;
        if (this.pending.length > MAX_SLCAN_LINE) {
          // An adapter that never terminates a line must not grow memory without bound.
          this.pending = '';
          this.overflow = true;
        }
      }
    }
    return events;
  }
}

/** The subset of a WebSerial `SerialPort` the adapter uses (a fake one in tests). */
export interface SlcanPort {
  open(options: { baudRate: number }): Promise<void>;
  close(): Promise<void>;
  readable: ReadableStream<Uint8Array> | null;
  writable: WritableStream<Uint8Array> | null;
}

type Reply = 'ok' | 'error' | 'timeout';

/**
 * WebSerial CAN Adapter supporting standard SLCAN (Lawicel ASCII protocol)
 * Compatible with CANable, Candlelight, USB-to-CAN, ESP32 USB-CDC, and ST-Link VCP bridges.
 */
export class WebSerialCanAdapter {
  private port: SlcanPort | null = null;
  private reader: ReadableStreamDefaultReader<string> | null = null;
  private isReading: boolean = false;
  private onFrameCallback: ((frame: CanFrame) => void) | null = null;
  private scanner = new SlcanScanner();
  private readableStreamClosed: Promise<void> | null = null;
  private replyWaiter: ((reply: Reply) => void) | null = null;

  /**
   * `role` is the bus the adapter is plugged into; it decides how frames are decoded.
   * `replyTimeoutMs` bounds the wait for each command's reply.
   */
  constructor(private readonly role: BusRole, private readonly replyTimeoutMs: number = 1000) {}

  public isSupported(): boolean {
    return 'serial' in navigator;
  }

  public isConnected(): boolean {
    return this.port !== null && this.isReading;
  }

  public async connect(
    baudRate: number = 115200,
    onFrame: (frame: CanFrame) => void
  ): Promise<boolean> {
    if (!this.isSupported()) {
      throw new Error('WebSerial API is not supported in this browser. Please use Chrome, Edge, or Brave.');
    }
    const serial = (navigator as Navigator & { serial: { requestPort(): Promise<SlcanPort> } }).serial;
    const port: SlcanPort = await serial.requestPort();
    return this.openPort(port, baudRate, onFrame);
  }

  /** Opens an already chosen port; `connect` is this after the browser's port prompt. */
  public async openPort(
    port: SlcanPort,
    baudRate: number,
    onFrame: (frame: CanFrame) => void
  ): Promise<boolean> {
    try {
      this.onFrameCallback = onFrame;
      this.port = port;
      await this.port.open({ baudRate });
      void this.readLoop();

      // Invariant 1: on the vehicle bus the analyzer only listens. Open the SLCAN
      // channel in listen-only mode (`L`), never in normal mode (`O`), so the adapter
      // neither transmits nor acknowledges frames. `C` first closes a channel an
      // earlier session may have left open (a BELL there only means it was closed);
      // `S6` selects 500 kbit/s (D-009, D-019). Each reply is checked: an adapter that
      // refuses or ignores `L` is never used, and no frame is delivered before `L` is
      // confirmed (E-25 (2)).
      const closed = await this.command('C');
      if (closed === 'timeout') throw new Error('the adapter does not answer SLCAN commands (C)');
      if ((await this.command('S6')) !== 'ok') throw new Error('the adapter refused the 500 kbit/s bit rate (S6)');
      const listen = await this.command('L');
      if (listen !== 'ok') {
        throw new Error(
          listen === 'error'
            ? 'the adapter refused listen-only mode (L); not opened'
            : 'the adapter did not confirm listen-only mode (L); not opened'
        );
      }

      this.isReading = true;
      return true;
    } catch (err: unknown) {
      await this.disconnect();
      throw err;
    }
  }

  /** Sends one command and waits for its reply (bare CR = ok, BELL = error). */
  private async command(cmd: string): Promise<Reply> {
    const reply = new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.replyWaiter = null;
        resolve('timeout');
      }, this.replyTimeoutMs);
      this.replyWaiter = (r) => {
        clearTimeout(timer);
        this.replyWaiter = null;
        resolve(r);
      };
    });
    await this.write(cmd);
    return reply;
  }

  private async write(cmd: string): Promise<void> {
    if (!this.port?.writable) return;
    const writer = this.port.writable.getWriter();
    try {
      await writer.write(new TextEncoder().encode(cmd + '\r'));
    } finally {
      writer.releaseLock();
    }
  }

  public async disconnect(): Promise<void> {
    this.isReading = false;
    this.replyWaiter?.('timeout');
    try {
      if (this.port) {
        await this.write('C').catch(() => undefined);
      }
      if (this.reader) {
        await this.reader.cancel();
        this.reader = null;
      }
      if (this.readableStreamClosed) {
        await this.readableStreamClosed.catch(() => undefined);
        this.readableStreamClosed = null;
      }
      if (this.port) {
        await this.port.close();
        this.port = null;
      }
    } catch (err) {
      console.warn('Error during serial port disconnect:', err);
    }
  }

  private async readLoop() {
    if (!this.port?.readable) return;
    const textDecoder = new TextDecoderStream();
    this.readableStreamClosed = this.port.readable.pipeTo(textDecoder.writable);
    const reader = textDecoder.readable.getReader();
    this.reader = reader;

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }
        if (value) {
          this.processIncomingChunk(value);
        }
      }
    } catch (err) {
      if (this.isReading) console.error('Serial read error:', err);
    } finally {
      reader.releaseLock();
    }
  }

  private processIncomingChunk(chunk: string) {
    for (const ev of this.scanner.push(chunk)) {
      if (ev.kind !== 'line') {
        this.replyWaiter?.(ev.kind);
      } else if (this.isReading) {
        // Frames are delivered only once listen-only mode is confirmed.
        const frame = parseSlcanLine(ev.text, this.role);
        if (frame && this.onFrameCallback) this.onFrameCallback(frame);
      }
    }
  }
}

/**
 * Parses one SLCAN (Lawicel) receive line:
 *   t<id:3 hex><dlc:1><data:2*dlc hex>[ts:4 hex]   e.g. t0208112233445566778
 *   T<id:8 hex><dlc:1><data:2*dlc hex>[ts:4 hex]
 * Remote frames (r/R), status replies and anything malformed return null.
 * Timing (delta, period, frequency) is filled in by the capture pipeline.
 */
export function parseSlcanLine(line: string, bus: string): CanFrame | null {
  const isStd = line.startsWith('t');
  const isExt = line.startsWith('T');
  if (!isStd && !isExt) return null;

  const idLen = isStd ? 3 : 8;
  const idStr = line.substring(1, 1 + idLen);
  const dlcStr = line.substring(1 + idLen, 2 + idLen);
  if (!/^[0-9A-Fa-f]+$/.test(idStr) || idStr.length !== idLen || !/^[0-8]$/.test(dlcStr)) return null;

  const id = parseInt(idStr, 16);
  const dlc = parseInt(dlcStr, 10);
  const dataHex = line.substring(2 + idLen, 2 + idLen + dlc * 2);
  if (dataHex.length !== dlc * 2 || (dlc > 0 && !/^[0-9A-Fa-f]+$/.test(dataHex))) return null;
  if (isStd && id > 0x7ff) return null;
  if (isExt && id > 0x1fffffff) return null; // a CAN identifier has 29 bits

  const data: number[] = [];
  for (let i = 0; i < dataHex.length; i += 2) data.push(parseInt(dataHex.substring(i, i + 2), 16));

  const now = performance.now();
  return {
    id,
    idHex: `0x${id.toString(16).toUpperCase().padStart(idLen, '0')}`,
    bus,
    dlc,
    data,
    timestamp: now / 1000,
    deltaMs: 0,
    isExtended: isExt,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

