import { describe, expect, it } from 'vitest';
import type { ConnCaptureSummary } from '../src/services/connCaptureParser';
import { CAPTURE_WARNINGS, captureWarnings } from '../src/services/captureQuality';

function summary(over: Partial<ConnCaptureSummary> = {}, endOver: Partial<NonNullable<ConnCaptureSummary['block']>['end']> = {}): ConnCaptureSummary {
  return {
    bannerSeen: true,
    frames: 10,
    skippedLines: 0,
    malformedFrames: 0,
    restarts: 0,
    durationS: 10,
    ...over,
    block:
      over.block === null
        ? null
        : {
            timeUs: 300_000_000,
            final: true,
            rows: [],
            end: { frames: 10, ids: 1, overflow: 0, lost: 0, dropped: 0, ...endOver },
            ...over.block,
          },
  };
}

describe('captureWarnings', () => {
  it('returns no warning for a clean FINAL capture', () => {
    expect(captureWarnings(summary())).toEqual([]);
  });

  it('does not compare the parsed frame count with the END counter', () => {
    expect(captureWarnings(summary({ frames: 99 }))).toEqual([]);
  });

  it.each([
    ['lost frames', { lost: 1 }],
    ['dropped serial lines', { dropped: 1 }],
    ['ID-table overflow', { overflow: 1 }],
  ])('warns about incomplete data for %s', (_name, endOver) => {
    expect(captureWarnings(summary({}, endOver))).toEqual([CAPTURE_WARNINGS.incomplete]);
  });

  it('warns about another tester from a watched ID with frames', () => {
    const watched = summary({ block: { timeUs: 1, final: true, rows: [{ id: 0x7df, extended: false, count: 3, minGapMs: null, maxGapMs: null, watched: true }], end: { frames: 3, ids: 1, overflow: 0, lost: 0, dropped: 0 } } });
    expect(captureWarnings(watched)).toEqual([CAPTURE_WARNINGS.tester]);
  });

  it('does not warn about a watched ID with zero frames', () => {
    const watched = summary({ block: { timeUs: 1, final: true, rows: [{ id: 0x7df, extended: false, count: 0, minGapMs: null, maxGapMs: null, watched: true }], end: { frames: 0, ids: 1, overflow: 0, lost: 0, dropped: 0 } } });
    expect(captureWarnings(watched)).toEqual([]);
  });

  it('warns when there is no summary block or no FINAL block', () => {
    expect(captureWarnings(summary({ block: null }))).toEqual([CAPTURE_WARNINGS.short]);
    expect(captureWarnings(summary({ block: { timeUs: 1, final: false, rows: [], end: { frames: 1, ids: 0, overflow: 0, lost: 0, dropped: 0 } } }))).toEqual([
      CAPTURE_WARNINGS.short,
    ]);
  });

  it('warns when the node restarted', () => {
    expect(captureWarnings(summary({ restarts: 1 }))).toEqual([CAPTURE_WARNINGS.restarted]);
  });
});
