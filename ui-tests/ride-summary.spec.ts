import { expect, test, type Page } from '@playwright/test';

const SERVER = 'http://localhost:8000';
const SESSIONS = [{ session_id: 'ride-1' }, { session_id: 'ride-2' }];
const SUMMARY = {
  session_id: 'ride-1',
  ride_definition: 'session',
  defs_version: 'v0.0.0-test',
  signals: [
    { name: 'ride_distance', status: 'computed', unit: 'km', range: [0, 1000], kind: 'scalar', value: 12.3, flag: null },
    {
      name: 'ride_coolant_time_at_temp',
      status: 'computed',
      unit: 's',
      range: [0, 100000],
      kind: 'binned',
      axes: [{ input: 'did.COOLANT_TEMP', unit: 'degC', edges: [[0, 60], [60, 90], [90, 120]] }],
      cells: [
        { index: 0, axes: [0], value: 40, flag: null },
        { index: 1, axes: [1], value: 800, flag: null },
        { index: 2, axes: [2], value: 60, flag: null },
      ],
      total_s: 900,
      outside_s: 3,
    },
    { name: 'ride_fuel_used', status: 'missing_inputs', missing: ['did.FUEL_RATE'] },
  ],
};
const BRINGUP = {
  session_id: 'ride-1',
  gate: 'V0',
  verdict: 'incomplete',
  checks: [
    { id: 'can_alive', status: 'pass', measured: { frames: 120 }, expected: '> 0 frames', source: 'report', note: '' },
    { id: 'led_ring', status: 'manual', measured: null, expected: 'LEDs lit', source: 'manual', note: 'look at the ring' },
  ],
  needs_you: ['led_ring'],
  warnings: [],
};
const RIDES = {
  columns: [{ name: 'ride_distance', unit: 'km' }],
  rows: [
    { session_id: 'ride-1', created_utc: '2026-01-01T10:00:00Z', values: { ride_distance: 12.3 }, flags: { ride_distance: null } },
    { session_id: 'ride-2', created_utc: '2026-01-02T10:00:00Z', values: { ride_distance: 20 }, flags: { ride_distance: null } },
  ],
  skipped: 0,
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept',
  'access-control-allow-methods': 'GET, OPTIONS',
};

async function routeServer(page: Page) {
  await page.route(`${SERVER}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const url = new URL(request.url());
    const headers = { ...CORS, 'content-type': 'application/json' };
    const json = (body: unknown, status = 200) => route.fulfill({ status, headers, body: JSON.stringify(body) });
    if (url.pathname === '/sessions') await json(SESSIONS);
    else if (url.pathname === '/sessions/ride-1/report') await json({ status: 'ok' });
    else if (url.pathname === '/sessions/ride-1/summary') await json(SUMMARY);
    else if (url.pathname === '/sessions/ride-2/summary') await json({ detail: 'session has no ride summary' }, 404);
    else if (url.pathname === '/sessions/ride-1/bringup') await json(BRINGUP);
    else if (url.pathname === '/sessions/ride-2/bringup') await json({ detail: 'Not Found' }, 404);
    else if (url.pathname === '/rides') await json(RIDES);
    else await json({ detail: 'not found' }, 404);
  });
}

function watch(page: Page) {
  const requests: string[] = [];
  const consoleErrors: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  return { requests, consoleErrors };
}

function expectOnlyOwnOrigins(page: Page, requests: string[]) {
  const allowed = new Set([new URL(page.url()).origin, SERVER]);
  const httpRequests = requests.filter((u) => /^https?:/i.test(u));
  expect(httpRequests.length).toBeGreaterThan(0);
  for (const request of httpRequests) expect(allowed.has(new URL(request).origin)).toBe(true);
}

test('Sessions view shows the stored ride summary of the selected session', async ({ page }) => {
  const { requests, consoleErrors } = watch(page);
  await routeServer(page);

  await page.goto('/');
  await page.keyboard.press('e');
  await page.getByRole('button', { name: /Refresh/ }).click();
  await page.getByRole('button', { name: /ride-1/ }).click();

  const scalars = page.getByRole('table', { name: 'Ride summary scalars' });
  await expect(scalars).toContainText('ride_distance');
  await expect(scalars).toContainText('km');
  await expect(page.getByRole('img', { name: 'ride_coolant_time_at_temp bins' })).toBeVisible();

  const verdict = page.getByLabel('Bring-up verdict');
  await expect(verdict).toContainText('V0 incomplete');
  await expect(verdict).toContainText('1 manual check pending');
  await expect(page.getByRole('table', { name: 'Bring-up checks' })).toContainText('can_alive');

  await page.getByRole('button', { name: /ride-2/ }).click();
  await expect(page.getByText('this server has no bring-up check (needs vehicle-server with LR12)')).toBeVisible();
  await expect(page.getByText('No stored ride summary for this session.')).toBeVisible();

  expectOnlyOwnOrigins(page, requests);
  expect(consoleErrors).toEqual([]);
});

test('Ride history view draws the /rides columns and opens a ride in Sessions', async ({ page }) => {
  const { requests, consoleErrors } = watch(page);
  await routeServer(page);

  await page.goto('/');
  await page.keyboard.press('n');
  await expect(page.getByRole('tab', { name: /Ride history/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /Refresh/ }).click();

  await expect(page.getByRole('img', { name: 'ride_distance ride history' })).toBeVisible();
  await page.getByRole('button', { name: /^ride-2 · 20/ }).click();
  await expect(page.getByRole('tab', { name: /Sessions/ })).toHaveAttribute('aria-selected', 'true');

  expectOnlyOwnOrigins(page, requests);
  expect(consoleErrors).toEqual([]);
});
