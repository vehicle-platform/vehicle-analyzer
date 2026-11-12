// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { CaptureQuality } from '@/components/CaptureQuality';
import type { ConnCaptureSummary } from '@/services/connCaptureParser';

afterEach(cleanup);

const block: NonNullable<ConnCaptureSummary['block']> = {
  timeUs: 300_000_000,
  final: true,
  rows: [
    { id: 0x300, extended: false, count: 4, minGapMs: 10, maxGapMs: 20.5, watched: false },
    { id: 0x100, extended: false, count: 8, minGapMs: 5, maxGapMs: 6.25, watched: false },
    { id: 0x123, extended: true, count: 1, minGapMs: null, maxGapMs: null, watched: true },
  ],
  end: { frames: 13, ids: 3, overflow: 0, lost: 1, dropped: 0 },
};

const summary: ConnCaptureSummary = {
  bannerSeen: true,
  frames: 12,
  skippedLines: 2,
  malformedFrames: 1,
  restarts: 1,
  durationS: 12.5,
  finalSeen: true,
  runBlocks: [block],
  block,
};

describe('CaptureQuality', () => {
  it('renders counts, warnings and the per-ID table sorted by id', () => {
    render(<CaptureQuality summary={summary} />);

    expect(screen.getByText('Capture quality')).toBeTruthy();
    expect(screen.getByText('12.500 s')).toBeTruthy();
    expect(screen.getByText(/the capture is incomplete/)).toBeTruthy();
    expect(screen.getByText(/the node restarted during the capture/)).toBeTruthy();

    const rows = screen.getAllByRole('row');
    expect(within(rows[1]).getByText('0x100')).toBeTruthy();
    expect(within(rows[2]).getByText('0x00000123')).toBeTruthy();
    expect(within(rows[2]).getByText('X')).toBeTruthy();
    expect(within(rows[2]).getByText('W')).toBeTruthy();
    expect(within(rows[3]).getByText('0x300')).toBeTruthy();
    expect(screen.getByText(/last node run only/)).toBeTruthy();
  });

  it('says when there are no warnings', () => {
    const clean = { ...block, rows: block.rows.map((row) => ({ ...row, watched: false })), end: { ...block.end, lost: 0 } };
    render(
      <CaptureQuality
        summary={{
          ...summary,
          restarts: 0,
          runBlocks: [clean],
          block: clean,
        }}
      />
    );
    expect(screen.getByText('no warnings')).toBeTruthy();
    expect(screen.getByText('No capture-quality warnings.')).toBeTruthy();
  });
});
