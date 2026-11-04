import type { CanFrame } from '../types/can';
import { ascChannelToBus } from './exportService';

export interface ConnCaptureIdSummary {
  id: number;
  extended: boolean;
  count: number;
  minGapMs: number | null;
  maxGapMs: number | null;
  watched: boolean;
}

export interface ConnCaptureEndCounters {
  frames: number;
  ids: number;
  overflow: number;
  lost: number;
  dropped: number;
}

export interface ConnCaptureSummaryBlock {
  timeUs: number;
  final: boolean;
  rows: ConnCaptureIdSummary[];
  end: ConnCaptureEndCounters;
}

export interface ConnCaptureSummary {
  bannerSeen: boolean;
  frames: number;
  skippedLines: number;
  malformedFrames: number;
  restarts: number;
  durationS: number;
  /** A complete FINAL block was read (the node prints it once, 300 s after its start). */
  finalSeen: boolean;
  /**
   * The last complete summary block of each node run, in file order. The node's counters and
   * its per-ID table are cumulative within a run and start again after a restart, so the
   * capture-quality warnings look at every run, not only the last one.
   */
  runBlocks: ConnCaptureSummaryBlock[];
  /** The last complete block of the capture (the last entry of `runBlocks`), for the per-ID table. */
  block: ConnCaptureSummaryBlock | null;
}

const BANNER = '# vehicle-connectivity-node CAN capture';
const VEHICLE_BUS = ascChannelToBus(1);
const RESTART_GAP_US = 1_000_000;

interface ParsedFrame {
  rawUs: number;
  frame: Omit<CanFrame, 'timestamp' | 'deltaMs' | 'periodMs' | 'frequencyHz' | 'count'>;
}

interface BlockBuilder {
  timeUs: number;
  final: boolean;
  rows: ConnCaptureIdSummary[];
}

const isUint = (text: string): boolean => /^\d+$/.test(text);

function parseUint(text: string): number | null {
  if (!isUint(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function parseId(text: string): number | null {
  if (!/^[0-9a-fA-F]{1,8}$/.test(text)) return null;
  const id = Number.parseInt(text, 16);
  return Number.isSafeInteger(id) && id >= 0 ? id : null;
}

function parseGapMs(text: string): number | null | undefined {
  if (text === '-') return null;
  if (!/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function parseFrame(line: string): ParsedFrame | null {
  const parts = line.split(',');
  if (parts.length !== 6) return null;

  const rawUs = parseUint(parts[1]);
  const id = parseId(parts[2]);
  const format = parts[3];
  const dlc = parseUint(parts[4]);
  const dataHex = parts[5];
  if (rawUs === null || id === null || (format !== 'S' && format !== 'X') || dlc === null || dlc > 8) return null;
  const extended = format === 'X';
  if ((!extended && id > 0x7ff) || (extended && id > 0x1fffffff)) return null;
  if (dataHex.length !== dlc * 2 || !/^[0-9a-fA-F]*$/.test(dataHex)) return null;

  const data: number[] = [];
  for (let i = 0; i < dataHex.length; i += 2) data.push(Number.parseInt(dataHex.slice(i, i + 2), 16));

  return {
    rawUs,
    frame: {
      id,
      idHex: `0x${id.toString(16).toUpperCase().padStart(extended ? 8 : 3, '0')}`,
      bus: VEHICLE_BUS,
      dlc,
      data,
      isExtended: extended,
    },
  };
}

function parseSummaryRow(parts: string[]): ConnCaptureIdSummary | null {
  if (parts.length !== 8) return null;
  const id = parseId(parts[2]);
  const format = parts[3];
  const count = parseUint(parts[4]);
  const minGapMs = parseGapMs(parts[5]);
  const maxGapMs = parseGapMs(parts[6]);
  const watched = parts[7];
  if (id === null || (format !== 'S' && format !== 'X') || count === null) return null;
  if (minGapMs === undefined || maxGapMs === undefined || (watched !== 'W' && watched !== '-')) return null;
  const extended = format === 'X';
  if ((!extended && id > 0x7ff) || (extended && id > 0x1fffffff)) return null;
  return { id, extended, count, minGapMs, maxGapMs, watched: watched === 'W' };
}

const END_KEYS = ['frames', 'ids', 'overflow', 'lost', 'dropped'] as const;

function parseEndCounters(parts: string[]): ConnCaptureEndCounters | null {
  if (parts.length !== 3 + END_KEYS.length) return null;
  const counters: Partial<ConnCaptureEndCounters> = {};
  for (const [i, key] of END_KEYS.entries()) {
    const field = parts[3 + i];
    const value = field.startsWith(`${key}=`) ? parseUint(field.slice(key.length + 1)) : null;
    if (value === null) return null;
    counters[key] = value;
  }
  return counters as ConnCaptureEndCounters;
}

/**
 * Parses the vehicle-connectivity-node listen-only capture (format: `CanCaptureCore.h` in that
 * repo). Never throws: unknown lines are counted as skipped, bad `F` lines as malformed.
 *
 * Summary rows of one block share the block's start time and may be interleaved with `F` lines
 * (the node finishes a block over several passes when the serial buffer is full), so rows are
 * grouped by kind and time. A block is complete when its END line was read and it carries one
 * row per tracked ID (`ids=`); a block cut by a reset or by lost serial bytes is ignored.
 *
 * Node restarts: the node clock starts again at 0 after a reset and the banner is printed again.
 * Either signal starts a new run: the capture-banner line after any data line, or an `F` time
 * more than one second before the previous `F` time (a reset that loses the banner to serial
 * noise). Every frame of a new run is offset to start 1 µs after the last frame of the previous
 * run, so timestamps stay monotonic in file order; the real reboot gap is not in the file.
 */
export function parseConnCapture(text: string): { frames: CanFrame[]; summary: ConnCaptureSummary } {
  const frames: CanFrame[] = [];
  let bannerSeen = false;
  let skippedLines = 0;
  let malformedFrames = 0;
  let restarts = 0;
  let finalSeen = false;
  let lastRawUs: number | null = null;
  let lastAdjustedUs = 0;
  let firstAdjustedUs = 0;
  let offsetUs = 0;
  let runHasData = false;
  let runStartPending = false;
  let currentBlock: BlockBuilder | null = null;
  let runBlock: ConnCaptureSummaryBlock | null = null;
  const runBlocks: ConnCaptureSummaryBlock[] = [];

  const startRun = () => {
    restarts += 1;
    if (runBlock !== null) runBlocks.push(runBlock);
    runBlock = null;
    currentBlock = null;
    lastRawUs = null;
    runHasData = false;
    runStartPending = true;
  };

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;

    if (line.startsWith('#')) {
      if (line.startsWith(BANNER)) {
        bannerSeen = true;
        if (runHasData) startRun();
      }
      continue;
    }

    if (line.startsWith('F,')) {
      const parsed = parseFrame(line);
      if (parsed === null) {
        malformedFrames += 1;
        continue;
      }
      if (lastRawUs !== null && parsed.rawUs < lastRawUs - RESTART_GAP_US) startRun();
      if (runStartPending && frames.length > 0) offsetUs = lastAdjustedUs + 1 - parsed.rawUs;
      runStartPending = false;
      runHasData = true;

      const adjustedUs = parsed.rawUs + offsetUs;
      if (frames.length === 0) firstAdjustedUs = adjustedUs;
      lastRawUs = parsed.rawUs;
      lastAdjustedUs = adjustedUs;

      frames.push({
        ...parsed.frame,
        timestamp: adjustedUs / 1_000_000,
        deltaMs: 0,
        periodMs: 0,
        frequencyHz: 0,
        count: 1,
      });
      continue;
    }

    if (line.startsWith('S,') || line.startsWith('FINAL,')) {
      const final = line.startsWith('FINAL,');
      const parts = line.split(',');
      const isEnd = parts[1] === 'END';
      const timeUs = parseUint(isEnd ? parts[2] : parts[1]);
      const end = isEnd ? parseEndCounters(parts) : null;
      const row = isEnd ? null : parseSummaryRow(parts);
      if (timeUs === null || (isEnd ? end === null : row === null)) {
        skippedLines += 1;
        continue;
      }
      runHasData = true;
      const matches = currentBlock !== null && currentBlock.timeUs === timeUs && currentBlock.final === final;

      if (end !== null) {
        const rows = matches && currentBlock !== null ? currentBlock.rows : [];
        if (rows.length === end.ids) {
          runBlock = { timeUs, final, rows, end };
          if (final) finalSeen = true;
        }
        currentBlock = null;
        continue;
      }
      if (!matches || currentBlock === null) currentBlock = { timeUs, final, rows: [] };
      if (row !== null) currentBlock.rows.push(row);
      continue;
    }

    skippedLines += 1;
  }

  if (runBlock !== null) runBlocks.push(runBlock);
  const durationS = frames.length > 0 ? (lastAdjustedUs - firstAdjustedUs) / 1_000_000 : 0;
  return {
    frames,
    summary: {
      bannerSeen,
      frames: frames.length,
      skippedLines,
      malformedFrames,
      restarts,
      durationS,
      finalSeen,
      runBlocks,
      block: runBlocks[runBlocks.length - 1] ?? null,
    },
  };
}
