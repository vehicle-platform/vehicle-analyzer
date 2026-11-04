import type { CanFrame } from '../types/can';
import type { ConnCaptureSummary } from './connCaptureParser';

/** Frames per worker message; large enough to keep postMessage overhead low. */
export const INGEST_BATCH_SIZE = 2_000;

export type IngestFormat = 'asc' | 'csv' | 'conn';

/** A whole log file handed to the worker (or to the synchronous fallback). */
export interface ParseLogRequest {
  kind: 'parse-log';
  id: number;
  format: IngestFormat;
  text: string;
}

export type IngestRequest = ParseLogRequest;

export type IngestResponse =
  | { kind: 'progress'; id: number; parsed: number; total: number }
  | { kind: 'batch'; id: number; frames: CanFrame[]; parsed: number; total: number }
  | { kind: 'done'; id: number; total: number; summary?: ConnCaptureSummary }
  | { kind: 'error'; id: number; message: string };
