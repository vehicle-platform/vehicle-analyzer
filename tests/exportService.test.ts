// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ascChannelToBus,
  busToAscChannel,
  downloadFile,
  exportToCsv,
  exportToJson,
  exportToVectorAsc,
} from '@/services/exportService';
import type { CanFrame } from '@/types/can';

afterEach(() => {
  vi.restoreAllMocks();
});

const sampleFrames: CanFrame[] = [
  {
    id: 0x100,
    idHex: '0x100',
    bus: 'vehicle',
    dlc: 4,
    data: [0x01, 0x0a, 0xff, 0x00],
    timestamp: 1.25,
    deltaMs: 10.5,
    isExtended: false,
    name: 'EngineFrame',
    decodedSignals: { RPM: 3200, TPS: 12.5 },
    periodMs: 10,
    frequencyHz: 100,
    count: 1,
  },
  {
    id: 0x18da10f1,
    idHex: '0x18DA10F1',
    bus: 'platform',
    dlc: 2,
    data: [0x22, 0xf1],
    timestamp: 1.5,
    deltaMs: 250,
    isExtended: true,
    periodMs: 0,
    frequencyHz: 0,
    count: 1,
  },
];

describe('exportService', () => {
  it('maps bus names and ASC channel numbers both ways', () => {
    expect(busToAscChannel('vehicle')).toBe(1);
    expect(busToAscChannel('platform')).toBe(2);
    expect(busToAscChannel('can3')).toBe(4);
    expect(busToAscChannel('unknown')).toBe(1);

    expect(ascChannelToBus(1)).toBe('vehicle');
    expect(ascChannelToBus(2)).toBe('platform');
    expect(ascChannelToBus(4)).toBe('can3');
  });

  it('exports standard and extended frames to Vector ASC', () => {
    const asc = exportToVectorAsc(sampleFrames);
    expect(asc).toContain('base hex  timestamps absolute');
    expect(asc).toContain('// Total Frames: 2');
    expect(asc).toContain('1.250000 1  100             Rx   d 4 01 0A FF 00');
    expect(asc).toContain('1.500000 2  18DA10F1x       Rx   d 2 22 F1');
    expect(asc.trimEnd().endsWith('End TriggerBlock')).toBe(true);
  });

  it('exports frames to CSV with decoded signals and empty fallback', () => {
    const csv = exportToCsv(sampleFrames);
    const lines = csv.split('\n');
    expect(lines[0]).toBe('Timestamp,DeltaMs,Bus,CAN_ID,Name,DLC,DataHex,DecodedSignals');
    expect(lines[1]).toContain('1.250000,10.50,vehicle,0x100,EngineFrame,4,010AFF00,RPM=3200; TPS=12.5');
    expect(lines[2]).toBe('1.500000,250.00,platform,0x18DA10F1,,2,22F1,');
  });

  it('exports frames to structured JSON', () => {
    const parsed = JSON.parse(exportToJson(sampleFrames));
    expect(parsed.platform).toBe('vehicle-platform');
    expect(parsed.frameCount).toBe(2);
    expect(parsed.frames[0]).toMatchObject({
      bus: 'vehicle',
      idHex: '0x100',
      data: '01 0A FF 00',
      signals: { RPM: 3200, TPS: 12.5 },
    });
    expect(parsed.frames[1].signals).toEqual({});
  });

  it('triggers a browser download and revokes the object URL', () => {
    const createUrl = vi.fn().mockReturnValue('blob:test-url');
    const revokeUrl = vi.fn();
    vi.stubGlobal('URL', { ...URL, createObjectURL: createUrl, revokeObjectURL: revokeUrl });
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    downloadFile('hello', 'trace.csv', 'text/csv');

    expect(createUrl).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeUrl).toHaveBeenCalledWith('blob:test-url');
    vi.unstubAllGlobals();
  });
});
