import { expect, test, type Page } from '@playwright/test';

const SERVER = 'http://localhost:8000';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept',
  'access-control-allow-methods': 'GET, OPTIONS',
};

const instance = {
  start_ms: 3_000,
  end_ms: 30_000,
  duration_ms: 27_000,
  close_reason: 'condition',
  qualifies: true,
  first_qualifying: true,
};

const REPORT = {
  status: 'ok',
  derived_summary: {
    health_windows: {
      rule: 'provisional: Claude’s reading of D-079',
      t0_device_ms: 0,
      windows: {
        W3_WARM_IDLE: {
          qualifying_count: 1,
          instances: [instance, { ...instance, start_ms: 40_000, end_ms: 45_000, duration_ms: 5_000, qualifies: false, first_qualifying: false }],
        },
      },
    },
  },
};

const SUMMARY = {
  session_id: 'ride-1',
  ride_definition: 'session',
  defs_version: 'v0.0.0-test',
  signals: [{ name: 'window_warm_idle_rpm_spread', status: 'computed', unit: 'rpm', range: [0, 500], kind: 'scalar', value: 100, flag: null }],
};

async function routeServer(page: Page) {
  await page.route(`${SERVER}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const headers = { ...CORS, 'content-type': 'application/json' };
    const url = new URL(route.request().url());
    if (url.pathname === '/sessions') await route.fulfill({ status: 200, headers, body: JSON.stringify([{ session_id: 'ride-1' }]) });
    else if (url.pathname === '/sessions/ride-1/report') await route.fulfill({ status: 200, headers, body: JSON.stringify(REPORT) });
    else if (url.pathname === '/sessions/ride-1/summary') await route.fulfill({ status: 200, headers, body: JSON.stringify(SUMMARY) });
    else await route.fulfill({ status: 404, headers, body: JSON.stringify({ detail: 'not found' }) });
  });
}

test('Health windows card shows the report instances and stays on the app and configured server', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await routeServer(page);

  await page.goto('/');
  await page.keyboard.press('e');
  await page.getByRole('button', { name: /Refresh/ }).click();
  await page.getByRole('button', { name: /ride-1/ }).click();

  const card = page.getByRole('region', { name: 'Health windows' });
  await expect(card).toBeVisible();
  await expect(card).toContainText('provisional: Claude’s reading of D-079');
  await expect(card.getByRole('img', { name: 'Health window timeline' })).toBeVisible();
  await expect(card.locator('[data-testid="health-window-band"]')).toHaveCount(2);
  await expect(card.locator('[data-first-qualifying="true"]')).toHaveCount(1);
  await expect(card.getByRole('table', { name: 'W3_WARM_IDLE instances' })).toContainText('condition');
  await expect(card.getByRole('table', { name: 'W3_WARM_IDLE computed signals' })).toContainText('100.00');
  await expect(card.getByLabel('W4_CRUISE window detail')).toContainText('not evaluated');

  const foreign = requests.filter((url) => {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !['localhost', '127.0.0.1'].includes(u.hostname);
  });
  expect(foreign).toEqual([]);
  expect(requests.filter((url) => url.startsWith(SERVER))).toContain(`${SERVER}/sessions/ride-1/report`);
  // The ride summary and the health windows share one /summary request.
  expect(requests.filter((url) => url === `${SERVER}/sessions/ride-1/summary`)).toHaveLength(1);
});
