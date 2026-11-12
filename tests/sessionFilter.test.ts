import { describe, expect, it } from 'vitest';
import type { SessionRow } from '@/services/sessionClient';
import {
  SESSION_FILTER_STORAGE_KEY,
  defaultSessionFilter,
  filterSessions,
  loadSessionFilter,
  parseUtcBound,
  saveSessionFilter,
  sessionStatuses,
} from '@/services/sessionFilter';

const rows: SessionRow[] = [
  { session_id: 'ride-a', status: 'ok', created_utc: '2026-01-15T00:00:00Z', loss_percent: 1 },
  { session_id: 'ride-b', status: 'warn', created_utc: '2026-01-15T23:59:59Z', loss_percent: 0.2 },
  { session_id: 'ride-c', status: 'fail', created_utc: '2026-01-16T00:00:00Z', loss_percent: 5 },
];

const withFilter = (changes: Partial<ReturnType<typeof defaultSessionFilter>>) => ({
  ...defaultSessionFilter(),
  ...changes,
});

describe('sessionFilter', () => {
  it('takes statuses from the loaded rows, without a fixed vocabulary', () => {
    expect(sessionStatuses(rows)).toEqual(['fail', 'ok', 'warn']);
    expect(sessionStatuses([{ session_id: 'x', status: 'weird' }])).toEqual(['weird']);
    expect(sessionStatuses([{ session_id: 'x' }])).toEqual([]);
  });

  it('keeps a selected status listed when no loaded row has it', () => {
    expect(sessionStatuses(rows, ['stale'])).toEqual(['fail', 'ok', 'stale', 'warn']);
    expect(sessionStatuses([], ['ok'])).toEqual(['ok']);
  });

  it('filters the session id case-insensitively', () => {
    expect(filterSessions(rows, withFilter({ text: ' RIDE-B ' })).map((r) => r.session_id)).toEqual(['ride-b']);
  });

  it('filters by status values selected from the data', () => {
    expect(filterSessions(rows, withFilter({ statuses: ['warn', 'fail'] })).map((r) => r.session_id)).toEqual([
      'ride-c',
      'ride-b',
    ]);
  });

  it('treats date-only bounds as the whole UTC day', () => {
    expect(parseUtcBound('2026-01-15', false)).toBe(Date.UTC(2026, 0, 15));
    expect(parseUtcBound('2026-01-15', true)).toBe(Date.UTC(2026, 0, 15) + 86_400_000 - 1);
    expect(filterSessions(rows, withFilter({ from: '2026-01-15', to: '2026-01-15' })).map((r) => r.session_id)).toEqual([
      'ride-b',
      'ride-a',
    ]);
  });

  it('sorts newest first by default and by loss on request', () => {
    expect(filterSessions(rows, defaultSessionFilter()).map((r) => r.session_id)).toEqual(['ride-c', 'ride-b', 'ride-a']);
    expect(filterSessions(rows, withFilter({ sort: 'loss' })).map((r) => r.session_id)).toEqual([
      'ride-c',
      'ride-a',
      'ride-b',
    ]);
  });

  it('puts rows without a valid created_utc last', () => {
    const mixed: SessionRow[] = [...rows, { session_id: 'ride-unknown' }];
    expect(filterSessions(mixed, defaultSessionFilter()).at(-1)?.session_id).toBe('ride-unknown');
  });

  it('ignores an invalid date instead of hiding every row', () => {
    expect(filterSessions(rows, withFilter({ from: 'not-a-date' }))).toHaveLength(3);
  });

  it('round-trips the filter and falls back when storage is broken', () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
    };
    const filter = withFilter({ text: 'ride', statuses: ['ok'], from: '2026-01-01', to: '2026-01-02', sort: 'loss' });

    saveSessionFilter(filter, storage);
    expect(values.has(SESSION_FILTER_STORAGE_KEY)).toBe(true);
    expect(loadSessionFilter(storage)).toEqual(filter);

    values.set(SESSION_FILTER_STORAGE_KEY, '{');
    expect(loadSessionFilter(storage)).toEqual(defaultSessionFilter());
  });

  it('never throws when localStorage is unavailable', () => {
    const throwing = {
      getItem: () => {
        throw new Error('disabled');
      },
      setItem: () => {
        throw new Error('disabled');
      },
    };
    expect(loadSessionFilter(throwing)).toEqual(defaultSessionFilter());
    expect(() => saveSessionFilter(defaultSessionFilter(), throwing)).not.toThrow();
  });
});
