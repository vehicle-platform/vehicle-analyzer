// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '@/App';
import { KeyBar, TermButton, ThemeContext, Toolbar } from '@/ui';
import { readLayout } from '@/ui/layout';
import { setThemeColors } from './helpers';

let memStorage: Map<string, string>;

beforeEach(() => {
  setThemeColors();
  memStorage = new Map();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => memStorage.get(k) ?? null,
    setItem: (k: string, v: string) => void memStorage.set(k, v),
    removeItem: (k: string) => void memStorage.delete(k),
    clear: () => memStorage.clear(),
  });
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: async () => [],
      text: async () => '[]',
    }))
  );
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('App and MainWorkspace wiring', () => {
  it('switches across cockpit views via hotkeys, toggles HUD, theme, pause, clear, and key help', () => {
    render(<App />);

    // Default UI chrome renders listen-only banner and Attitude HUD.
    expect(screen.getByText('listen-only')).toBeTruthy();
    expect(screen.getByLabelText('Lean and cornering')).toBeTruthy();

    // Toggle Attitude HUD off and back on with 'x'.
    fireEvent.keyDown(window, { key: 'x' });
    expect(screen.queryByLabelText('Lean and cornering')).toBeNull();
    fireEvent.keyDown(window, { key: 'x' });
    expect(screen.getByLabelText('Lean and cornering')).toBeTruthy();

    // Open and close the key help overlay via '?' and the Close button.
    fireEvent.keyDown(window, { key: '?' });
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Close/ }));
    expect(screen.queryByRole('dialog')).toBeNull();

    // Header Pause/Resume and HUD buttons toggle live state and side pane.
    fireEvent.click(screen.getByTitle('Pause the live source'));
    expect(screen.getByTitle('Resume the live source')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Resume the live source'));
    expect(screen.getByTitle('Pause the live source')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Lean angle and cornering pane (X)'));
    expect(screen.queryByLabelText('Lean and cornering')).toBeNull();
    fireEvent.click(screen.getByTitle('Lean angle and cornering pane (X)'));
    expect(screen.getByLabelText('Lean and cornering')).toBeTruthy();

    // Filter focus hotkey '/' does not throw and keeps active view intact.
    fireEvent.keyDown(window, { key: '/' });

    // Toggle light/dark theme via 'l'.
    const beforeTheme = document.documentElement.dataset.theme;
    fireEvent.keyDown(window, { key: 'l' });
    expect(document.documentElement.dataset.theme).not.toBe(beforeTheme);

    // Pause and resume virtual source via Space, and clear store via 'c'.
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getAllByText('Run').length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: ' ' });
    expect(screen.getAllByText('Pause').length).toBeGreaterThan(0);
    fireEvent.keyDown(window, { key: 'c' });

    // Cycle every MainWorkspace tab via global hotkeys and confirm layout persists.
    const tabKeys: [string, string][] = [
      ['s', 'sniffer'],
      ['o', 'oscilloscope'],
      ['u', 'uds'],
      ['h', 'health'],
      ['f', 'cluster'],
      ['d', 'sync'],
      ['e', 'session'],
      ['a', 'compare'],
      ['g', 'track'],
      ['n', 'rides'],
      ['i', 'coverage'],
      ['t', 'trace'],
    ];
    for (const [key, expectedView] of tabKeys) {
      fireEvent.keyDown(window, { key });
      expect(readLayout().view).toBe(expectedView);
    }
  });

  it('switches telemetry sources to replay tabs and back to virtual live source', () => {
    render(<App />);

    fireEvent.click(screen.getByRole('radio', { name: /Log replay/ }));
    expect(screen.getByRole('radio', { name: /Log replay/ }).getAttribute('aria-checked')).toBe('true');
    // ReplayScrubber mounts when a replay source is active; transport controls work.
    expect(screen.getAllByText(/frame/i).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByTitle('Play replay'));
    expect(screen.getByTitle('Pause replay')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Pause replay'));
    expect(screen.getByTitle('Play replay')).toBeTruthy();
    fireEvent.click(screen.getByTitle('Step one frame forward'));
    fireEvent.click(screen.getByTitle('Step one frame back'));
    fireEvent.click(screen.getByTitle('Restart replay'));
    fireEvent.keyDown(window, { key: ' ' });

    fireEvent.click(screen.getByRole('radio', { name: /Session/ }));
    expect(screen.getByRole('radio', { name: /Session/ }).getAttribute('aria-checked')).toBe('true');

    fireEvent.click(screen.getByRole('radio', { name: /Virtual bus/ }));
    expect(screen.getByRole('radio', { name: /Virtual bus/ }).getAttribute('aria-checked')).toBe('true');
  });

  it('exports UI primitives through the barrel index', () => {
    expect(ThemeContext).toBeDefined();
    expect(KeyBar).toBeDefined();
    expect(TermButton).toBeDefined();
    expect(Toolbar).toBeDefined();
  });
});
