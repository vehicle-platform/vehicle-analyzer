import { expect, test } from '@playwright/test';

const SERVER = 'http://localhost:8000';
const TRACK = {
  session_id: 'ride-1',
  t0_device_ms: 8600,
  method: 'dead_reckoning',
  frame: 'relative_enu_from_first_fix',
  max_points: 2000,
  points_total: 3,
  downsampled: false,
  path_length_m: 12.5,
  segments_total: 1,
  excluded: { no_fix: 0, stale_fix: 0, untrusted_heading: 0 },
  color: null,
  segments: [
    {
      t_ms: [0, 100, 200],
      x_m: [0, 1, 2],
      y_m: [0, 1, 2],
      speed_mps: [1, 2, 3],
      heading_deg: [0, 45, 90],
      gap_before_ms: null,
    },
  ],
};
const SERIES = {
  session_id: 'ride-1',
  t0_device_ms: 8600,
  max_points: 10,
  series: [
    { name: 'sensor.gps_ground_speed', kind: 'sensor', unit: 'm/s', t_ms: [0], v: [1] },
    { name: 'sensor.lean_angle', kind: 'sensor', unit: 'deg', t_ms: [0], v: [1] },
  ],
};
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'authorization, accept',
  'access-control-allow-methods': 'GET, OPTIONS',
};

test('Track view stays on the app and configured server, then zooms and recolours', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));

  await page.route(`${SERVER}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const url = new URL(request.url());
    const headers = { ...CORS, 'content-type': 'application/json' };
    if (url.pathname === '/sessions') {
      await route.fulfill({ status: 200, headers, body: JSON.stringify([{ session_id: 'ride-1' }]) });
    } else if (url.pathname === '/sessions/ride-1/report') {
      await route.fulfill({ status: 200, headers, body: JSON.stringify({ status: 'ok' }) });
    } else if (url.pathname === '/sessions/ride-1/series') {
      await route.fulfill({ status: 200, headers, body: JSON.stringify(SERIES) });
    } else if (url.pathname === '/sessions/ride-1/track') {
      if (url.searchParams.get('color') === 'sensor.lean_angle') {
        await route.fulfill({
          status: 200,
          headers,
          body: JSON.stringify({
            ...TRACK,
            color: { name: 'sensor.lean_angle', unit: 'deg' },
            segments: [{ ...TRACK.segments[0], color_v: [1, 2, null] }],
          }),
        });
      } else {
        await route.fulfill({ status: 200, headers, body: JSON.stringify(TRACK) });
      }
    } else {
      await route.fulfill({ status: 404, headers, body: JSON.stringify({ detail: 'not found' }) });
    }
  });

  await page.goto('/');
  await page.keyboard.press('e');
  await page.getByRole('button', { name: /Refresh/ }).click();
  await page.getByRole('button', { name: /ride-1/ }).click();
  await page.keyboard.press('g');

  await expect(page.getByRole('tab', { name: /Ride track/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Dead-reckoned from GNSS speed and heading. Approximate shape, not a map.')).toBeVisible();
  await expect(page.getByLabel('Colour legend')).toContainText('speed');

  const canvas = page.getByRole('img', { name: 'Relative ride track' });
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, -160);
  }

  await page.getByLabel('Track colour').selectOption('sensor.lean_angle');
  await expect(page.getByLabel('Colour legend')).toContainText('sensor.lean_angle');
  await expect(page.getByLabel('Colour legend')).toContainText('deg');

  const allowed = new Set([new URL(page.url()).origin, SERVER]);
  const httpRequests = requests.filter((u) => /^https?:/i.test(u));
  expect(httpRequests.length).toBeGreaterThan(0);
  for (const request of httpRequests) expect(allowed.has(new URL(request).origin)).toBe(true);
});
