import { describe, expect, it } from 'vitest';
import type { ConnCaptureSummary } from '../src/services/connCaptureParser';
import { CAPTURE_WARNINGS, captureWarnings } from '../src/services/captureQuality';

type Block = NonNullable<ConnCaptureSummary['block']>;

function block(over: Partial<Block> = {}, endOver: Partial<Block['end']> = {}): Block {
  return { timeUs: 300_000_000, final: true, rows: [], ...over, end: { frames: 10, ids: 0, overflow: 0, lost: 0, dropped: 0, ...endOver } };
}

function summary(over: Partial<ConnCaptureSummary> = {}, runBlocks: Block[] = [block()]): ConnCaptureSummary {
  return {
    bannerSeen: true,
    frames: 10,
    skippedLines: 0,
    malformedFrames: 0,
    restarts: 0,
    durationS: 10,
    finalSeen: true,
    runBlocks,
    block: runBlocks[runBlocks.length - 1] ?? null,
    ...over,
  };
}

const watchedRow = (count: number) => ({ id: 0x7ff, extended: false, count, minGapMs: null, maxGapMs: null, watched: true });

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
    expect(captureWarnings(summary({}, [block({}, endOver)]))).toEqual([CAPTURE_WARNINGS.incomplete]);
  });

  it('warns about another tester from a watched ID with frames', () => {
    const watched = summary({}, [block({ rows: [watchedRow(3)] }, { ids: 1 })]);
    expect(captureWarnings(watched)).toEqual([CAPTURE_WARNINGS.tester]);
  });

  it('does not warn about a watched ID with zero frames', () => {
    const watched = summary({}, [block({ rows: [watchedRow(0)] }, { ids: 1 })]);
    expect(captureWarnings(watched)).toEqual([]);
  });

  it('warns when there is no summary block or no FINAL block', () => {
    expect(captureWarnings(summary({ finalSeen: false }, []))).toEqual([CAPTURE_WARNINGS.short]);
    expect(captureWarnings(summary({ finalSeen: false }, [block({ final: false })]))).toEqual([CAPTURE_WARNINGS.short]);
  });

  it('does not warn about the window when S blocks follow the FINAL block', () => {
    expect(captureWarnings(summary({ finalSeen: true }, [block({ final: false, timeUs: 310_000_000 })]))).toEqual([]);
  });

  it('warns about data lost or a tester in an earlier node run', () => {
    const before = block({ final: false, rows: [watchedRow(2)] }, { ids: 1, lost: 4 });
    expect(captureWarnings(summary({ restarts: 1 }, [before, block()]))).toEqual([
      CAPTURE_WARNINGS.incomplete,
      CAPTURE_WARNINGS.tester,
      CAPTURE_WARNINGS.restarted,
    ]);
  });

  it('warns when the node restarted', () => {
    expect(captureWarnings(summary({ restarts: 1 }))).toEqual([CAPTURE_WARNINGS.restarted]);
  });
});
