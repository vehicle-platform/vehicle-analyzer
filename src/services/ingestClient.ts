import type { CanFrame } from '../types/can';
import type { IngestResponse, ParseLogRequest } from './ingestProtocol';
import type { ConnCaptureSummary } from './connCaptureParser';
import { runLogIngest } from './logIngest';

export interface LogIngestHandlers {
  onProgress: (parsed: number, total: number) => void;
  onBatch: (frames: CanFrame[]) => void;
  onDone: (total: number, summary?: ConnCaptureSummary) => void;
  onError: (message: string) => void;
}

export interface LogIngestJob {
  cancel: () => void;
}

/**
 * Starts a log import in a module worker. When Worker is unavailable (Vitest/jsdom, old
 * browsers) or cannot start, the identical parser/decoder runs synchronously.
 */
export function startLogIngest(request: ParseLogRequest, handlers: LogIngestHandlers): LogIngestJob {
  let cancelled = false;

  const handle = (message: IngestResponse) => {
    if (cancelled || message.id !== request.id) return;
    if (message.kind === 'progress') handlers.onProgress(message.parsed, message.total);
    else if (message.kind === 'batch') handlers.onBatch(message.frames);
    else if (message.kind === 'done') handlers.onDone(message.total, message.summary);
    else handlers.onError(message.message);
  };

  const fallback = (): LogIngestJob => {
    try {
      runLogIngest(request, handle);
    } catch (error) {
      handle({
        kind: 'error',
        id: request.id,
        message: error instanceof Error ? error.message : 'Log import failed.',
      });
    }
    return { cancel: () => { cancelled = true; } };
  };

  if (typeof Worker === 'undefined') return fallback();

  let worker: Worker;
  try {
    worker = new Worker(new URL('./ingest.worker.ts', import.meta.url), { type: 'module' });
  } catch {
    return fallback();
  }

  const stop = () => {
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };

  worker.onmessage = (event: MessageEvent<IngestResponse>) => {
    handle(event.data);
    if (event.data.kind === 'done' || event.data.kind === 'error') stop();
  };
  worker.onerror = (event) => {
    if (!cancelled) {
      cancelled = true;
      handlers.onError(event.message || 'Log import worker failed.');
    }
    stop();
  };
  worker.onmessageerror = () => {
    if (!cancelled) {
      cancelled = true;
      handlers.onError('Log import worker returned an unreadable message.');
    }
    stop();
  };
  worker.postMessage(request);

  return {
    cancel: () => {
      cancelled = true;
      stop();
    },
  };
}
