import type { CanFrame } from '../types/can';
import { parseConnCapture, type ConnCaptureSummary } from './connCaptureParser';
import { parseCanCsv, parseVectorAsc } from './logParser';
import { INGEST_BATCH_SIZE, type IngestResponse, type ParseLogRequest } from './ingestProtocol';

interface ParsedLog {
  frames: CanFrame[];
  summary?: ConnCaptureSummary;
}

/** Picks the conn capture from its banner or a bare frame line; other formats keep their extension. */
export function detectLogFormat(text: string): ParseLogRequest['format'] | null {
  const lines = text
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
    .filter((line) => line !== '')
    .slice(0, 20);
  if (lines.some((line) => line.startsWith('# vehicle-connectivity-node CAN capture'))) return 'conn';
  return lines.some((line) => line.startsWith('F,')) ? 'conn' : null;
}

export function parseLog(text: string, format: ParseLogRequest['format']): ParsedLog {
  const parsed =
    format === 'asc' ? { frames: parseVectorAsc(text) } : format === 'csv' ? { frames: parseCanCsv(text) } : parseConnCapture(text);
  return { ...parsed, frames: parsed.frames.sort((a, b) => a.timestamp - b.timestamp) };
}

/** Parses a log and returns its frames in capture order. */
export function parseLogFrames(text: string, format: ParseLogRequest['format']): CanFrame[] {
  return parseLog(text, format).frames;
}

/**
 * Parses one log, emitting progress and frame batches. The same function runs in the worker
 * and in the main-thread fallback, so both paths produce identical frames. Decoding, timing
 * and E2E stay in CaptureStore, which sees the frames through the replay transport.
 */
export function runLogIngest(request: ParseLogRequest, emit: (message: IngestResponse) => void): void {
  const { frames, summary } = parseLog(request.text, request.format);
  const total = frames.length;
  emit({ kind: 'progress', id: request.id, parsed: 0, total });

  for (let start = 0; start < total; start += INGEST_BATCH_SIZE) {
    const batch = frames.slice(start, start + INGEST_BATCH_SIZE);
    const parsed = start + batch.length;
    emit({ kind: 'batch', id: request.id, frames: batch, parsed, total });
    emit({ kind: 'progress', id: request.id, parsed, total });
  }
  emit({ kind: 'done', id: request.id, total, summary });
}
