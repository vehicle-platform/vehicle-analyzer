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

function parseEndCounters(parts: string[]): ConnCaptureEndCounters | null {
  if (parts.length !== 8) return null;
  const counters: number[] = [];
  for (let i = 3; i < 8; i++) {
    const value = parseUint(parts[i].replace(/^(frames|ids|overflow|lost|dropped)=/, ''));
    if (value === null) return null;
    counters.push(value);
  }
  if (
    !parts[3].startsWith('frames=') ||
    !parts[4].startsWith('ids=') ||
    !parts[5].startsWith('overflow=') ||
    !parts[6].startsWith('lost=') ||
    !parts[7].startsWith('dropped=')
  ) {
    return null;
  }
  return { frames: counters[0], ids: counters[1], overflow: counters[2], lost: counters[3], dropped: counters[4] };
}

export function parseConnCapture(text: string): { frames: CanFrame[]; summary: ConnCaptureSummary } {
  const frames: CanFrame[] = [];
  let bannerSeen = false;
  let skippedLines = 0;
  let malformedFrames = 0;
  let restarts = 0;
  let lastRawUs: number | null = null;
  let lastAdjustedUs = 0;
  let firstAdjustedUs = 0;
  let offsetUs = 0;
  let currentBlock: BlockBuilder | null = null;
  let lastCompleteBlock: ConnCaptureSummaryBlock | null = null;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') continue;

    if (line.startsWith('#')) {
      if (line.startsWith(BANNER)) bannerSeen = true;
      continue;
    }

    if (line.startsWith('F,')) {
      const parsed = parseFrame(line);
      if (parsed === null) {
        malformedFrames += 1;
        continue;
      }

      // The node clock starts at 0 after a reset. A backwards jump larger than one second is
      // a restart: offset every later frame so the replay stays monotonic in file order.
      if (lastRawUs !== null && parsed.rawUs < lastRawUs - RESTART_GAP_US) {
        restarts += 1;
        offsetUs = lastAdjustedUs + 1 - parsed.rawUs;
      }
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

      if (parts[1] === 'END') {
        const timeUs = parseUint(parts[2]);
        const end = timeUs === null ? null : parseEndCounters(parts);
        if (timeUs === null || end === null) {
          skippedLines += 1;
          continue;
        }
        const block =
          currentBlock !== null && currentBlock.timeUs === timeUs && currentBlock.final === final
            ? currentBlock
            : { timeUs, final, rows: [] };
        lastCompleteBlock = { timeUs, final, rows: block.rows, end };
        currentBlock = null;
        continue;
      }

      const timeUs = parseUint(parts[1]);
      const row = parseSummaryRow(parts);
      if (timeUs === null || row === null) {
        skippedLines += 1;
        continue;
      }
      if (currentBlock === null || currentBlock.timeUs !== timeUs || currentBlock.final !== final) {
        currentBlock = { timeUs, final, rows: [] };
      }
      currentBlock.rows.push(row);
      continue;
    }

    skippedLines += 1;
  }

  const durationS = frames.length > 0 ? (lastAdjustedUs - firstAdjustedUs) / 1_000_000 : 0;
  return {
    frames,
    summary: { bannerSeen, frames: frames.length, skippedLines, malformedFrames, restarts, durationS, block: lastCompleteBlock },
  };
}
