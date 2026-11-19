import { CanFrame, BusStats } from '../types/can';
import { BatchDtoSchema, CanFrameDtoSchema, EnvelopeSchema, HeartbeatDtoSchema, StatsDtoSchema, type CanFrameDto } from './schemas/stream';

export type StreamStatus = 'connected' | 'connecting' | 'disconnected' | 'error' | 'rejected';

/** Server heartbeat of /ws/live: which producer feeds the stream and how many batches this client lost. */
export interface StreamHeartbeat {
  source: string;
  dropped: number;
}

/** vehicle-server close codes of /ws/live: bad hello or token, and no token configured. Not retried. */
const CLOSE_REJECTED = new Set([1008, 1011]);

export interface WebSocketStreamOptions {
  url: string;
  /** VEHICLE_API_TOKEN, sent in the first (hello) message, never in the URL. */
  token: string;
  onFrame: (frame: CanFrame) => void;
  onStats?: (stats: Partial<BusStats>) => void;
  onHeartbeat?: (heartbeat: StreamHeartbeat) => void;
  onStatusChange?: (status: StreamStatus) => void;
}

export class WebSocketStreamClient {
  private ws: WebSocket | null = null;
  private options: WebSocketStreamOptions;
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null;
  /** Messages or frames dropped because they failed schema validation (never thrown into the render loop). */
  public rejectedCount = 0;
  private shouldReconnect: boolean = true;

  constructor(options: WebSocketStreamOptions) {
    this.options = options;
  }

  public connect() {
    this.shouldReconnect = true;
    this.cleanup();

    if (this.options.onStatusChange) {
      this.options.onStatusChange('connecting');
    }

    try {
      this.ws = new WebSocket(this.options.url);

      this.ws.onopen = () => {
        this.ws?.send(JSON.stringify({ type: 'hello', token: this.options.token }));
        if (this.options.onStatusChange) {
          this.options.onStatusChange('connected');
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const message: unknown = JSON.parse(String(event.data));
          this.handleIncomingMessage(message);
        } catch (err) {
          console.warn('Failed to parse incoming WebSocket JSON:', err);
        }
      };

      this.ws.onclose = (event) => {
        if (CLOSE_REJECTED.has(event.code)) {
          // Wrong token or a server without one: retrying would only repeat the refusal.
          this.shouldReconnect = false;
          if (this.options.onStatusChange) this.options.onStatusChange('rejected');
          return;
        }
        if (this.options.onStatusChange) {
          this.options.onStatusChange('disconnected');
        }
        if (this.shouldReconnect) {
          this.scheduleReconnect();
        }
      };

      this.ws.onerror = (err) => {
        console.warn('WebSocket stream error:', err);
        if (this.options.onStatusChange) {
          this.options.onStatusChange('error');
        }
      };
    } catch (err) {
      console.error('Failed to create WebSocket:', err);
      this.scheduleReconnect();
    }
  }

  public disconnect() {
    this.shouldReconnect = false;
    this.cleanup();
    if (this.options.onStatusChange) {
      this.options.onStatusChange('disconnected');
    }
  }

  private cleanup() {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId);
      this.reconnectTimeoutId = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect() {
    if (!this.reconnectTimeoutId && this.shouldReconnect) {
      this.reconnectTimeoutId = setTimeout(() => {
        this.reconnectTimeoutId = null;
        this.connect();
      }, 3000);
    }
  }

  private handleIncomingMessage(msg: unknown) {
    const parsed = parseStreamMessage(msg);
    this.rejectedCount += parsed.rejected;
    parsed.frames.forEach((f) => this.options.onFrame(f));
    if (parsed.stats && this.options.onStats) this.options.onStats(parsed.stats);
    if (parsed.heartbeat && this.options.onHeartbeat) this.options.onHeartbeat(parsed.heartbeat);
  }
}

/** vehicle-server channel index (CanFrameDto.channel): 1 = vehicle bus, 2 = platform bus. */
export function channelToBus(channel: unknown): string {
  if (channel === 1) return 'vehicle';
  if (channel === 2) return 'platform';
  return typeof channel === 'number' ? `can${channel}` : 'can0';
}

function hexToBytes(hex: string): number[] | null {
  const clean = hex.replace(/\s+/g, '');
  if (clean.length % 2 !== 0 || (clean.length > 0 && !/^[0-9a-fA-F]+$/.test(clean))) return null;
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.substring(i, i + 2), 16));
  return out;
}

function frameFromValidDto(dto: CanFrameDto): CanFrame | null {
  const data = hexToBytes(dto.data_hex);
  if (!data) return null;
  const id = dto.id;
  const isExtended = dto.is_extended === true;
  return {
    id,
    idHex: `0x${id.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0')}`,
    bus: channelToBus(dto.channel),
    dlc: dto.dlc ?? data.length,
    data,
    timestamp: dto.timestamp_us !== undefined ? dto.timestamp_us / 1e6 : performance.now() / 1000,
    deltaMs: 0,
    isExtended,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  };
}

/** Converts one vehicle-server CanFrameDto (schemas/stream.py) into a CanFrame; null when it fails validation. */
export function frameFromDto(raw: unknown): CanFrame | null {
  const parsed = CanFrameDtoSchema.safeParse(raw);
  return parsed.success ? frameFromValidDto(parsed.data) : null;
}

function statsFromDto(raw: unknown): Partial<BusStats> | undefined {
  const parsed = StatsDtoSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const dto = parsed.data;
  const out: Partial<BusStats> = {};
  if (dto.bus_load_pct !== undefined) out.busLoadPct = dto.bus_load_pct;
  if (dto.frame_rate_hz !== undefined) out.msgPerSec = dto.frame_rate_hz;
  if (dto.error_frames !== undefined) out.errorFrames = dto.error_frames;
  return out;
}

export interface ParsedStreamMessage {
  frames: CanFrame[];
  stats?: Partial<BusStats>;
  heartbeat?: StreamHeartbeat;
  /** Frames or messages that failed validation and were dropped. */
  rejected: number;
}

/**
 * Parses one WebSocket message of the vehicle-server stream protocol: a StreamMessageDto
 * envelope ({type, payload}) carrying a frame, a batch, stats or a heartbeat. A bare StreamBatchDto
 * or CanFrameDto is accepted too. Unknown or malformed content yields nothing (and is counted).
 */
export function parseStreamMessage(msg: unknown): ParsedStreamMessage {
  const result: ParsedStreamMessage = { frames: [], rejected: 0 };
  if (!msg || typeof msg !== 'object') {
    result.rejected++;
    return result;
  }

  const addFrame = (raw: unknown) => {
    const frame = frameFromDto(raw);
    if (frame) result.frames.push(frame);
    else result.rejected++;
  };

  const handleBatch = (raw: unknown) => {
    const batch = BatchDtoSchema.safeParse(raw);
    if (!batch.success) {
      result.rejected++;
      return;
    }
    for (const f of batch.data.frames ?? []) addFrame(f);
    if (batch.data.stats) result.stats = statsFromDto(batch.data.stats);
  };

  const envelope = EnvelopeSchema.safeParse(msg);
  if (envelope.success && 'payload' in msg) {
    const { type, payload } = envelope.data;
    if (type === 'frame') {
      addFrame(payload);
    } else if (type === 'batch') {
      handleBatch(payload);
    } else if (type === 'stats') {
      result.stats = statsFromDto(payload);
    } else if (type === 'heartbeat') {
      const hb = HeartbeatDtoSchema.safeParse(payload);
      if (hb.success) result.heartbeat = { source: hb.data.source, dropped: hb.data.dropped ?? 0 };
      else result.rejected++;
    }
    return result;
  }

  if ('frames' in msg && Array.isArray(msg.frames)) {
    handleBatch(msg);
    return result;
  }

  addFrame(msg);
  return result;
}
