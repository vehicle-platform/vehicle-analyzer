// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BringupCheck } from '@/components/BringupCheck';
import { jsonResponse } from './helpers';

const fail = (status: number, body: unknown) =>
  ({
    ok: false,
    status,
    statusText: '',
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as Response;

const check = (id: string, status: string, over: Record<string, unknown> = {}) => ({
  id,
  status,
  measured: null,
  expected: 'exp',
  source: 'did.X',
  note: '',
  ...over,
});

const result = (verdict: string, checks: unknown[], needs: string[] = [], warnings: string[] = [], gate = 'V0') => ({
  session_id: 'ride-1',
  gate,
  verdict,
  checks,
  needs_you: needs,
  warnings,
});

const props = (over: Partial<React.ComponentProps<typeof BringupCheck>> = {}) => ({
  token: 'secret-token',
  serverUrl: 'http://localhost:8000',
  sessionId: 'ride-1',
  ...over,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('BringupCheck', () => {
  it('shows a passing verdict and the check rows as the server sent them', async () => {
    const body = result('pass', [
      check('can_alive', 'pass', { measured: 12.5, expected: '> 0', note: 'frames seen' }),
      check('rails', 'warn', { measured: { v3v3: 3.28, nested: { a: 1 } } }),
      check('wiring', 'unknown'),
    ], [], ['rails']);
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(body)));
    render(<BringupCheck {...props()} />);

    expect((await screen.findByLabelText('Bring-up verdict')).textContent).toContain('V0 pass');
    expect(screen.queryByText(/manual check/)).toBeNull();
    const table = screen.getByRole('table', { name: 'Bring-up checks' });
    expect(table.textContent).toContain('can_alive');
    expect(table.textContent).toContain('12.5');
    expect(table.textContent).toContain('v3v3=3.28 nested={"a":1}');
    expect(table.textContent).toContain('—');
    expect(table.textContent).toContain('frames seen');
    expect(table.textContent).toContain('did.X');
  });

  it('shows a failing verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(result('fail', [check('can_alive', 'fail')]))));
    render(<BringupCheck {...props()} />);
    expect((await screen.findByLabelText('Bring-up verdict')).textContent).toContain('V0 fail');
    expect(screen.getByText(/■ fail/, { selector: 'td span' })).toBeTruthy();
  });

  it('shows incomplete with the pending manual checks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(result('incomplete', [check('led', 'manual'), check('horn', 'manual')], ['led', 'horn']))));
    render(<BringupCheck {...props()} />);
    const verdict = await screen.findByLabelText('Bring-up verdict');
    expect(verdict.textContent).toContain('V0 incomplete');
    expect(verdict.textContent).toContain('2 manual checks pending');
  });

  it('asks the server again when the gate changes', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(result('pass', [])));
    vi.stubGlobal('fetch', fetchMock);
    render(<BringupCheck {...props()} />);
    await screen.findByLabelText('Bring-up verdict');
    expect(String(fetchMock.mock.calls[0][0])).toBe('http://localhost:8000/sessions/ride-1/bringup?gate=V0');
    fireEvent.click(screen.getByRole('radio', { name: 'B0' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[1][0])).toBe('http://localhost:8000/sessions/ride-1/bringup?gate=B0');
  });

  it('says the server is too old on a missing route, without an alert', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(404, { detail: 'Not Found' })));
    render(<BringupCheck {...props()} />);
    expect(await screen.findByText('this server has no bring-up check (needs vehicle-server with LR12)')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows an unknown session as a normal error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(404, { detail: 'unknown session: ride-1' })));
    render(<BringupCheck {...props()} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Not found \(404\)/);
    expect(screen.queryByText(/no bring-up check/)).toBeNull();
  });

  it('shows the server detail of a 422', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fail(422, { detail: 'unknown gate: V9' })));
    render(<BringupCheck {...props()} />);
    expect((await screen.findByRole('alert')).textContent).toContain('unknown gate: V9');
  });

  it('sends the token in the Authorization header only', async () => {
    const fetchMock = vi.fn(async (_url: string, _init: { headers: Record<string, string> }) => jsonResponse(result('pass', [])));
    vi.stubGlobal('fetch', fetchMock);
    render(<BringupCheck {...props()} />);
    await screen.findByLabelText('Bring-up verdict');
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).not.toContain('secret-token');
    expect(init.headers.Authorization).toBe('Bearer secret-token');
  });
});
