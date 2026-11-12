// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReplayScrubber } from '@/components/ReplayScrubber';

afterEach(cleanup);

describe('ReplayScrubber', () => {
  it('drives the replay transport without hardware', () => {
    const onToggleReplay = vi.fn();
    const onSpeedChange = vi.fn();
    const onScrub = vi.fn();
    const onStepForward = vi.fn();
    const onStepBackward = vi.fn();
    const onRestart = vi.fn();

    render(
      <ReplayScrubber
        isReplaying={false}
        onToggleReplay={onToggleReplay}
        currentIndex={3}
        totalFrames={11}
        currentTimeSec={1.5}
        totalDurationSec={12}
        playbackSpeed={1}
        onSpeedChange={onSpeedChange}
        onScrub={onScrub}
        onStepForward={onStepForward}
        onStepBackward={onStepBackward}
        onRestart={onRestart}
      />
    );

    expect(screen.getByText('00:01.50')).toBeTruthy();
    expect(screen.getByText('00:12.00')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /Play/ }));
    expect(onToggleReplay).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('radio', { name: '2x' }));
    expect(onSpeedChange).toHaveBeenCalledWith(2);

    fireEvent.change(screen.getByLabelText('Replay position'), { target: { value: '5' } });
    expect(onScrub).toHaveBeenCalledWith(5);

    fireEvent.click(screen.getByTitle('Step one frame forward'));
    expect(onStepForward).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Step one frame back'));
    expect(onStepBackward).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTitle('Restart replay'));
    expect(onRestart).toHaveBeenCalledTimes(1);
  });
});
