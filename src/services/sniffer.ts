import { ByteActivityStatus, ByteSnifferRecord, CanFrame } from '../types/can';

export const SNIFFER_HISTORY_LENGTH = 16;

/**
 * Folds one frame into the byte-sniffer record of its ID (pure: returns a new record).
 * A byte is 'inc'/'dec' when it moved up/down against the previous frame and
 * 'toggling' when it reversed the direction of its last change (a value bouncing
 * between states, typical for switches and noisy analog bytes).
 */
export function updateSnifferRecord(existing: ByteSnifferRecord | undefined, frame: CanFrame): ByteSnifferRecord {
  const byteStatuses: ByteActivityStatus[] = [];
  const changeCounts = existing ? [...existing.changeCounts] : new Array<number>(8).fill(0);
  const notchedBytes = existing ? [...existing.notchedBytes] : new Array<boolean>(8).fill(false);
  const lastDirections = existing ? [...existing.lastDirections] : new Array<number>(8).fill(0);
  const bitFlips = existing ? [...existing.bitFlips] : new Array<number>(64).fill(0);

  for (let i = 0; i < 8; i++) {
    const cur = frame.data[i] ?? 0;
    const prev = existing ? existing.currentBytes[i] ?? cur : cur;
    if (cur === prev) {
      byteStatuses.push('static');
      continue;
    }
    const dir = cur > prev ? 1 : -1;
    byteStatuses.push(lastDirections[i] !== 0 && lastDirections[i] !== dir ? 'toggling' : dir > 0 ? 'inc' : 'dec');
    lastDirections[i] = dir;
    changeCounts[i] += 1;
  }

  if (existing) {
    for (let b = 0; b < 8; b++) {
      const xor = (frame.data[b] ?? 0) ^ (existing.currentBytes[b] ?? 0);
      if (xor === 0) continue;
      for (let bit = 0; bit < 8; bit++) {
        if (xor & (1 << bit)) bitFlips[b * 8 + (7 - bit)] += 1;
      }
    }
  }

  const frameHistory = existing
    ? [...existing.frameHistory, { timestamp: frame.timestamp, data: frame.data }].slice(-SNIFFER_HISTORY_LENGTH)
    : [{ timestamp: frame.timestamp, data: frame.data }];

  return {
    id: frame.id,
    bus: frame.bus,
    idHex: frame.idHex,
    name: frame.name,
    dlc: frame.dlc,
    currentBytes: frame.data,
    prevBytes: existing ? existing.currentBytes : frame.data,
    byteStatuses,
    changeCounts,
    notchedBytes,
    lastDirections,
    lastUpdated: frame.timestamp,
    frameHistory,
    bitFlips,
    framesCompared: existing ? existing.framesCompared + 1 : 0,
  };
}

export type BitClass = 'STATIC' | 'RARE' | 'ACTIVE' | 'FAST';

/**
 * Classifies a bit by how often it flips per compared frame, so the label does not
 * drift with capture length: never = STATIC, under 5 % = RARE (switch, flag),
 * under 45 % = ACTIVE (counter high bits, slow analog), else FAST (counter LSB, noise).
 */
export function classifyBit(flips: number, framesCompared: number): BitClass {
  if (flips === 0 || framesCompared === 0) return 'STATIC';
  const ratio = flips / framesCompared;
  if (ratio < 0.05) return 'RARE';
  if (ratio < 0.45) return 'ACTIVE';
  return 'FAST';
}
