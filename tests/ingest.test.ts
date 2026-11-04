import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFS } from '../src/defs';
import { VirtualCanBus } from '../src/services/virtualBus';
import { detectLogFormat, parseLogFrames } from '../src/services/logIngest';
import { startLogIngest } from '../src/services/ingestClient';
import { INGEST_BATCH_SIZE } from '../src/services/ingestProtocol';
import { exportToCsv, exportToVectorAsc } from '../src/services/exportService';
import type { ConnCaptureSummary } from '../src/services/connCaptureParser';
import type { IngestFormat } from '../src/services/ingestProtocol';
import type { CanFrame } from '../src/types/can';

const CONN_TEXT = [
  '# vehicle-connectivity-node CAN capture: TWAI listen-only, 500 kbps, accept-all.',
  'F,1000000,100,S,2,AABB',
  'F,2000000,200,S,1,01',
  'S,10000000,100,S,2,1.000,1.000,-',
  'S,10000000,200,S,1,-,-,-',
  'S,END,10000000,frames=2,ids=2,overflow=0,lost=0,dropped=0',
].join('\n');

function capture(seconds: number): CanFrame[] {
  const bus = new VirtualCanBus(DEFS);
  const frames: CanFrame[] = [];
  (bus as any).onFrame = (frame: CanFrame) => frames.push(frame);
  for (let i = 0; i < seconds * 100; i++) bus.tick();
  return frames;
}

afterEach(() => vi.unstubAllGlobals());

describe('parseLogFrames', () => {
  it('returns frames in capture order', () => {
    const raw = capture(2);
    const shuffled = [...raw.slice(raw.length / 2), ...raw.slice(0, raw.length / 2)];
    const frames = parseLogFrames(exportToVectorAsc(shuffled), 'asc');
    expect(frames).toHaveLength(raw.length);
    for (let i = 1; i < frames.length; i++) expect(frames[i].timestamp).toBeGreaterThanOrEqual(frames[i - 1].timestamp);
  });
});

describe('log format detection', () => {
  it('picks conn from the banner or a bare frame line', () => {
    expect(detectLogFormat(CONN_TEXT)).toBe('conn');
    expect(detectLogFormat('ets Jul 29 2019 12:21:46\nF,1000000,100,S,1,00')).toBe('conn');
  });

  it('does not pick conn for ASC or CSV', () => {
    const raw = capture(1);
    expect(detectLogFormat(exportToVectorAsc(raw))).toBeNull();
    expect(detectLogFormat(exportToCsv(raw))).toBeNull();
  });
});

describe('log ingest fallback', () => {
  it.each<IngestFormat>(['asc', 'csv'])('parses %s in batches without a Worker', (format) => {
    vi.stubGlobal('Worker', undefined);
    const raw = capture(10);
    const text = format === 'asc' ? exportToVectorAsc(raw) : exportToCsv(raw);
    const expected = parseLogFrames(text, format);
    const frames: CanFrame[] = [];
    const progress: number[] = [];
    let batches = 0;
    let done = -1;
    let error = '';

    startLogIngest(
      { kind: 'parse-log', id: 1, format, text },
      {
        onProgress: (parsed) => progress.push(parsed),
        onBatch: (batch) => {
          batches += 1;
          frames.push(...batch);
        },
        onDone: (total) => {
          done = total;
        },
        onError: (message) => {
          error = message;
        },
      }
    );

    expect(error).toBe('');
    expect(done).toBe(expected.length);
    expect(frames).toEqual(expected);
    expect(progress[0]).toBe(0);
    expect(progress[progress.length - 1]).toBe(expected.length);
    expect(batches).toBe(Math.ceil(expected.length / INGEST_BATCH_SIZE));
  });

  it('parses a conn capture in batches without a Worker and returns its summary', () => {
    vi.stubGlobal('Worker', undefined);
    const expected = parseLogFrames(CONN_TEXT, 'conn');
    const frames: CanFrame[] = [];
    let done = -1;
    let summary: ConnCaptureSummary | undefined;
    let error = '';

    startLogIngest(
      { kind: 'parse-log', id: 2, format: 'conn', text: CONN_TEXT },
      {
        onProgress: () => undefined,
        onBatch: (batch) => frames.push(...batch),
        onDone: (total, parsedSummary) => {
          done = total;
          summary = parsedSummary;
        },
        onError: (message) => {
          error = message;
        },
      }
    );

    expect(error).toBe('');
    expect(done).toBe(2);
    expect(frames).toEqual(expected);
    expect(frames.map((f) => f.bus)).toEqual(['vehicle', 'vehicle']);
    expect(summary?.bannerSeen).toBe(true);
    expect(summary?.block?.end).toEqual({ frames: 2, ids: 2, overflow: 0, lost: 0, dropped: 0 });
  });
});
