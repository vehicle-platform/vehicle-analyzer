import { expect, test, type Page } from '@playwright/test';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function watch(page: Page) {
  const consoleErrors: string[] = [];
  const foreignRequests: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !LOCAL_HOSTS.has(url.hostname)) {
      foreignRequests.push(request.url());
    }
  });
  return { consoleErrors, foreignRequests };
}

const VIEWS = [
  { key: 't', label: 'CAN trace', target: (page: Page) => page.getByLabel('Filter frames') },
  { key: 's', label: 'Sniffer', target: (page: Page) => page.getByRole('radiogroup', { name: 'Sniffer view' }) },
  { key: 'o', label: 'Oscilloscope', target: (page: Page) => page.getByRole('radiogroup', { name: 'Time window' }) },
  { key: 'u', label: 'UDS', target: (page: Page) => page.getByRole('radiogroup', { name: 'UDS view' }) },
  { key: 'h', label: 'Health', target: (page: Page) => page.getByText('D-079 health windows W1–W5') },
  { key: 'f', label: 'Cluster', target: (page: Page) => page.getByText('Engine & speed') },
  { key: 'd', label: 'Defs & logs', target: (page: Page) => page.getByRole('navigation', { name: 'Definitions' }) },
  { key: 'e', label: 'Sessions', target: (page: Page) => page.getByText('recorded sessions') },
  { key: 'a', label: 'Compare', target: (page: Page) => page.getByText('Pick two sessions (Refresh first) and press Compare.') },
  { key: 'g', label: 'Ride track', target: (page: Page) => page.getByText('No recorded session selected. Pick one in Sessions (E).') },
];

for (const view of VIEWS) {
  test(`${view.label} opens with the virtual source and no console errors`, async ({ page }) => {
    const { consoleErrors, foreignRequests } = watch(page);
    await page.goto('/');

    await page.keyboard.press(view.key);
    await expect(page.getByRole('tab', { name: new RegExp(view.label) })).toHaveAttribute('aria-selected', 'true');
    await expect(view.target(page)).toBeVisible();
    await expect(page.getByRole('radio', { name: /Virtual bus/ })).toHaveAttribute('aria-checked', 'true');

    expect(foreignRequests).toEqual([]);
    expect(consoleErrors).toEqual([]);
  });
}

test('remembers the last view and HUD layout across reloads', async ({ page }) => {
  const { consoleErrors, foreignRequests } = watch(page);
  await page.goto('/');

  await page.keyboard.press('f');
  await expect(page.getByRole('tab', { name: /Cluster/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: /HUD/ }).click();
  await expect(page.locator('aside[aria-label="Lean and cornering"]')).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('tab', { name: /Cluster/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('aside[aria-label="Lean and cornering"]')).toHaveCount(0);

  expect(foreignRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
