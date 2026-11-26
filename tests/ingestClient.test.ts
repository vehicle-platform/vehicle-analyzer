// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLogIngest } from '@/services/ingestClient';
import type { IngestResponse, ParseLogRequest } from '@/services/ingestProtocol';

function makeRequest(id: number, text: string): ParseLogRequest {
  return {
    kind: 'parse-log',
    id,
    format: 'asc',
    text,
  };
}

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<IngestResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  posted: unknown[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(msg: unknown) {
    this.posted.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
}

afterEach(() => {
  FakeWorker.instances = [];
  vi.unstubAllGlobals();
});

describe('startLogIngest', () => {
  it('falls back to synchronous ingest when Worker is undefined', () => {
    vi.stubGlobal('Worker', undefined);
    const onProgress = vi.fn();
    const onBatch = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    const asc = '0.010000 1  100  Rx   d 2 01 02\n';
    const job = startLogIngest(makeRequest(1, asc), { onProgress, onBatch, onDone, onError });
    job.cancel();

    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onDone.mock.calls[0][0]).toBeGreaterThanOrEqual(1);
  });

  it('falls back synchronously when Worker constructor throws', () => {
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new Error('CSP blocked worker');
        }
      }
    );
    const onDone = vi.fn();
    const onError = vi.fn();
    startLogIngest(makeRequest(2, '0.010000 1  100  Rx   d 1 AA\n'), {
      onProgress: vi.fn(),
      onBatch: vi.fn(),
      onDone,
      onError,
    });
    expect(onError).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('dispatches worker progress, batch, done and ignores mismatched request IDs', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const onProgress = vi.fn();
    const onBatch = vi.fn();
    const onDone = vi.fn();
    const onError = vi.fn();

    startLogIngest(makeRequest(7, ''), { onProgress, onBatch, onDone, onError });
    const w = FakeWorker.instances[0];
    expect(w.posted).toHaveLength(1);

    // Mismatched id ignored
    w.onmessage?.({ data: { kind: 'progress', id: 99, parsed: 1, total: 2 } } as MessageEvent<IngestResponse>);
    expect(onProgress).not.toHaveBeenCalled();

    w.onmessage?.({ data: { kind: 'progress', id: 7, parsed: 1, total: 2 } } as MessageEvent<IngestResponse>);
    w.onmessage?.({ data: { kind: 'batch', id: 7, frames: [], parsed: 1, total: 2 } } as MessageEvent<IngestResponse>);
    w.onmessage?.({ data: { kind: 'done', id: 7, total: 2 } } as MessageEvent<IngestResponse>);

    expect(onProgress).toHaveBeenCalledWith(1, 2);
    expect(onBatch).toHaveBeenCalledWith([]);
    expect(onDone).toHaveBeenCalledWith(2, undefined);
    expect(w.terminated).toBe(true);
  });

  it('handles worker error, messageerror, error response, and explicit cancel', () => {
    vi.stubGlobal('Worker', FakeWorker);
    const onError = vi.fn();
    startLogIngest(makeRequest(8, ''), {
      onProgress: vi.fn(),
      onBatch: vi.fn(),
      onDone: vi.fn(),
      onError,
    });
    const w1 = FakeWorker.instances[0];
    w1.onerror?.({ message: 'boom' } as ErrorEvent);
    expect(onError).toHaveBeenCalledWith('boom');
    expect(w1.terminated).toBe(true);

    const onError2 = vi.fn();
    startLogIngest(makeRequest(9, ''), {
      onProgress: vi.fn(),
      onBatch: vi.fn(),
      onDone: vi.fn(),
      onError: onError2,
    });
    const w2 = FakeWorker.instances[1];
    w2.onmessageerror?.({} as MessageEvent);
    expect(onError2).toHaveBeenCalledWith('Log import worker returned an unreadable message.');
    expect(w2.terminated).toBe(true);

    const onError3 = vi.fn();
    startLogIngest(makeRequest(11, ''), {
      onProgress: vi.fn(),
      onBatch: vi.fn(),
      onDone: vi.fn(),
      onError: onError3,
    });
    const w3 = FakeWorker.instances[2];
    w3.onmessage?.({ data: { kind: 'error', id: 11, message: 'bad log' } } as MessageEvent<IngestResponse>);
    expect(onError3).toHaveBeenCalledWith('bad log');
    expect(w3.terminated).toBe(true);

    const onDone4 = vi.fn();
    const job4 = startLogIngest(makeRequest(10, ''), {
      onProgress: vi.fn(),
      onBatch: vi.fn(),
      onDone: onDone4,
      onError: vi.fn(),
    });
    const w4 = FakeWorker.instances[3];
    job4.cancel();
    expect(w4.terminated).toBe(true);
    w4.onmessage?.({ data: { kind: 'done', id: 10, total: 1 } } as MessageEvent<IngestResponse>);
    expect(onDone4).not.toHaveBeenCalled();
  });
});
