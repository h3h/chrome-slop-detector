// Renders the Chrome Web Store images into store/ from the built extension (run `npm run build`
// first): three 1280x800 screenshots and the 440x280 small promo tile. The demo article uses the
// synthetic AI fixture text and a mock Jev endpoint, so no API key or network is needed.
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '../src/lib/settings.js';
import { launch, startServer, seedSettings, tabIdFor, BANNER } from '../test/e2e/helpers.js';

const ROOT = new URL('..', import.meta.url).pathname;
const OUT = join(ROOT, 'store');
const SIZE = { width: 1280, height: 800 };
const PLUM = '#7d3f8a';
const DEMO_URL = 'https://blog.example.com/posts/adaptability';

const paragraphs = (await readFile(join(ROOT, 'test/fixtures/text-ai.txt'), 'utf8'))
  .split('\n').slice(1).filter((l) => l.trim());

const demoArticle = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>Why Adaptability Is the New Competitive Advantage</title>
<style>
  body { margin: 0; font: 19px/1.65 Georgia, serif; color: #222; background: #fbfaf8; }
  header { padding: 18px 48px; border-bottom: 1px solid #e6e2dc; font: 600 17px system-ui, sans-serif; letter-spacing: .02em; }
  article { max-width: 720px; margin: 40px auto; padding: 0 24px; }
  h1 { font: 700 42px/1.15 system-ui, sans-serif; margin: 0 0 12px; }
  .byline { font: 15px system-ui, sans-serif; color: #777; margin-bottom: 28px; }
</style></head><body>
<header>The Growth Ledger</header>
<article>
  <h1>Why Adaptability Is the New Competitive Advantage</h1>
  <p class="byline">By Jordan Avery · 6 min read</p>
  ${paragraphs.map((p) => `<p>${p}</p>`).join('\n  ')}
</article></body></html>`;

// A 1280x800 canvas with a caption on the left and a screenshot on the right.
function framed(title, subtitle, png) {
  return `<!doctype html><html><head><style>
    body { margin: 0; width: 1280px; height: 800px; display: flex; align-items: center; gap: 56px;
      padding: 0 72px; box-sizing: border-box; background: linear-gradient(135deg, #f4eaf6, #e4d2e8);
      font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
    .text { flex: 0 0 380px; }
    h1 { font-size: 44px; line-height: 1.1; margin: 0 0 18px; color: #3c1f42; }
    p { font-size: 21px; line-height: 1.45; margin: 0; color: #562a5c; }
    img { max-height: 680px; max-width: 700px; border-radius: 12px; box-shadow: 0 18px 50px rgba(60,31,66,.28); background: #fff; }
  </style></head><body>
    <div class="text"><h1>${title}</h1><p>${subtitle}</p></div>
    <img src="data:image/png;base64,${png.toString('base64')}">
  </body></html>`;
}

async function renderHtml(context, html, size, path) {
  const page = await context.newPage();
  await page.setViewportSize(size);
  await page.setContent(html, { waitUntil: 'load' });
  await page.screenshot({ path });
  await page.close();
}

await mkdir(OUT, { recursive: true });
const srv = await startServer();
const { context, sw, extensionId } = await launch();
try {
  await context.route(DEMO_URL, (route) => route.fulfill({ contentType: 'text/html', body: demoArticle }));
  await seedSettings(sw, srv.origin);
  srv.setProbability(0.96);

  // 1. Flagged article with the banner.
  const page = await context.newPage();
  await page.setViewportSize(SIZE);
  await page.goto(DEMO_URL);
  await page.locator(`${BANNER}[data-state="flagged"]`).waitFor({ timeout: 15000 });
  await page.screenshot({ path: join(OUT, 'screenshot-article.png') });

  // 2. The popup for that tab, framed with a caption.
  const tabId = await tabIdFor(sw, DEMO_URL);
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 700, height: 1300 });
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html?tabId=${tabId}`);
  await popup.locator('#state').filter({ hasText: 'Flagged' }).waitFor();
  // Zoomed 2x so the 320px popup is legible at screenshot scale.
  await popup.evaluate(() => { document.body.style.zoom = '2'; });
  const popupPng = await popup.locator('body').screenshot();
  await renderHtml(context, framed('Every score, one click away', 'The popup shows the AI-writing score for the page you are on, and checks pages on demand in manual mode.', popupPng),
    SIZE, join(OUT, 'screenshot-popup.png'));

  // 3. Options, with the real default endpoint rather than the mock.
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }),
    { ...structuredClone(DEFAULT_SETTINGS), jevApiKey: 'ts-demo-key-0000000000' });
  const options = await context.newPage();
  await options.setViewportSize({ width: 760, height: 1100 });
  await options.goto(`chrome-extension://${extensionId}/options/index.html`);
  await options.locator('#jevModel').waitFor();
  const optionsPng = await options.screenshot({ clip: { x: 0, y: 0, width: 760, height: 1000 } });
  await renderHtml(context, framed('You set the bar', 'Pick the provider, raise the threshold, switch to manual checks, and keep any site off limits.', optionsPng),
    SIZE, join(OUT, 'screenshot-options.png'));

  // 4. Small promo tile.
  const icon = await readFile(join(ROOT, 'src/icons/icon128.png'));
  await renderHtml(context, `<!doctype html><html><head><style>
      body { margin: 0; width: 440px; height: 280px; display: flex; flex-direction: column; justify-content: center;
        align-items: center; gap: 10px; background: linear-gradient(135deg, ${PLUM}, #3c1f42); color: #fff;
        font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
      img { width: 96px; height: 96px; filter: drop-shadow(0 6px 14px rgba(0,0,0,.3)); }
      h1 { margin: 0; font-size: 40px; letter-spacing: .01em; }
      p { margin: 0; font-size: 17px; color: #ead8ee; }
    </style></head><body>
      <img src="data:image/png;base64,${icon.toString('base64')}">
      <h1>Slop Flag</h1><p>Spot obviously AI-written pages</p>
    </body></html>`, { width: 440, height: 280 }, join(OUT, 'promo-small.png'));
} finally {
  await context.close();
  await srv.close();
}
console.log(`Wrote store images to ${OUT}`);
