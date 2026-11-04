import type { ConnCaptureSummary } from './connCaptureParser';

export const CAPTURE_WARNINGS = {
  incomplete: 'the capture is incomplete',
  tester: 'another tester was on the bus during the capture (D-040); this capture is not a clean listen-only baseline',
  short: 'shorter than the 300 s capture window',
  restarted: 'the node restarted during the capture',
} as const;

export function captureWarnings(summary: ConnCaptureSummary): string[] {
  const warnings: string[] = [];
  const end = summary.block?.end;
  if (end && (end.lost > 0 || end.dropped > 0 || end.overflow > 0)) warnings.push(CAPTURE_WARNINGS.incomplete);
  if (summary.block?.rows.some((row) => row.watched && row.count > 0)) warnings.push(CAPTURE_WARNINGS.tester);
  if (!summary.block || !summary.block.final) warnings.push(CAPTURE_WARNINGS.short);
  if (summary.restarts > 0) warnings.push(CAPTURE_WARNINGS.restarted);
  return warnings;
}
