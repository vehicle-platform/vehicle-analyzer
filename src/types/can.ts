export interface CanFrame {
  id: number;
  idHex: string;
  bus: string;
  dlc: number;
  data: number[];
  timestamp: number;
  deltaMs: number;
  isExtended: boolean;
  periodMs: number;
  frequencyHz: number;
  count: number;
  name?: string;
  decodedSignals?: Record<string, number | string>;
  prevData?: number[];
  changedBytes?: boolean[];
  /** E2E receiver status for E2E-protected platform messages (docs/e2e-profile.md). */
  e2e?: import('../services/e2e').E2EStatus;
}

export interface DecodedSignal {
  name: string;
  value: number;
  unit: string;
  min?: number;
  max?: number;
  timestamp: number;
  frameId: number;
}

export interface BusStats {
  busLoadPct: number;
  msgPerSec: number;
  errorFrames: number;
  totalRx: number;
  uptimeSec: number;
}

export type ByteActivityStatus = 'static' | 'inc' | 'dec' | 'toggling';

export interface ByteSnifferRecord {
  id: number;
  bus: string;
  idHex: string;
  name?: string;
  dlc: number;
  currentBytes: number[];
  prevBytes: number[];
  byteStatuses: ByteActivityStatus[];
  changeCounts: number[];
  notchedBytes: boolean[]; // When true, changes on this byte are ignored
  lastUpdated: number;
  frameHistory: { timestamp: number; data: number[] }[];
  bitFlips: number[]; // 64 bit flip counters, index = byte * 8 + (7 - bit)
  /** Last change direction per byte: +1 up, -1 down, 0 none yet. */
  lastDirections: number[];
  /** Frames compared for the flip counters (first frame of an ID is not a comparison). */
  framesCompared: number;
}

export interface DtcRecord {
  code: string;
  description: string;
  statusMask: number;
  active: boolean;
  pending: boolean;
  confirmed: boolean;
  freezeFrame?: Record<string, string | number>;
}

export interface DbcSignalDef {
  name: string;
  startBit: number;
  bitLength: number;
  isLittleEndian: boolean;
  isSigned: boolean;
  factor: number;
  offset: number;
  min: number;
  max: number;
  unit: string;
  comment?: string;
  receivers?: string[];
  /** Value table (VAL_): raw value -> name. */
  values?: Record<number, string>;
}

export interface DbcMessageDef {
  id: number;
  name: string;
  dlc: number;
  sender: string;
  signals: DbcSignalDef[];
  isExtended?: boolean;
  /** GenMsgCycleTime attribute in ms (0 or unset = not periodic). */
  cycleTimeMs?: number;
  /** E2E profile parameters when E2E_Protected = Yes (docs/e2e-profile.md). */
  e2e?: { dataId: number };
  comment?: string;
}

export interface DbcCatalog {
  version: string;
  nodes: { name: string; nodeId?: number; comment?: string }[];
  messages: DbcMessageDef[];
}

/** Every cockpit view; the type and the layout check (`ui/layout.ts`) both derive from it. */
export const COCKPIT_TABS = ['trace', 'sniffer', 'oscilloscope', 'uds', 'health', 'cluster', 'sync', 'session', 'compare', 'track', 'rides'] as const;
export type CockpitTab = (typeof COCKPIT_TABS)[number];
export type TraceMode = 'overwrite' | 'scroll';
export type TelemetrySource = 'virtual' | 'local_file' | 'websocket' | 'webserial' | 'server_session';

/** Bus a source's frames belong to: decides which defs catalog decodes them. */
export type BusRole = 'vehicle' | 'platform';
