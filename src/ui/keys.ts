import { useEffect, useRef } from 'react';

/**
 * Single-key shortcuts in the style of a terminal tool. A binding fires on keydown when
 * focus is not in a text field and no Ctrl / Alt / Meta modifier is held (Shift is
 * allowed so `?` works). Keys are matched case-insensitively on `KeyboardEvent.key`;
 * use ' ' for space and 'Escape' for escape.
 */
export type KeyBindings = Record<string, (e: KeyboardEvent) => void>;

/** Keys owned by App; panel-local bindings must not reuse them. */
export const GLOBAL_KEYS = ['t', 's', 'o', 'u', 'h', 'f', 'd', 'e', 'a', 'g', 'n', 'i', ' ', 'c', 'x', 'l', '/', '?', 'Escape'] as const;

/** Attribute that marks the input `/` focuses in the active panel. */
export const FILTER_ATTR = 'data-hotkey-filter';

/** True when the event target takes typed text, so shortcuts must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    // Buttons, checkboxes, radios and ranges do not take text.
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color'].includes(type);
  }
  return false;
}

function normalise(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key;
}

/**
 * Bind single keys while the component is mounted. The bindings object may change on
 * every render; the latest one is used without re-registering the listener.
 */
export function useHotkeys(bindings: KeyBindings, enabled = true): void {
  const ref = useRef(bindings);
  ref.current = bindings;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      if (isTypingTarget(e.target)) return;
      const map = ref.current;
      const key = normalise(e.key);
      const handler = map[key] ?? map[e.key];
      if (!handler) return;
      e.preventDefault();
      handler(e);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

/**
 * Focus the filter input of the visible panel (`[data-hotkey-filter]` inside `root`).
 * Returns false when the panel has none.
 */
export function focusPanelFilter(root: ParentNode | null): boolean {
  if (!root) return false;
  const el = root.querySelector<HTMLElement>(`[${FILTER_ATTR}]`);
  if (!el) return false;
  el.focus();
  if (el instanceof HTMLInputElement) el.select();
  return true;
}
