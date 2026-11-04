import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { parseDbcText } from '../src/services/dbcParser';

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

/** 200 k ASC frames packed from the pinned platform DBC: no hand-written message facts. */
function largeAsc(): { name: string; buffer: Buffer } {
  const dbc = readFileSync(new URL('../external/vehicle-defs/dbc/platform.dbc', import.meta.url), 'utf8');
  const message = parseDbcText(dbc).find((m) => m.dlc > 0 && m.cycleTimeMs);
  if (!message) throw new Error('platform.dbc has no periodic message to build the import fixture from');

  const idHex = `${message.id.toString(16).toUpperCase()}${message.isExtended ? 'x' : ''}`;
  const data = Array(message.dlc).fill('00').join(' ');
  const lines = [`date ${new Date(0).toUTCString()}`, 'base hex  timestamps absolute'];
  for (let i = 0; i < 200_000; i++) {
    lines.push(`${(i * 0.01).toFixed(6).padStart(11, ' ')} 2  ${idHex.padEnd(15, ' ')} Rx   d ${message.dlc} ${data}`);
  }
  lines.push('End TriggerBlock');
  return { name: 'import-200k.asc', buffer: Buffer.from(lines.join('\n')) };
}

test('imports a 200k-frame ASC log with progress and no console errors', async ({ page }) => {
  test.setTimeout(120_000);
  const { consoleErrors, foreignRequests } = watch(page);
  const fixture = largeAsc();

  await page.goto('/');
  await page.keyboard.press('d');
  await expect(page.getByRole('navigation', { name: 'Definitions' })).toBeVisible();

  await page.locator('input[type="file"][accept=".asc,.csv,.log,.txt"]').setInputFiles(fixture);
  await expect(page.getByRole('progressbar', { name: `Importing ${fixture.name}` })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(`Loaded 200,000 frames from ${fixture.name} for replay.`)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('radio', { name: /Log replay/ })).toHaveAttribute('aria-checked', 'true');
  // The import only installs the replay timeline: the views hold the first frame, not the whole log.
  await expect(page.locator('span', { hasText: /^1 total$/ })).toBeVisible();

  expect(foreignRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('cancels a running import without leaving a partial replay', async ({ page }) => {
  test.setTimeout(60_000);
  const { consoleErrors, foreignRequests } = watch(page);
  const fixture = largeAsc();

  await page.goto('/');
  await page.keyboard.press('d');
  await page.locator('input[type="file"][accept=".asc,.csv,.log,.txt"]').setInputFiles(fixture);
  await expect(page.getByRole('progressbar', { name: `Importing ${fixture.name}` })).toBeVisible({ timeout: 15_000 });

  await page.getByRole('button', { name: 'cancel' }).click();
  await expect(page.getByText(new RegExp(`Import of ${fixture.name} cancelled after`))).toBeVisible();
  await expect(page.getByRole('progressbar', { name: `Importing ${fixture.name}` })).toHaveCount(0);

  expect(foreignRequests).toEqual([]);
  expect(consoleErrors).toEqual([]);
});
