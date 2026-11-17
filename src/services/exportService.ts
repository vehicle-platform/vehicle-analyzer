import { CanFrame } from '../types/can';
import { csvCell } from './csv';

/** ASC channel numbers follow the vehicle-server convention: 1 = vehicle bus, 2 = platform bus. */
export function busToAscChannel(bus: string): number {
  if (bus === 'vehicle') return 1;
  if (bus === 'platform') return 2;
  const m = /(\d+)$/.exec(bus);
  return m ? Number(m[1]) + 1 : 1;
}

export function ascChannelToBus(channel: number): string {
  if (channel === 1) return 'vehicle';
  if (channel === 2) return 'platform';
  return `can${channel - 1}`;
}

/**
 * Exports captured CAN frames to Vector ASCII (.asc) format
 * Compatible with Vector CANoe, CANalyzer, SavvyCAN, and asammdf
 */
export function exportToVectorAsc(frames: CanFrame[]): string {
  const dateStr = new Date().toUTCString();
  const lines: string[] = [
    `date ${dateStr}`,
    `base hex  timestamps absolute`,
    `internal events logged`,
    `Begin TriggerBlock ${dateStr}`,
    `// VEHICLE ANALYZER - Vector ASC Export`,
    `// Total Frames: ${frames.length}`,
    `------------------------------------------------------------------`,
  ];

  frames.forEach((f) => {
    const timeFormatted = f.timestamp.toFixed(6).padStart(11, ' ');
    const channel = String(busToAscChannel(f.bus));
    // Vector ASC writes the identifier in hex without a prefix; 29-bit IDs end in 'x'.
    const idHex = f.id.toString(16).toUpperCase();
    const idFormatted = f.isExtended ? `${idHex}x` : idHex;
    const dataFormatted = f.data
      .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
      .join(' ');

    lines.push(`${timeFormatted} ${channel}  ${idFormatted.padEnd(15, ' ')} Rx   d ${f.dlc} ${dataFormatted}`);
  });

  lines.push('End TriggerBlock');
  return lines.join('\n');
}

/**
 * Exports captured CAN frames to standard CSV format
 */
export function exportToCsv(frames: CanFrame[]): string {
  const headers = ['Timestamp', 'DeltaMs', 'Bus', 'CAN_ID', 'Name', 'DLC', 'DataHex', 'DecodedSignals'];
  const rows: string[] = [headers.join(',')];

  frames.forEach((f) => {
    const dataHex = f.data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    const decodedStr = f.decodedSignals
      ? csvCell(Object.entries(f.decodedSignals).map(([k, v]) => `${k}=${v}`).join('; '))
      : '';

    const row = [
      f.timestamp.toFixed(6),
      f.deltaMs.toFixed(2),
      csvCell(f.bus),
      f.idHex,
      csvCell(f.name || ''),
      f.dlc,
      dataHex,
      decodedStr,
    ];
    rows.push(row.join(','));
  });

  return rows.join('\n');
}

/**
 * Exports captured CAN frames to JSON format
 */
export function exportToJson(frames: CanFrame[]): string {
  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      platform: 'vehicle-platform',
      frameCount: frames.length,
      frames: frames.map((f) => ({
        timestamp: f.timestamp,
        deltaMs: f.deltaMs,
        bus: f.bus,
        idHex: f.idHex,
        name: f.name,
        dlc: f.dlc,
        data: f.data.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '),
        signals: f.decodedSignals || {},
      })),
    },
    null,
    2
  );
}

/**
 * Triggers a browser download of the generated file
 */
export function downloadFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
