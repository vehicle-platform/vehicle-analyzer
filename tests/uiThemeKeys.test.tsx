// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  FILTER_ATTR,
  GLOBAL_KEYS,
  focusPanelFilter,
  isTypingTarget,
  useHotkeys,
} from '@/ui/keys';
import {
  THEME_STORAGE_KEY,
  ThemeContext,
  initialTheme,
  themeColor,
  useActiveTheme,
  useTheme,
} from '@/ui/theme';
import { KeyBar, KeyHelp } from '@/ui/KeyBar';
import {
  Empty,
  GutterMark,
  ListHead,
  documentTheme,
  scopePalette,
  traceSwatch,
} from '@/ui/panel-parts';

function installMemoryStorage(): Map<string, string> {
  const map = new Map<string, string>();
  const storage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => map.clear(),
    key: (i: number) => Array.from(map.keys())[i] ?? null,
    get length() {
      return map.size;
    },
  };
  Object.defineProperty(window, 'localStorage', { value: storage, configurable: true });
  return map;
}

beforeEach(() => {
  installMemoryStorage();
});

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute('data-theme');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ui/keys', () => {
  it('distinguishes typing targets from buttons/checkboxes/non-elements', () => {
    expect(isTypingTarget(null)).toBe(false);
    const textInput = document.createElement('input');
    textInput.type = 'text';
    expect(isTypingTarget(textInput)).toBe(true);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    expect(isTypingTarget(checkbox)).toBe(false);

    const textarea = document.createElement('textarea');
    expect(isTypingTarget(textarea)).toBe(true);

    const editable = document.createElement('div');
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    expect(isTypingTarget(editable)).toBe(true);

    const div = document.createElement('div');
    expect(isTypingTarget(div)).toBe(false);
    expect(GLOBAL_KEYS.length).toBeGreaterThan(10);
  });

  it('binds single-key hotkeys, ignores modifiers and typing targets, and focuses panel filter', () => {
    const onT = vi.fn();
    const onEsc = vi.fn();
    const Host = ({ enabled = true }: { enabled?: boolean }) => {
      useHotkeys({ t: onT, Escape: onEsc }, enabled);
      return (
        <div data-testid="root">
          <input data-hotkey-filter="true" defaultValue="abc" />
        </div>
      );
    };

    const { rerender } = render(<Host />);
    fireEvent.keyDown(window, { key: 'T' });
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onT).toHaveBeenCalledTimes(1);
    expect(onEsc).toHaveBeenCalledTimes(1);

    fireEvent.keyDown(window, { key: 't', ctrlKey: true });
    fireEvent.keyDown(window, { key: 't', metaKey: true });
    fireEvent.keyDown(window, { key: 't', altKey: true });
    expect(onT).toHaveBeenCalledTimes(1);

    const input = screen.getByDisplayValue('abc') as HTMLInputElement;
    fireEvent.keyDown(input, { key: 't' });
    expect(onT).toHaveBeenCalledTimes(1);

    expect(focusPanelFilter(null)).toBe(false);
    expect(focusPanelFilter(document.createElement('div'))).toBe(false);
    expect(focusPanelFilter(screen.getByTestId('root'))).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(FILTER_ATTR).toBe('data-hotkey-filter');

    rerender(<Host enabled={false} />);
    fireEvent.keyDown(window, { key: 't' });
    expect(onT).toHaveBeenCalledTimes(1);
  });
});

describe('ui/theme & panel-parts & KeyBar', () => {
  it('resolves stored/system theme, toggles, persists, and reads theme tokens', () => {
    let mqMatches = false;
    const listeners = new Set<() => void>();
    vi.stubGlobal('matchMedia', () => ({
      get matches() {
        return mqMatches;
      },
      addEventListener: (_: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_: string, fn: () => void) => listeners.delete(fn),
    }));

    expect(initialTheme()).toBe('dark');
    mqMatches = true;
    expect(initialTheme()).toBe('light');
    window.localStorage.setItem(THEME_STORAGE_KEY, 'dark');
    expect(initialTheme()).toBe('dark');
    window.localStorage.removeItem(THEME_STORAGE_KEY);

    const Probe = () => {
      const { theme, setTheme, toggleTheme } = useTheme();
      const ctx = useActiveTheme();
      return (
        <ThemeContext.Provider value={theme}>
          <span data-testid="theme">{theme}</span>
          <span data-testid="ctx">{ctx}</span>
          <button onClick={() => setTheme('dark')}>set-dark</button>
          <button onClick={toggleTheme}>toggle</button>
        </ThemeContext.Provider>
      );
    };

    render(<Probe />);
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(documentTheme()).toBe('light');

    act(() => {
      mqMatches = false;
      listeners.forEach((fn) => fn());
    });
    expect(screen.getByTestId('theme').textContent).toBe('dark');

    fireEvent.click(screen.getByText('toggle'));
    expect(screen.getByTestId('theme').textContent).toBe('light');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('light');

    fireEvent.click(screen.getByText('set-dark'));
    expect(screen.getByTestId('theme').textContent).toBe('dark');
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe('dark');

    document.documentElement.style.setProperty('--t-hi', '240 240 240');
    document.documentElement.style.setProperty('--t-amber', '224 162 70');
    expect(themeColor('hi')).toBe('rgb(240 240 240)');
    expect(themeColor('hi', 0.5)).toBe('rgb(240 240 240 / 0.5)');
    expect(scopePalette('dark').length).toBe(6);
    expect(traceSwatch('dark', 0)).toEqual({ className: 'text-term-hi' });
    expect(traceSwatch('dark', 1)).toEqual({ className: 'text-term-amber' });
    expect(traceSwatch('light', 2).style?.color).toBeTruthy();
  });

  it('renders KeyBar, KeyHelp dialog, GutterMark, ListHead, and Empty', () => {
    const onClose = vi.fn();
    render(
      <>
        <KeyBar keys={[{ k: 'T', label: 'Trace' }]} status={<span>ok</span>} />
        <KeyHelp
          groups={[
            { title: 'Views', keys: [{ k: 'T', label: 'Trace' }] },
            { title: 'Other', keys: [{ k: '?', label: 'Help' }] },
          ]}
          onClose={onClose}
        />
        <GutterMark cursor />
        <GutterMark fault />
        <GutterMark />
        <ListHead aside="3">Signals</ListHead>
        <Empty>Nothing here</Empty>
      </>
    );

    expect(screen.getByText('Signals')).toBeTruthy();
    expect(screen.getByText('Nothing here')).toBeTruthy();
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();

    fireEvent.click(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/Close/));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
