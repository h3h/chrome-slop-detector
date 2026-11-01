import { test, expect } from '@playwright/test';
import { launch, startServer, seedSettings, testSettings, tabIdFor, badge, sleep, BANNER } from './helpers.js';

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

const flaggedBanner = (page) => page.locator(`${BANNER}[data-state="flagged"]`);

test('flagged article: banner, badge, one call with the key; cache on reload; popup shows the result', async () => {
  const { context, sw, extensionId } = ctx;
  await seedSettings(sw, srv.origin);
  srv.setProbability(0.97);

  const page = await context.newPage();
  await page.goto(`${srv.origin}/fixtures/article.html`);
  const banner = flaggedBanner(page);
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toContainText('97%');
  await expect(banner).toContainText('Likely AI-written');

  expect(srv.calls).toHaveLength(1);
  expect(srv.calls[0].headers.authorization).toBe('Bearer test-key');
  expect(srv.calls[0].body.model).toBe('jev-1.13.0');
  expect(srv.calls[0].body.input).toContain('Harbor Town Reopens Its Century-Old Ferry Line');

  const tabId = await tabIdFor(sw, '/fixtures/article.html');
  expect(tabId).not.toBeNull();
  await expect.poll(() => badge(sw, tabId)).toBe('AI');

  // (2) Reload: same banner, served from the cache.
  await page.reload();
  await expect(flaggedBanner(page)).toBeVisible({ timeout: 10000 });
  await expect(flaggedBanner(page)).toContainText('97%');
  await sleep(500);
  expect(srv.calls).toHaveLength(1);

  // (3) Popup for that tab.
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html?tabId=${tabId}`);
  await expect(popup.locator('#state')).toContainText('Flagged');
  await expect(popup.locator('#score')).toContainText('97%');
  await expect(popup.locator('#source')).toContainText('cached');
});

test('low-probability article: call made, no banner, empty badge', async () => {
  const { context, sw } = ctx;
  await seedSettings(sw, srv.origin);
  srv.setProbability(0.3);

  const page = await context.newPage();
  await page.goto(`${srv.origin}/fixtures/article-human.html`);
  await expect.poll(() => srv.calls.length, { timeout: 10000 }).toBe(1);
  const tabId = await tabIdFor(sw, '/fixtures/article-human.html');
  // Wait for the SW to store the result before asserting the badge stays empty.
  await expect
    .poll(() => sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`).then((r) => r[`tab:${id}`]?.state ?? null), tabId))
    .toBe('clear');
  await sleep(300);
  await expect(page.locator(BANNER)).toHaveCount(0);
  expect(await badge(sw, tabId)).toBe('');
});

// The popup's "Check this page" reply proves the content script ran and names the gate,
// so the zero-call assertions below cannot pass just because nothing was injected.
async function popupSkipText(context, extensionId, tabId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html?tabId=${tabId}`);
  await popup.locator('#check').click();
  const state = popup.locator('#state');
  await expect(state).toContainText("This page isn't checked");
  return state.textContent();
}

test('non-article page: zero calls', async () => {
  const { context, sw, extensionId } = ctx;
  await seedSettings(sw, srv.origin);
  const page = await context.newPage();
  await page.goto(`${srv.origin}/fixtures/homepage.html`);
  await sleep(2000);
  expect(srv.calls).toHaveLength(0);
  await expect(page.locator(BANNER)).toHaveCount(0);

  const tabId = await tabIdFor(sw, '/fixtures/homepage.html');
  expect(await popupSkipText(context, extensionId, tabId)).toContain('Not an article');
  expect(srv.calls).toHaveLength(0);
});

test('deny-listed host: zero calls', async () => {
  const { context, sw, extensionId } = ctx;
  await seedSettings(sw, srv.origin, { denyList: [...testSettings(srv.origin).denyList, '127.0.0.1'] });
  const page = await context.newPage();
  await page.goto(`${srv.origin}/fixtures/article.html`);
  await sleep(2000);
  expect(srv.calls).toHaveLength(0);
  await expect(page.locator(BANNER)).toHaveCount(0);

  const tabId = await tabIdFor(sw, '/fixtures/article.html');
  expect(await popupSkipText(context, extensionId, tabId)).toContain('never-check list');
  expect(srv.calls).toHaveLength(0);
});

test('history.pushState to another path removes the banner (navigatesuccess in the isolated world)', async () => {
  const { context, sw } = ctx;
  await seedSettings(sw, srv.origin);
  srv.setProbability(0.97);
  const page = await context.newPage();
  await page.goto(`${srv.origin}/fixtures/article.html`);
  await expect(flaggedBanner(page)).toBeVisible({ timeout: 10000 });

  const tabId = await tabIdFor(sw, '/fixtures/article.html');
  await expect.poll(() => badge(sw, tabId)).toBe('AI');

  await page.evaluate(() => history.pushState({}, '', '/fixtures/some-other-article'));
  await expect(page.locator(BANNER)).toHaveCount(0, { timeout: 5000 });
  // The SW clears the previous page's badge on the URL change.
  await expect.poll(() => badge(sw, tabId)).toBe('');
  // SPA navigation drops the banner but does not re-classify: give a late call time to show up.
  await sleep(1500);
  expect(srv.calls).toHaveLength(1);
  await expect(page.locator(BANNER)).toHaveCount(0);
});
