import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { launch, startServer, seedSettings, tabIdFor, badge, BANNER } from './helpers.js';

const WATCH_HTML = fileURLToPath(new URL('../fixtures/youtube-watch.html', import.meta.url));
const PHRASE = 'purple lighthouse keeper juggling marmalade';

// ~350 words of synthetic transcript, split into caption events; PHRASE appears once, mid-way.
function transcriptJson3() {
  const sentence = 'Today we walk through the steps of building a small wooden shelf for the hallway and talk about the tools you need';
  const words = [];
  while (words.length < 340) words.push(...sentence.split(' '));
  words.splice(170, 0, ...PHRASE.split(' '));
  const events = [];
  for (let i = 0; i < words.length; i += 8) {
    events.push({ tStartMs: i * 400, dDurationMs: 3200, segs: [{ utf8: words.slice(i, i + 8).join(' ') }] });
  }
  return { wireMagic: 'pb3', events };
}

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

test('YouTube watch page with an English transcript is classified from the transcript and flagged', async () => {
  const { context, sw } = ctx;
  await seedSettings(sw, srv.origin);
  srv.setProbability(0.97);

  const html = await readFile(WATCH_HTML, 'utf8');
  const transcriptRequests = [];
  await context.route(/^https:\/\/www\.youtube\.com\//, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/watch' && url.searchParams.get('v') === 'abc123xyz00') {
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html });
    }
    if (url.pathname === '/api/timedtext') {
      transcriptRequests.push(url.toString());
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(transcriptJson3()) });
    }
    return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  });

  const page = await context.newPage();
  await page.goto('https://www.youtube.com/watch?v=abc123xyz00');
  const banner = page.locator(`${BANNER}[data-state="flagged"]`);
  await expect(banner).toBeVisible({ timeout: 10000 });
  await expect(banner).toContainText('97%');

  expect(transcriptRequests.length).toBeGreaterThanOrEqual(1);
  expect(new URL(transcriptRequests[0]).searchParams.get('fmt')).toBe('json3');
  expect(srv.calls).toHaveLength(1);
  expect(srv.calls[0].body.state).toContain(PHRASE);
  expect(srv.calls[0].body.state.startsWith('Test video\n\nshort')).toBe(false); // not the description fallback

  const tabId = await tabIdFor(sw, 'youtube.com/watch');
  await expect.poll(() => badge(sw, tabId)).toBe('AI');
  const stored = await sw.evaluate((id) => chrome.storage.session.get(`tab:${id}`).then((r) => r[`tab:${id}`]), tabId);
  expect(stored.source).toBe('transcript');
  expect(stored.asr).toBe(false);
});
