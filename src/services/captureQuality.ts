import type { ConnCaptureSummary } from './connCaptureParser';

export const CAPTURE_WARNINGS = {
  incomplete: 'the capture is incomplete',
  tester: 'another tester was on the bus during the capture (D-040); this capture is not a clean listen-only baseline',
  short: 'shorter than the 300 s capture window',
  restarted: 'the node restarted during the capture',
} as const;

/**
 * Warnings over every node run of the capture: the node's counters start again after a
 * restart, so a lost frame or a foreign tester before a reset is only in that run's block.
 */
export function captureWarnings(summary: ConnCaptureSummary): string[] {
  const warnings: string[] = [];
  const blocks = summary.runBlocks;
  if (blocks.some(({ end }) => end.lost > 0 || end.dropped > 0 || end.overflow > 0)) warnings.push(CAPTURE_WARNINGS.incomplete);
  if (blocks.some(({ rows }) => rows.some((row) => row.watched && row.count > 0))) warnings.push(CAPTURE_WARNINGS.tester);
  // The node keeps printing S blocks after FINAL, so the last block is usually not the FINAL one.
  if (!summary.finalSeen) warnings.push(CAPTURE_WARNINGS.short);
  if (summary.restarts > 0) warnings.push(CAPTURE_WARNINGS.restarted);
  return warnings;
}
