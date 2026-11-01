import { test, expect } from '@playwright/test';
import { launch, startServer, seedSettings, tabIdFor, sleep, BANNER } from './helpers.js';

let ctx;
let srv;

test.beforeEach(async () => {
  srv = await startServer();
  ctx = await launch();
});

test.afterEach(async () => {
  try {
    await ctx?.context.close();
  } finally {
    await srv?.close();
    ctx = srv = undefined;
  }
});

test('manual mode: zero calls on load, popup "Check this page" classifies', async () => {
  const { context, sw, extensionId } = ctx;
  await seedSettings(sw, srv.origin, { mode: 'manual' });
  srv.setProbability(0.97);

  const page = await context.newPage();
  await page.goto(`${srv.origin}/fixtures/article.html`);
  await sleep(2000);
  expect(srv.calls).toHaveLength(0);
  await expect(page.locator(BANNER)).toHaveCount(0);

  const tabId = await tabIdFor(sw, '/fixtures/article.html');
  expect(tabId).not.toBeNull();
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html?tabId=${tabId}`);
  await expect(popup.locator('#state')).toContainText('Not checked');
  await popup.locator('#check').click();

  await expect(page.locator(`${BANNER}[data-state="flagged"]`)).toBeVisible({ timeout: 10000 });
  expect(srv.calls).toHaveLength(1);
  await expect(popup.locator('#state')).toContainText('Flagged', { timeout: 10000 });
  await expect(popup.locator('#score')).toContainText('97%');
});

test('options page saves key and threshold to storage', async () => {
  const { context, sw, extensionId } = ctx;
  // Mock endpoint and no key: nothing on this page can reach a real provider.
  await seedSettings(sw, srv.origin, { jevApiKey: '', jevModel: 'jev-test-model' });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options/index.html`);
  // Loaded once the form is filled from the seeded settings.
  await expect(page.locator('#jevEndpoint')).toHaveValue(`${srv.origin}/jev`);
  await expect(page.locator('#jevModel')).toHaveValue('jev-test-model');
  await expect(page.locator('#jevApiKey')).toHaveValue('');

  await page.locator('#jevApiKey').fill('my-secret-key');
  await page.locator('#threshold').fill('0.8');
  await page.locator('#save').click();
  await expect(page.locator('#status')).toHaveText('Saved');

  const stored = await sw.evaluate(() => chrome.storage.local.get('settings').then((r) => r.settings));
  expect(stored.threshold).toBe(0.8);
  expect(stored.jevApiKey).toBe('my-secret-key');
  expect('noticeAcknowledged' in stored).toBe(false);
  expect(stored.jevEndpoint).toBe(`${srv.origin}/jev`);
  expect(srv.calls).toHaveLength(0);
});
