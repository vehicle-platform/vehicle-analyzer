import { ByteSnifferRecord, CanFrame, DbcMessageDef } from '../types/can';
import { Defs } from '../defs/model';
import { FramePipeline, didKey, signalKey } from '../services/pipeline';
import { UdsMonitor } from '../services/udsMonitor';
import { BusLoadMeter, frameKey } from '../services/capture';
import { updateSnifferRecord } from '../services/sniffer';
import { RingBuffer, SeriesRing } from './ring';

export interface BusLoad {
  loadPct: number;
  framesPerSec: number;
  peakPct: number;
}

export interface RecordedMeta {
  label: string;
  group: string;
  unit: string;
}

export interface SeriesPoint {
  time: number;
  value: number;
}

/** Chronological log: 50 000 frames (about 25 s of a fully loaded 500 kbit/s bus). */
export const LOG_CAPACITY = 50_000;
/** Samples kept per signal: 12 000 (4 min at 50 Hz), two Float64Arrays each. */
export const HISTORY_CAPACITY = 12_000;
/** Tables and text re-render at most this often; the oscilloscope draws on its own animation frames. */
export const UI_REFRESH_MS = 66;

/**
 * Everything the analyzer has captured, outside React. Sources push frames with
 * `ingest` (O(1), no React work); panels read through `useCapture`, which re-renders
 * them at most every UI_REFRESH_MS however fast frames arrive. `dataVersion` changes on
 * every frame for canvas views that poll it per animation frame.
 */
export class CaptureStore {
  public readonly pipeline: FramePipeline;
  public readonly monitor: UdsMonitor;
  public framesByKey = new Map<string, CanFrame>();
  public log = new RingBuffer<CanFrame>(LOG_CAPACITY);
  public sniffer = new Map<string, ByteSnifferRecord>();
  public history = new Map<string, SeriesRing>();
  public dataVersion = 0;
  public busLoad = new Map<string, BusLoad>();
  public totalRx = 0;
  public lastTime = 0;
  /** Wall clock (performance.now, ms) when the newest frame arrived; 0 before the first. */
  public lastIngestWallMs = 0;
  public customPlatformDbc: string | null = null;
  /**
   * Label, group and unit of recorded session series that defs do not describe (sensor, derived).
   * Kept across clear() (a backward replay seek clears the views); a new source resets it.
   */
  public recordedMeta = new Map<string, RecordedMeta>();

  private meter = new BusLoadMeter();
  private listeners = new Set<() => void>();
  private version = 0;
  private notifyScheduled = false;

  constructor(public readonly defs: Defs) {
    this.pipeline = new FramePipeline(defs.platform.messages, defs.vehicleDbc.messages);
    this.monitor = new UdsMonitor(defs);
    this.monitor.onDid = (s) => {
      if (typeof s.value === 'number') this.pushPoint(didKey(s.name), s.t, s.value);
    };
  }

  public ingest(raw: CanFrame) {
    const frame = this.pipeline.process(raw);
    if (frame.bus === 'vehicle' && !frame.name) frame.name = this.udsName(frame.id);
    const key = frameKey(frame.bus, frame.id);
    this.totalRx += 1;
    this.lastTime = frame.timestamp;
    this.lastIngestWallMs = performance.now();
    this.meter.add(frame);

    const prev = this.framesByKey.get(key);
    this.framesByKey.set(key, {
      ...frame,
      prevData: prev?.data,
      changedBytes: prev ? frame.data.map((b, i) => prev.data[i] !== b) : undefined,
    });

    this.log.push(frame);
    this.dataVersion++;

    this.sniffer.set(key, updateSnifferRecord(this.sniffer.get(key), frame));

    if (frame.name && frame.decodedSignals) {
      for (const [sig, v] of Object.entries(frame.decodedSignals)) {
        if (typeof v === 'number') this.pushPoint(signalKey(frame.name, sig), frame.timestamp, v);
      }
    }

    if (frame.bus === 'vehicle' && this.monitor.isUdsId(frame.id)) this.monitor.process(frame);

    this.notify();
  }

  /**
   * One recorded sample of a stored session (replay or "load all"). Pushes into the history
   * like a decoded signal; no frame, log or bus-load side effects.
   */
  public ingestSample(key: string, time: number, value: number) {
    this.pushPoint(key, time, value);
    if (time > this.lastTime) this.lastTime = time;
    this.lastIngestWallMs = performance.now();
    this.dataVersion++;
    this.notify();
  }

  /** Registers display metadata for a recorded key that defs do not describe. */
  public setRecordedMeta(key: string, meta: RecordedMeta) {
    this.recordedMeta.set(key, meta);
  }

  /** Forgets the recorded metadata (a new session or log was loaded). */
  public resetRecordedMeta() {
    this.recordedMeta = new Map();
  }

  /** Trace names of the UDS IDs from uds/vehicle_cl250.yaml addressing. */
  private udsName(id: number): string | undefined {
    const a = this.defs.vehicle.addressing;
    if (id === a.primary.requestId) return 'UDS request (tester)';
    if (id === a.primary.responseId) return 'UDS response (ECU)';
    if (a.fallback && id === a.fallback.requestId) return 'UDS request (fallback ID)';
    if (a.fallback && id === a.fallback.responseId) return 'UDS response (fallback ID)';
    if (a.functionalWatchIds.some((w) => w.id === id)) return 'OBD functional request (2nd tester!)';
    return undefined;
  }

  private pushPoint(key: string, time: number, value: number) {
    let ring = this.history.get(key);
    if (!ring) {
      ring = new SeriesRing(HISTORY_CAPACITY);
      this.history.set(key, ring);
    }
    ring.push(time, value);
  }

  /** Once per second of wall time: bus load (in source time) and E2E timeouts. */
  public sampleSecond(sourceSec: number) {
    this.busLoad = new Map(this.meter.sample(sourceSec));
    this.pipeline.checkTimeouts(this.lastTime);
    this.notify();
  }

  public setPlatformCatalog(messages: DbcMessageDef[], customName: string | null) {
    this.pipeline.setCatalog('platform', messages);
    this.customPlatformDbc = customName;
    this.notify();
  }

  public toggleNotch(key: string, byteIdx: number) {
    const rec = this.sniffer.get(key);
    if (!rec) return;
    const notched = [...rec.notchedBytes];
    notched[byteIdx] = !notched[byteIdx];
    this.sniffer.set(key, { ...rec, notchedBytes: notched });
    this.notify();
  }

  public invertNotch(key: string) {
    const rec = this.sniffer.get(key);
    if (!rec) return;
    this.sniffer.set(key, { ...rec, notchedBytes: rec.notchedBytes.map((n) => !n) });
    this.notify();
  }

  public clearNotches() {
    this.sniffer.forEach((rec, key) => this.sniffer.set(key, { ...rec, notchedBytes: new Array<boolean>(8).fill(false) }));
    this.notify();
  }

  public clear() {
    this.framesByKey = new Map();
    this.log = new RingBuffer<CanFrame>(LOG_CAPACITY);
    this.dataVersion++;
    this.sniffer = new Map();
    this.history = new Map();
    this.busLoad = new Map();
    this.totalRx = 0;
    this.lastTime = 0;
    this.lastIngestWallMs = 0;
    this.meter.reset();
    this.pipeline.reset();
    this.monitor.reset();
    this.notify();
  }

  // ------------------------------------------------------------ subscription

  public subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  public getVersion = () => this.version;

  /** Coalesces change notifications to one per UI_REFRESH_MS. */
  public notify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    setTimeout(() => {
      this.notifyScheduled = false;
      this.version++;
      this.listeners.forEach((fn) => fn());
    }, UI_REFRESH_MS);
  }
}
