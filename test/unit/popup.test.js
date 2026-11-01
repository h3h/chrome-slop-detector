// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://ext.invalid/popup/index.html?tabId=5"}
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const HTML = readFileSync(resolve(import.meta.dirname, '../../src/popup/index.html'), 'utf8');
const TAB_URL = 'https://news.example.com/story#top';

const flagged = (over = {}) => ({
  state: 'flagged', aiProbability: 0.96, threshold: 0.9, provider: 'jev', model: 'jev-1.13.0',
  source: 'article', asr: false, cached: true, url: 'https://news.example.com/story', ts: 100, ...over
});

function setup({ view = flagged(), tabUrl = TAB_URL, onMessage } = {}) {
  document.documentElement.innerHTML = new DOMParser().parseFromString(HTML, 'text/html').documentElement.innerHTML;
  const sent = [];
  const chrome = {
    runtime: {
      sendMessage: vi.fn(async (msg) => {
        sent.push(msg);
        if (onMessage) {
          const r = await onMessage(msg);
          if (r !== undefined) return r;
        }
        if (msg.type === 'get-tab-state') return typeof view === 'function' ? view() : view;
        return msg.type === 'check-tab' ? { ok: true, skipped: null } : { ok: true };
      }),
      openOptionsPage: vi.fn()
    },
    tabs: {
      get: vi.fn(async (id) => ({ id, url: tabUrl })),
      query: vi.fn(async () => [{ id: 9, url: tabUrl }])
    }
  };
  globalThis.chrome = chrome;
  return { chrome, sent };
}

async function load(opts) {
  const ctx = setup(opts);
  vi.resetModules();
  const mod = await import('../../src/popup/popup.js');
  await mod.ready;
  return { ...ctx, mod };
}

const text = (sel) => document.querySelector(sel).textContent;

beforeEach(() => {
  vi.useRealTimers();
});

describe('popup', () => {
  it('renders a flagged view for ?tabId=5', async () => {
    const { sent, chrome } = await load();
    expect(sent[0]).toEqual({ type: 'get-tab-state', tabId: 5 });
    expect(chrome.tabs.query).not.toHaveBeenCalled();
    expect(text('#state')).toContain('Flagged');
    expect(text('#score')).toContain('96%');
    expect(text('#score')).toContain('90%');
    expect(text('#provider')).toContain('jev');
    expect(text('#provider')).toContain('jev-1.13.0');
    expect(text('#source')).toContain('article');
    expect(text('#source')).toContain('cached');
    expect(document.querySelector('#recheck').hidden).toBe(false);
    expect(document.querySelector('#check').hidden).toBe(true);
    expect(text('#disclaimer')).toMatch(/false positives/);
  });

  it('Never check this site sends deny-host with the tab hostname and tab id, then check-tab', async () => {
    const { sent } = await load({
      onMessage: (m) => (m.type === 'check-tab' ? { ok: true, skipped: 'denied' } : undefined)
    });
    document.querySelector('#deny').click();
    await vi.waitFor(() => expect(text('#message')).toBe('news.example.com will not be checked again.'));
    const i = sent.findIndex((m) => m.type === 'deny-host');
    expect(sent[i]).toEqual({ type: 'deny-host', host: 'news.example.com', tabId: 5 });
    expect(sent.slice(i + 1)).toContainEqual({ type: 'check-tab', tabId: 5, force: false });
    await vi.waitFor(() => expect(text('#state')).toBe("This page isn't checked: This site is on your never-check list"));
    expect(text('#score')).toBe('');
    expect(document.querySelector('#recheck').hidden).toBe(true);
  });

  it('a failed deny-host does not send check-tab', async () => {
    const { sent } = await load({
      onMessage: (m) => (m.type === 'deny-host' ? { error: 'Invalid host' } : undefined)
    });
    document.querySelector('#deny').click();
    await vi.waitFor(() => expect(text('#message')).toBe('Could not add news.example.com: Invalid host'));
    expect(sent.filter((m) => m.type === 'check-tab')).toHaveLength(0);
    expect(text('#state')).toContain('Flagged');
  });

  it('Settings opens the options page', async () => {
    const { chrome } = await load();
    document.querySelector('#settings').click();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalled();
  });

  it('shows Not checked when there is no state', async () => {
    await load({ view: null });
    expect(text('#state')).toBe('Not checked');
    expect(document.querySelector('#recheck').hidden).toBe(true);
    expect(document.querySelector('#check').hidden).toBe(false);
  });

  it('treats a view for a different URL as Not checked', async () => {
    await load({ view: flagged({ url: 'https://news.example.com/other' }) });
    expect(text('#state')).toBe('Not checked');
    expect(text('#score')).toBe('');
  });

  it('renders unknown with reason text and the clear state', async () => {
    await load({ view: flagged({ state: 'unknown', reason: 'rate_limit', aiProbability: undefined }) });
    expect(text('#state')).toBe('Unknown — Hourly limit reached (30 checks)');
    await load({ view: flagged({ state: 'clear', aiProbability: 0.12, asr: true, source: 'transcript' }) });
    expect(text('#state')).toBe('Not flagged');
    expect(text('#score')).toContain('12%');
    expect(text('#source')).toContain('transcript (auto-captions)');
  });

  it('shows Checking… for a pending view and follows it without sending check-tab', async () => {
    let calls = 0;
    const { sent } = await load({
      view: () => (++calls < 3 ? flagged({ state: 'pending', aiProbability: undefined, ts: 50 }) : flagged({ ts: 51 }))
    });
    expect(text('#state')).toBe('Checking…');
    expect(document.querySelector('#recheck').disabled).toBe(true);
    await vi.waitFor(() => expect(text('#state')).toContain('Flagged'), { timeout: 3000 });
    expect(sent.some((m) => m.type === 'check-tab')).toBe(false);
    expect(document.querySelector('#recheck').disabled).toBe(false);
  });

  it('Re-check never accepts an unchanged ts; waits for the new result', async () => {
    let ts = 100;
    const { sent } = await load({ view: () => flagged({ ts }) });
    vi.useFakeTimers();
    document.querySelector('#recheck').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ type: 'check-tab', tabId: 5, force: true });
    await vi.advanceTimersByTimeAsync(2000);
    expect(text('#state')).toBe('Checking…'); // same finished view for 2 s: still waiting
    expect(document.querySelector('#recheck').disabled).toBe(true);
    ts = 300;
    await vi.advanceTimersByTimeAsync(500);
    expect(text('#state')).toContain('Flagged');
    expect(document.querySelector('#recheck').disabled).toBe(false);
  });

  it('a plain check accepts an unchanged existing view from the 2nd poll', async () => {
    const { sent } = await load(); // always the same flagged view, ts 100
    vi.useFakeTimers();
    document.querySelector('#check').click(); // hidden in the UI here; exercises the fallback
    await vi.advanceTimersByTimeAsync(500);
    expect(text('#state')).toBe('Checking…');
    await vi.advanceTimersByTimeAsync(500);
    expect(text('#state')).toContain('Flagged');
    await vi.advanceTimersByTimeAsync(5000);
    expect(sent.filter((m) => m.type === 'get-tab-state')).toHaveLength(3); // initial + 2 polls
  });

  it('never displays an API key', async () => {
    await load({ view: flagged({ jevApiKey: 'sk-secret', raw: { key: 'sk-secret' } }) });
    expect(document.body.textContent).not.toContain('sk-secret');
  });

  it('Check this page sends check-tab and polls until ts changes', async () => {
    let ts = 100;
    const { sent } = await load({ view: () => (ts === 100 ? null : flagged({ ts })) });
    vi.useFakeTimers();
    document.querySelector('#check').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ type: 'check-tab', tabId: 5, force: false });
    expect(text('#state')).toBe('Checking…');
    await vi.advanceTimersByTimeAsync(1000);
    expect(text('#state')).toBe('Checking…');
    ts = 200;
    await vi.advanceTimersByTimeAsync(600);
    expect(text('#state')).toContain('Flagged');
  });

  it('Re-check sends force:true', async () => {
    const { sent } = await load();
    vi.useFakeTimers();
    document.querySelector('#recheck').click();
    await vi.advanceTimersByTimeAsync(0);
    expect(sent).toContainEqual({ type: 'check-tab', tabId: 5, force: true });
  });

  it('shows a skipped reason immediately instead of polling', async () => {
    const { sent } = await load({
      view: null,
      onMessage: (m) => (m.type === 'check-tab' ? { ok: true, skipped: 'not_article' } : undefined)
    });
    document.querySelector('#check').click();
    await vi.waitFor(() => expect(text('#state')).toBe("This page isn't checked: Not an article or YouTube video"));
    const polls = sent.filter((m) => m.type === 'get-tab-state').length;
    expect(polls).toBe(1);
  });

  it('shows the unavailable skip reason', async () => {
    const { sent } = await load({
      view: null,
      onMessage: (m) => (m.type === 'check-tab' ? { ok: true, skipped: 'unavailable' } : undefined)
    });
    document.querySelector('#check').click();
    await vi.waitFor(() => expect(text('#state')).toBe("This page isn't checked: Couldn't reach the page — try reloading it"));
    expect(sent.filter((m) => m.type === 'get-tab-state')).toHaveLength(1);
  });

  it('shows an error from check-tab', async () => {
    await load({
      view: null,
      onMessage: (m) => (m.type === 'check-tab' ? { error: 'Could not establish connection' } : undefined)
    });
    document.querySelector('#check').click();
    await vi.waitFor(() => expect(text('#state')).toMatch(/can't be checked/i));
  });

  it('uses the active tab when no tabId param is given', async () => {
    history.replaceState({}, '', '/popup/index.html');
    try {
      const { sent, chrome } = await load({ view: null });
      expect(chrome.tabs.query).toHaveBeenCalledWith({ active: true, lastFocusedWindow: true });
      expect(sent[0]).toEqual({ type: 'get-tab-state', tabId: 9 });
    } finally {
      history.replaceState({}, '', '/popup/index.html?tabId=5');
    }
  });
});
