import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IngestRequest, IngestResponse } from '@/services/ingestProtocol';

describe('ingest.worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadWorker(mockRun?: (req: IngestRequest, emit: (m: IngestResponse) => void) => void) {
    const posted: IngestResponse[] = [];
    const scope: {
      onmessage: ((event: MessageEvent<IngestRequest>) => void) | null;
      postMessage: (message: IngestResponse) => void;
    } = {
      onmessage: null,
      postMessage: (msg) => posted.push(msg),
    };
    vi.stubGlobal('self', scope);
    if (mockRun) {
      vi.doMock('@/services/logIngest', () => ({ runLogIngest: mockRun }));
    } else {
      vi.doUnmock('@/services/logIngest');
    }
    await import('@/services/ingest.worker');
    expect(scope.onmessage).not.toBeNull();
    return { scope, posted };
  }

  it('parses an ASC log and posts batch + done messages', async () => {
    const { scope, posted } = await loadWorker();
    const asc = '0.100000 1 110 Rx d 8 01 02 03 04 05 06 07 08\n';
    scope.onmessage!(
      new MessageEvent<IngestRequest>('message', {
        data: { kind: 'parse-log', id: 7, format: 'asc', text: asc },
      })
    );

    const batches = posted.filter((m) => m.kind === 'batch');
    const done = posted.find((m) => m.kind === 'done');
    expect(batches.length).toBeGreaterThan(0);
    const first = batches[0];
    if (first.kind !== 'batch') throw new Error('expected a batch message');
    expect(first.id).toBe(7);
    expect(first.frames.length).toBe(1);
    expect(first.frames[0].id).toBe(0x110);
    expect(first.frames[0].data).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(done).toMatchObject({ kind: 'done', id: 7, total: 1 });
  });

  it('ignores requests with an unknown kind', async () => {
    const { scope, posted } = await loadWorker();
    scope.onmessage!(
      new MessageEvent('message', {
        data: { kind: 'unknown' },
      }) as unknown as MessageEvent<IngestRequest>
    );
    expect(posted).toEqual([]);
  });

  it('posts an error message when log ingestion throws an Error or non-Error', async () => {
    let call = 0;
    const { scope, posted } = await loadWorker(() => {
      call++;
      if (call === 1) throw new Error('corrupt file');
      throw 'raw string failure';
    });

    scope.onmessage!(
      new MessageEvent<IngestRequest>('message', {
        data: { kind: 'parse-log', id: 11, format: 'asc', text: '' },
      })
    );
    scope.onmessage!(
      new MessageEvent<IngestRequest>('message', {
        data: { kind: 'parse-log', id: 12, format: 'asc', text: '' },
      })
    );

    expect(posted).toEqual([
      { kind: 'error', id: 11, message: 'corrupt file' },
      { kind: 'error', id: 12, message: 'Log import failed.' },
    ]);
  });
});
