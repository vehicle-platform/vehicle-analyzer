import { DbcCatalog, DbcMessageDef, DbcSignalDef } from '../types/can';

/**
 * In-browser DBC parser: VERSION, BU_, BO_, SG_, CM_ (BU_/BO_/SG_), BA_DEF_DEF_ / BA_
 * (GenMsgCycleTime, E2E_Protected, E2E_DataID, NodeId) and VAL_.
 * The analyzer has no built-in catalog: signals come only from a DBC (Invariant 2),
 * normally the pinned vehicle-defs copy (src/defs).
 */
export function parseDbc(dbcText: string): DbcCatalog {
  const text = dbcText.replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const messages: DbcMessageDef[] = [];
  const nodes: DbcCatalog['nodes'] = [];
  let version = '';
  let currentMsg: DbcMessageDef | null = null;

  // BO_ 32 EkfLean: 8 RT_CORE
  const boRegex = /^BO_\s+(\d+)\s+([A-Za-z0-9_]+)\s*:\s*(\d+)\s+([A-Za-z0-9_]+)/;
  // SG_ NAME [M|m0] : start|len@order sign (factor,offset) [min|max] "unit" receivers
  const sgRegex =
    /^SG_\s+([A-Za-z0-9_]+)\s*(?:M|m\d+M?)?\s*:\s*(\d+)\|(\d+)@([01])([+-])\s*\(([^,]+),([^)]+)\)\s*\[([^|]+)\|([^\]]+)\]\s*"([^"]*)"\s*(.*)$/;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === '') {
      currentMsg = null;
      continue;
    }

    const ver = /^VERSION\s+"([^"]*)"/.exec(line);
    if (ver) {
      version = ver[1];
      continue;
    }

    const bu = /^BU_\s*:\s*(.*)$/.exec(line);
    if (bu) {
      bu[1].split(/\s+/).filter(Boolean).forEach((name) => nodes.push({ name }));
      continue;
    }

    const boMatch = boRegex.exec(line);
    if (boMatch) {
      const rawId = Number(boMatch[1]);
      // DBC marks a 29-bit identifier with bit 31 set.
      const isExtended = rawId >= 0x80000000;
      currentMsg = {
        id: isExtended ? rawId - 0x80000000 : rawId,
        name: boMatch[2],
        dlc: parseInt(boMatch[3], 10),
        sender: boMatch[4],
        signals: [],
        isExtended,
      };
      messages.push(currentMsg);
      continue;
    }

    if (currentMsg) {
      const sg = sgRegex.exec(line);
      if (sg) {
        currentMsg.signals.push({
          name: sg[1],
          startBit: parseInt(sg[2], 10),
          bitLength: parseInt(sg[3], 10),
          isLittleEndian: sg[4] === '1',
          isSigned: sg[5] === '-',
          factor: parseFloat(sg[6]),
          offset: parseFloat(sg[7]),
          min: parseFloat(sg[8]),
          max: parseFloat(sg[9]),
          unit: sg[10],
          receivers: sg[11].split(',').map((r) => r.trim()).filter((r) => r && r !== 'Vector__XXX'),
        });
      }
    }
  }

  const byRawId = new Map<number, DbcMessageDef>();
  messages.forEach((m) => byRawId.set(m.isExtended ? m.id + 0x80000000 : m.id, m));

  // Comments (may span lines; DBC strings escape quotes as \").
  const str = '"((?:[^"\\\\]|\\\\.)*)"';
  for (const m of text.matchAll(new RegExp(`CM_\\s+BO_\\s+(\\d+)\\s+${str}\\s*;`, 'g'))) {
    const msg = byRawId.get(Number(m[1]));
    if (msg) msg.comment = m[2];
  }
  for (const m of text.matchAll(new RegExp(`CM_\\s+SG_\\s+(\\d+)\\s+([A-Za-z0-9_]+)\\s+${str}\\s*;`, 'g'))) {
    const sig = byRawId.get(Number(m[1]))?.signals.find((s) => s.name === m[2]);
    if (sig) sig.comment = m[3];
  }
  for (const m of text.matchAll(new RegExp(`CM_\\s+BU_\\s+([A-Za-z0-9_]+)\\s+${str}\\s*;`, 'g'))) {
    const node = nodes.find((n) => n.name === m[1]);
    if (node) node.comment = m[2];
  }

  // Attributes: enum definitions, defaults, then explicit values.
  const enumDefs = new Map<string, string[]>();
  for (const m of text.matchAll(/BA_DEF_\s+(?:BO_|BU_|SG_)?\s*"([^"]+)"\s+ENUM\s+([^;]+);/g)) {
    enumDefs.set(m[1], [...m[2].matchAll(/"([^"]*)"/g)].map((x) => x[1]));
  }
  const defaults = new Map<string, string>();
  for (const m of text.matchAll(/BA_DEF_DEF_\s+"([^"]+)"\s+("?)([^";]*)\2\s*;/g)) defaults.set(m[1], m[3]);

  const msgAttr = new Map<DbcMessageDef, Map<string, string>>();
  for (const m of text.matchAll(/BA_\s+"([^"]+)"\s+BO_\s+(\d+)\s+("?)([^";]*)\3\s*;/g)) {
    const msg = byRawId.get(Number(m[2]));
    if (!msg) continue;
    if (!msgAttr.has(msg)) msgAttr.set(msg, new Map());
    msgAttr.get(msg)!.set(m[1], m[4].trim());
  }
  for (const m of text.matchAll(/BA_\s+"NodeId"\s+BU_\s+([A-Za-z0-9_]+)\s+(\d+)\s*;/g)) {
    const node = nodes.find((n) => n.name === m[1]);
    if (node) node.nodeId = Number(m[2]);
  }

  const attr = (msg: DbcMessageDef, name: string): string | undefined => msgAttr.get(msg)?.get(name) ?? defaults.get(name);
  const enumValue = (name: string, v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    const labels = enumDefs.get(name);
    if (labels && /^\d+$/.test(v)) return labels[Number(v)];
    return v;
  };

  for (const msg of messages) {
    const cycle = Number(attr(msg, 'GenMsgCycleTime'));
    if (Number.isFinite(cycle) && cycle > 0) msg.cycleTimeMs = cycle;
    if (enumValue('E2E_Protected', attr(msg, 'E2E_Protected')) === 'Yes') {
      const dataId = Number(attr(msg, 'E2E_DataID'));
      if (Number.isFinite(dataId)) msg.e2e = { dataId };
    }
  }

  // Value tables.
  for (const m of text.matchAll(/VAL_\s+(\d+)\s+([A-Za-z0-9_]+)\s+((?:-?\d+\s+"[^"]*"\s*)+);/g)) {
    const sig = byRawId.get(Number(m[1]))?.signals.find((s) => s.name === m[2]);
    if (!sig) continue;
    const values: Record<number, string> = {};
    for (const v of m[3].matchAll(/(-?\d+)\s+"([^"]*)"/g)) values[Number(v[1])] = v[2];
    sig.values = values;
  }

  return { version, nodes, messages };
}

/** Messages only (convenience for callers that need no attributes). */
export function parseDbcText(dbcText: string): DbcMessageDef[] {
  return parseDbc(dbcText).messages;
}

/**
 * Extracts the raw (unscaled) value of a signal. Works for any length up to 52 bits
 * without 32-bit overflow (no bitwise operators on the accumulated value).
 * Returns null when the signal does not fit in the payload.
 */
export function extractRawValue(data: number[], sig: DbcSignalDef): number | null {
  const len = sig.bitLength;
  if (len <= 0 || len > 52) return null;

  let raw = 0;
  for (const bitPos of signalBitPositions(sig)) {
    const byteIdx = bitPos >> 3;
    if (byteIdx >= data.length) return null;
    raw = raw * 2 + ((data[byteIdx] >> (bitPos & 7)) & 1);
  }

  if (sig.isSigned && raw >= 2 ** (len - 1)) raw -= 2 ** len;
  return raw;
}

/**
 * Absolute bit positions (byte * 8 + bit) of a signal, most significant first.
 * Intel: the start bit is the LSB and bits go up. Motorola: the start bit is the MSB in
 * DBC sawtooth numbering; bits go down a byte, then on at bit 7 of the next byte.
 */
export function signalBitPositions(sig: DbcSignalDef): number[] {
  const out: number[] = [];
  if (sig.isLittleEndian) {
    for (let i = sig.bitLength - 1; i >= 0; i--) out.push(sig.startBit + i);
  } else {
    let bitPos = sig.startBit;
    for (let i = 0; i < sig.bitLength; i++) {
      out.push(bitPos);
      bitPos = bitPos % 8 === 0 ? bitPos + 15 : bitPos - 1;
    }
  }
  return out;
}

/**
 * Decodes raw CAN payload bytes using a message definition. Values are full precision;
 * formatting belongs to the UI.
 */
export function decodeFrameSignals(data: number[], messageDef?: DbcMessageDef): Record<string, number | string> {
  if (!messageDef || messageDef.signals.length === 0) return {};
  const result: Record<string, number | string> = {};
  for (const sig of messageDef.signals) {
    const raw = extractRawValue(data, sig);
    if (raw === null) continue;
    result[sig.name] = raw * sig.factor + sig.offset;
  }
  return result;
}

/** Physical value -> raw integer of a signal, rounded and saturated to its bit field. */
export function physicalToRaw(sig: DbcSignalDef, physical: number): number {
  let raw = Math.round((physical - sig.offset) / sig.factor);
  const lo = sig.isSigned ? -(2 ** (sig.bitLength - 1)) : 0;
  const hi = sig.isSigned ? 2 ** (sig.bitLength - 1) - 1 : 2 ** sig.bitLength - 1;
  if (!Number.isFinite(raw)) raw = 0;
  return Math.max(lo, Math.min(hi, raw));
}

/**
 * Packs signal values into a payload of the message's DLC (used by the simulator and
 * tests; the analyzer never transmits on a vehicle bus). Values are physical unless
 * `raw` is set; unknown names are ignored, missing signals stay raw 0.
 */
export function encodeFrameSignals(
  messageDef: DbcMessageDef,
  values: Record<string, number>,
  opts: { raw?: boolean } = {}
): number[] {
  const data = new Array<number>(messageDef.dlc).fill(0);
  for (const sig of messageDef.signals) {
    const v = values[sig.name];
    if (v === undefined) continue;
    let raw = opts.raw ? Math.round(v) : physicalToRaw(sig, v);
    if (raw < 0) raw += 2 ** sig.bitLength; // two's complement
    const positions = signalBitPositions(sig);
    for (let i = positions.length - 1; i >= 0; i--) {
      const bitPos = positions[i];
      const byteIdx = bitPos >> 3;
      if (byteIdx >= data.length) continue;
      const bit = raw % 2;
      raw = Math.floor(raw / 2);
      if (bit) data[byteIdx] |= 1 << (bitPos & 7);
      else data[byteIdx] &= ~(1 << (bitPos & 7));
    }
  }
  return data;
}
