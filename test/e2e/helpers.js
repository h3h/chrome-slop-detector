// Shared E2E helpers: launch Chromium with the built extension, serve fixtures and a mock
// Jev endpoint on 127.0.0.1, and poke at extension state through the service worker.
import { chromium } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = join(ROOT, 'dist');
const FIXTURES = join(ROOT, 'test', 'fixtures');

const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

export async function launch() {
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${DIST}`, `--load-extension=${DIST}`]
  });
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  const extensionId = new URL(sw.url()).host;
  return { context, sw, extensionId };
}

// Fixtures at /fixtures/*; POST /jev records {headers, body} and answers with probability p.
export async function startServer() {
  const calls = [];
  let p = 0.97;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/jev') {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const text = Buffer.concat(chunks).toString('utf8');
        let body;
        try {
          body = JSON.parse(text);
        } catch {
          body = { unparsed: text };
        }
        calls.push({ headers: req.headers, body });
        const human = Math.max(0, Math.round((1 - p - 0.01) * 1000) / 1000);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          selected: p >= 0.5 ? 'ai_generated' : 'human_written',
          probabilities: { ai_generated: p, human_written: human, unclear: 0.01 }
        }));
        return;
      }
      if (req.method === 'GET' && url.pathname.startsWith('/fixtures/')) {
        const file = normalize(join(FIXTURES, decodeURIComponent(url.pathname.slice('/fixtures/'.length))));
        if (!file.startsWith(FIXTURES + sep)) throw Object.assign(new Error('forbidden'), { status: 403 });
        const ext = file.slice(file.lastIndexOf('.'));
        const data = await readFile(file);
        res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream' });
        res.end(data);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (e) {
      res.writeHead(e?.status || (e?.code === 'ENOENT' ? 404 : 500), { 'Content-Type': 'text/plain' });
      res.end(String(e?.message || e));
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    calls,
    setProbability(next) {
      p = next;
    },
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    })
  };
}

// Defaults minus the loopback hosts the fixtures are served from, pointed at the mock Jev.
export function testSettings(origin, patch = {}) {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    denyList: DEFAULT_SETTINGS.denyList.filter((h) => h !== '127.0.0.1' && h !== 'localhost'),
    jevEndpoint: `${origin}/jev`,
    jevApiKey: 'test-key',
    noticeAcknowledged: true,
    ...patch
  };
}

export async function seedSettings(sw, origin, patch = {}) {
  const settings = testSettings(origin, patch);
  await sw.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);
  return settings;
}

export async function tabIdFor(sw, urlSubstring) {
  return sw.evaluate(
    (u) => chrome.tabs.query({}).then((ts) => ts.find((t) => (t.url || '').includes(u))?.id ?? null),
    urlSubstring
  );
}

export async function badge(sw, tabId) {
  return sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const BANNER = 'slop-flag-banner';
