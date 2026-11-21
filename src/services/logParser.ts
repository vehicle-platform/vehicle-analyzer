import { CanFrame } from '../types/can';
import { splitCsvLine } from './csv';
import { ascChannelToBus } from './exportService';

/** Largest DLC accepted from an imported log (CAN FD maximum). */
const MAX_DLC = 64;

/**
 * Parses Vector ASCII (.asc) file format into CanFrame array
 * Standard Vector format:
 *   0.000000 1  0x020           Rx   d 8 10 20 30 40 50 60 70 80
 */
export function parseVectorAsc(ascText: string): CanFrame[] {
  const lines = ascText.split('\n');
  const frames: CanFrame[] = [];

  // timestamp channel id Rx/Tx d dlc data...  (data optional for DLC 0)
  const ascRegex = /^\s*([0-9.]+)\s+(\d+)\s+((?:0x)?[0-9a-fA-F]+x?)\s+(Rx|Tx)\s+d\s+(\d+)((?:\s+[0-9a-fA-F]{2})*)/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line || line.startsWith('//') || line.startsWith('date') || line.startsWith('base')) {
      continue;
    }

    const match = line.match(ascRegex);
    if (match) {
      const timestamp = parseFloat(match[1]);
      const rawId = match[3].toLowerCase();
      const isExtended = rawId.endsWith('x');
      const cleanIdStr = (isExtended ? rawId.slice(0, -1) : rawId).replace(/^0x/, '');
      const id = parseInt(cleanIdStr, 16);
      const dlc = parseInt(match[5], 10);
      // Reject NaN/oversized fields instead of letting junk keys reach the capture maps.
      if (!Number.isFinite(timestamp) || !Number.isFinite(id) || !Number.isFinite(dlc) || dlc > MAX_DLC) continue;
      const dataBytes = match[6]
        .trim()
        .split(/\s+/)
        .filter((hex) => hex.length > 0)
        .map((hex) => parseInt(hex, 16))
        .filter((byte) => Number.isFinite(byte))
        .slice(0, dlc);
      const bus = ascChannelToBus(parseInt(match[2], 10));

      frames.push({
        id,
        idHex: `0x${id.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0')}`,
        bus,
        dlc,
        data: dataBytes,
        timestamp,
        deltaMs: 0,
        isExtended,
        periodMs: 0,
        frequencyHz: 0,
        count: 1,
      });
    }
  }

  return frames;
}

/**
 * Parses CSV log format into CanFrame array
 * Header: Timestamp,DeltaMs,Bus,CAN_ID,Name,DLC,DataHex,DecodedSignals
 */
export function parseCanCsv(csvText: string): CanFrame[] {
  const lines = csvText.split('\n');
  const frames: CanFrame[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts = splitCsvLine(line);
    if (parts.length >= 7) {
      const timestamp = parseFloat(parts[0]);
      const bus = parts[2] || 'can0';
      const idHex = parts[3].trim();
      const id = parseInt(idHex.replace('0x', ''), 16);
      const dataHex = parts[6].replace(/[^0-9a-fA-F]/g, '');
      const dlcParsed = parseInt(parts[5], 10);
      const dlc = Number.isFinite(dlcParsed) ? dlcParsed : dataHex.length / 2;

      const dataBytes: number[] = [];
      for (let b = 0; b < dataHex.length; b += 2) {
        dataBytes.push(parseInt(dataHex.substr(b, 2), 16));
      }

      if (!Number.isFinite(timestamp) || !Number.isFinite(id) || dlc > MAX_DLC) continue;
      // An extended identifier below 0x800 is exported with eight hex digits: keep the flag.
      const isExtended = id > 0x7ff || /^(0x)?[0-9a-f]{8}$/i.test(idHex);

      frames.push({
        id,
        idHex: `0x${id.toString(16).toUpperCase().padStart(isExtended ? 8 : 3, '0')}`,
        bus,
        dlc,
        data: dataBytes,
        timestamp,
        deltaMs: 0,
        isExtended,
        periodMs: 0,
        frequencyHz: 0,
        count: 1,
      });
    }
  }

  return frames;
}
