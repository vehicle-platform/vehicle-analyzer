import { expect, test } from '@playwright/test';

const SERVER = 'http://localhost:8000';
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept',
  'access-control-allow-methods': 'GET, OPTIONS',
};

test('Signal coverage view loads a mocked report and stays on the app and configured server', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.route(`${SERVER}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const headers = { ...CORS, 'content-type': 'application/json' };
    const url = new URL(route.request().url());
    if (url.pathname === '/sessions/ride-1/report') {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ valid_ratios: {}, imu: { sample_count: 1 }, gps: null }) });
    } else {
      await route.fulfill({ status: 404, headers, body: JSON.stringify({ detail: 'not found' }) });
    }
  });

  await page.goto('/');
  await page.keyboard.press('i');
  await expect(page.getByRole('tab', { name: /Signal coverage/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByLabel('Session id').fill('ride-1');
  await page.getByRole('button', { name: /Load session/ }).click();
  await expect(page.getByText('Report loaded for ride-1.')).toBeVisible();
  await expect(page.getByRole('table', { name: 'Signal coverage' }).getByText('not in report').first()).toBeVisible();

  const foreign = requests.filter((url) => {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && !['localhost', '127.0.0.1'].includes(u.hostname);
  });
  expect(foreign).toEqual([]);
  expect(requests.filter((url) => url.startsWith(SERVER)).every((url) => url.includes('/sessions/ride-1/report'))).toBe(true);
});
