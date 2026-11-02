import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { createChromeStub } from '../chrome-stub.js';
import {
  handleClassify, classifyForSender, getTabState, denyHost, testProvider, setBadge, clearTabStateIfUrlChanged
} from '../../src/background/core.js';
import { DEFAULT_DENY } from '../../src/lib/denylist.js';

const fixture = (name) => JSON.parse(readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8'));
// Text fixtures start with a one-line "SYNTHETIC FIXTURE" label; strip it.
const textFixture = (f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8').split('\n').slice(1).join('\n');

const words = (n, prefix = 'w') => Array.from({ length: n }, (_, i) => `${prefix}${i}`).join(' ');
const jevBody = (p) => ({
  model: 'jev-1.13.0',
  answers: { ai_authorship: { type: 'choice', choice: 'x', confidence: 1, probabilities: { ai_generated: p, human_written: 1 - p, unclear: 0 } } },
  usage: { input_tokens: 1, output_tokens: 1 },
});
const fakeFetch = (body = fixture('jev-response.json'), status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }));

const TAB = 7;
const NOW = 1_800_000_000_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

// fetch that blocks until release() is called.
function gatedFetch(p = 0.96) {
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetch = vi.fn(async () => {
    await gate;
    return new Response(JSON.stringify(jevBody(p)), { status: 200 });
  });
  return { fetch, release };
}

async function setup({ settings = { jevApiKey: 'k-1' }, fetch = fakeFetch() } = {}) {
  const chrome = createChromeStub();
  if (settings) await chrome.storage.local.set({ settings });
  return { chrome, fetch, now: () => NOW };
}

const msg = (extra = {}) => ({
  type: 'classify', kind: 'article', text: words(400), title: 'T', url: 'https://example.com/a', source: 'article', ...extra
});

describe('handleClassify', () => {
  it('too_short below 250 words', async () => {
    const deps = await setup();
    const v = await handleClassify(msg({ text: words(249) }), TAB, deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'too_short', words: 249, url: 'https://example.com/a' });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.chrome._badges.get(TAB).text).toBe('');
  });

  it('too_short for transcripts below 300 words', async () => {
    const deps = await setup();
    const v = await handleClassify(msg({ kind: 'youtube', source: 'transcript', text: words(299) }), TAB, deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'too_short' });
  });

  it('no_provider when jev has no key', async () => {
    const deps = await setup({ settings: null });
    const v = await handleClassify(msg(), TAB, deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'no_provider', provider: 'jev' });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.chrome._badges.get(TAB).text).toBe('');
  });

  it('flags a high-probability result, sets badge, saves session', async () => {
    const deps = await setup();
    const v = await handleClassify(msg(), TAB, deps);
    expect(v).toMatchObject({
      state: 'flagged', aiProbability: 0.96, effectiveThreshold: 0.9, threshold: 0.9, provider: 'jev', model: 'jev-1.13.0',
      source: 'article', asr: false, cached: false, url: 'https://example.com/a', title: 'T', words: 400,
      truncated: false, ts: NOW
    });
    expect(deps.chrome._badges.get(TAB)).toEqual({ text: 'AI', color: '#3c1f42' });
    const { [`tab:${TAB}`]: saved } = await deps.chrome.storage.session.get(`tab:${TAB}`);
    expect(saved).toMatchObject({ aiProbability: 0.96, provider: 'jev', url: 'https://example.com/a' });
    const [url, init] = deps.fetch.mock.calls[0];
    expect(url).toBe('https://api.typesafe.ai/v1/systemone');
    expect(init.headers.Authorization).toBe('Bearer k-1');
    const { rateLog } = await deps.chrome.storage.local.get('rateLog');
    expect(rateLog).toEqual([NOW]);
  });

  it('serves a second identical call from cache', async () => {
    const deps = await setup();
    await handleClassify(msg(), TAB, deps);
    const v = await handleClassify(msg(), TAB, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(v).toMatchObject({ state: 'flagged', cached: true, aiProbability: 0.96 });
    const { rateLog } = await deps.chrome.storage.local.get('rateLog');
    expect(rateLog).toHaveLength(1);
  });

  it('ignores a verdict cached under an older Jev prompt', async () => {
    const deps = await setup();
    await handleClassify(msg(), TAB, deps);
    const { cache } = await deps.chrome.storage.local.get('cache');
    const old = Object.fromEntries(Object.entries(cache).map(([k, v]) => [k.replace(/\+p\d+\|/, '|'), v]));
    expect(Object.keys(old)).not.toEqual(Object.keys(cache));
    await deps.chrome.storage.local.set({ cache: old });
    const v = await handleClassify(msg(), TAB, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(v.cached).toBe(false);
  });

  it('force bypasses the cache', async () => {
    const deps = await setup();
    await handleClassify(msg(), TAB, deps);
    const v = await handleClassify(msg({ force: true }), TAB, deps);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
    expect(v.cached).toBe(false);
  });

  it('clear result leaves badge empty', async () => {
    const deps = await setup({ fetch: fakeFetch(jevBody(0.2)) });
    const v = await handleClassify(msg(), TAB, deps);
    expect(v).toMatchObject({ state: 'clear', aiProbability: 0.2 });
    expect(deps.chrome._badges.get(TAB).text).toBe('');
  });

  it('provider 401 -> unknown/auth, badge ?, nothing cached', async () => {
    const deps = await setup({ fetch: fakeFetch({ error: 'no' }, 401) });
    const v = await handleClassify(msg(), TAB, deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'auth', provider: 'jev' });
    expect(v.aiProbability).toBeUndefined();
    expect(deps.chrome._badges.get(TAB)).toEqual({ text: '?', color: '#757575' });
    const { cache } = await deps.chrome.storage.local.get('cache');
    expect(cache).toBeUndefined();
  });

  it('rate limit -> unknown/rate_limit without calling fetch', async () => {
    const deps = await setup();
    await deps.chrome.storage.local.set({ rateLog: Array.from({ length: 30 }, (_, i) => NOW - 1000 * (i + 1)) });
    const v = await handleClassify(msg(), TAB, deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'rate_limit' });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(deps.chrome._badges.get(TAB).text).toBe('?');
  });

  it('ASR transcript at 0.92 is clear with effectiveThreshold 0.95', async () => {
    const deps = await setup({ fetch: fakeFetch(jevBody(0.92)) });
    const v = await handleClassify(msg({ kind: 'youtube', source: 'transcript', asr: true, text: words(320) }), TAB, deps);
    expect(v).toMatchObject({ state: 'clear', effectiveThreshold: 0.95, asr: true, source: 'transcript' });
  });

  it('heuristic provider flags AI fixture without fetch or rate limit', async () => {
    const deps = await setup({ settings: { provider: 'heuristic' } });
    const v = await handleClassify(msg({ text: textFixture('text-ai.txt') }), TAB, deps);
    expect(v).toMatchObject({ state: 'flagged', provider: 'heuristic', model: 'heuristic-v1', effectiveThreshold: 0.95 });
    expect(deps.fetch).not.toHaveBeenCalled();
    const { rateLog } = await deps.chrome.storage.local.get('rateLog');
    expect(rateLog).toBeUndefined();
  });

  it('heuristic does not flag the human fixture', async () => {
    const deps = await setup({ settings: { provider: 'heuristic' } });
    const v = await handleClassify(msg({ text: textFixture('text-human.txt') }), TAB, deps);
    expect(v.state).toBe('clear');
  });

  it('truncates input to 2500 words', async () => {
    const deps = await setup();
    const v = await handleClassify(msg({ text: words(3000) }), TAB, deps);
    const body = JSON.parse(deps.fetch.mock.calls[0][1].body);
    expect(body.state.split(' ')).toHaveLength(2500);
    expect(v).toMatchObject({ truncated: true, words: 3000 });
  });

  it('dedupes identical concurrent requests for the same tab', async () => {
    const deps = await setup();
    const [a, b] = await Promise.all([handleClassify(msg(), TAB, deps), handleClassify(msg(), TAB, deps)]);
    expect(deps.fetch).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
  });

  it('a superseded request does not overwrite the newer tab state', async () => {
    const deps = await setup();
    let release;
    const gate = new Promise((r) => { release = r; });
    deps.fetch = vi.fn(async (_u, init) => {
      const input = JSON.parse(init.body).state;
      if (input.startsWith('old')) await gate;
      return new Response(JSON.stringify(jevBody(input.startsWith('old') ? 0.99 : 0.1)), { status: 200 });
    });
    const p1 = handleClassify(msg({ text: words(400, 'old') }), TAB, deps);
    await new Promise((r) => setTimeout(r, 10));
    const v2 = await handleClassify(msg({ text: words(400, 'new') }), TAB, deps);
    release();
    const v1 = await p1;
    expect(v1.state).toBe('flagged');
    expect(v2.state).toBe('clear');
    expect((await getTabState(TAB, deps)).state).toBe('clear');
    expect(deps.chrome._badges.get(TAB).text).toBe('');
  });

  it('writes a pending view while the provider call is in flight', async () => {
    const { fetch, release } = gatedFetch();
    let now = NOW;
    const deps = { ...(await setup({ fetch })), now: () => now };
    await deps.chrome.action.setBadgeText({ tabId: TAB, text: 'AI' });
    const p = handleClassify(msg({ text: words(3000) }), TAB, deps);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(await getTabState(TAB, deps)).toMatchObject({ state: 'pending', words: 3000, truncated: true, ts: NOW, url: 'https://example.com/a' });
    expect(deps.chrome._badges.get(TAB).text).toBe('');
    now = NOW + 60_001;
    expect(await getTabState(TAB, deps)).toBeNull();
    release();
    expect((await p).state).toBe('flagged');
  });

  it('does not write pending on a cache hit', async () => {
    const deps = await setup();
    await handleClassify(msg(), TAB, deps);
    const writes = [];
    const orig = deps.chrome.storage.session.set;
    deps.chrome.storage.session.set = async (o) => { writes.push(Object.values(o)[0].state); return orig(o); };
    await handleClassify(msg(), TAB, deps);
    expect(writes).toEqual(['flagged']);
  });

  it('invalid stored endpoint -> unknown/bad_response without sending the key', async () => {
    const deps = await setup({ settings: { jevApiKey: 'k-1', jevEndpoint: 'http://evil.example/x' } });
    const v = await handleClassify(msg(), TAB, deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'bad_response' });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect((await deps.chrome.storage.local.get('rateLog')).rateLog).toBeUndefined();
  });

  it('ignores cache write failures', async () => {
    const deps = await setup();
    const orig = deps.chrome.storage.local.set;
    deps.chrome.storage.local.set = async (o) => { if ('cache' in o) throw new Error('QUOTA_BYTES'); return orig(o); };
    const v = await handleClassify(msg(), TAB, deps);
    expect(v).toMatchObject({ state: 'flagged', aiProbability: 0.96 });
  });

  it('rejects malformed messages', async () => {
    const deps = await setup();
    await expect(handleClassify({ type: 'classify', text: 42 }, TAB, deps)).rejects.toThrow();
  });

  it('unknown views carry the configured threshold', async () => {
    const deps = await setup({ settings: { jevApiKey: 'k-1', threshold: 0.93 } });
    expect(await handleClassify(msg({ text: words(10) }), TAB, deps)).toMatchObject({ state: 'unknown', reason: 'too_short', threshold: 0.93 });
    const noKey = await setup({ settings: { threshold: 0.8 } });
    expect(await handleClassify(msg(), TAB, noKey)).toMatchObject({ state: 'unknown', reason: 'no_provider', threshold: 0.8 });
    const authDeps = await setup({ settings: { jevApiKey: 'k-1', threshold: 0.91 }, fetch: fakeFetch({}, 401) });
    expect(await handleClassify(msg(), TAB, authDeps)).toMatchObject({ state: 'unknown', reason: 'auth', threshold: 0.91 });
  });
});

describe('classifyForSender', () => {
  const sender = (url, extra = {}) => ({ tab: { id: TAB, url }, frameId: 0, url, ...extra });

  it('denied tab host -> unknown/denied, no provider call, no state or badge write', async () => {
    const deps = await setup({ settings: { jevApiKey: 'k-1', denyList: ['example.com'] } });
    const v = await classifyForSender(msg({ url: 'https://example.com/a' }), sender('https://sub.example.com/a'), deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'denied', threshold: 0.9 });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(await deps.chrome.storage.session.get(`tab:${TAB}`)).toEqual({});
    expect(deps.chrome._badges.get(TAB)).toBeUndefined();
    expect((await deps.chrome.storage.local.get('rateLog')).rateLog).toBeUndefined();
  });

  it('denies when only the tab URL host is denied', async () => {
    const deps = await setup({ settings: { jevApiKey: 'k-1', denyList: ['private.example'] } });
    const v = await classifyForSender(msg({ url: 'https://public.example/a' }), sender('https://private.example/a'), deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'denied' });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('denies when only the message URL host is denied', async () => {
    const deps = await setup({ settings: { jevApiKey: 'k-1', denyList: ['private.example'] } });
    const v = await classifyForSender(msg({ url: 'https://private.example/a' }), sender('https://public.example/a'), deps);
    expect(v).toMatchObject({ state: 'unknown', reason: 'denied' });
    expect(deps.fetch).not.toHaveBeenCalled();
    expect(await deps.chrome.storage.session.get(`tab:${TAB}`)).toEqual({});
  });

  it('uses msg.url as the view URL when it is http(s)', async () => {
    const deps = await setup();
    const v = await classifyForSender(msg({ url: 'https://example.com/from-msg' }), sender('https://example.com/from-tab'), deps);
    expect(v).toMatchObject({ state: 'flagged', url: 'https://example.com/from-msg' });
    expect((await getTabState(TAB, deps)).url).toBe('https://example.com/from-msg');
  });

  it('falls back to the tab URL when msg.url is not http(s)', async () => {
    const deps = await setup();
    const v = await classifyForSender(msg({ url: 'about:blank' }), sender('https://example.com/from-tab'), deps);
    expect(v).toMatchObject({ state: 'flagged', url: 'https://example.com/from-tab' });
  });

  it('works without a tab URL (msg.url only)', async () => {
    const deps = await setup();
    expect(await classifyForSender(msg(), { tab: { id: TAB }, frameId: 0 }, deps)).toMatchObject({ state: 'flagged', url: 'https://example.com/a' });
    expect((await classifyForSender(msg(), sender('chrome://newtab/'), deps)).url).toBe('https://example.com/a');
    const denyDeps = await setup({ settings: { jevApiKey: 'k-1', denyList: ['example.com'] } });
    expect(await classifyForSender(msg(), { tab: { id: TAB }, frameId: 0 }, denyDeps)).toMatchObject({ state: 'unknown', reason: 'denied' });
    expect(denyDeps.fetch).not.toHaveBeenCalled();
  });

  it('rejects when neither URL is http(s)', async () => {
    const deps = await setup();
    await expect(classifyForSender(msg({ url: 'file:///x' }), { tab: { id: TAB }, frameId: 0 }, deps)).rejects.toThrow(/url/);
    await expect(classifyForSender(msg({ url: 'file:///x' }), sender('chrome://newtab/'), deps)).rejects.toThrow(/url/);
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe('getTabState', () => {
  it('returns null when nothing stored', async () => {
    const deps = await setup();
    expect(await getTabState(TAB, deps)).toBeNull();
  });

  it('recomputes verdict against current settings', async () => {
    const deps = await setup({ fetch: fakeFetch(jevBody(0.96)) });
    expect((await handleClassify(msg(), TAB, deps)).state).toBe('flagged');
    await deps.chrome.storage.local.set({ settings: { jevApiKey: 'k-1', threshold: 0.97 } });
    const v = await getTabState(TAB, deps);
    expect(v).toMatchObject({ state: 'clear', aiProbability: 0.96, effectiveThreshold: 0.97, threshold: 0.97 });
  });

  it('keeps unknown states as stored', async () => {
    const deps = await setup({ settings: null });
    await handleClassify(msg(), TAB, deps);
    expect(await getTabState(TAB, deps)).toMatchObject({ state: 'unknown', reason: 'no_provider' });
  });
});

describe('clearTabStateIfUrlChanged', () => {
  it('clears state and badge when the URL changes', async () => {
    const deps = await setup();
    await handleClassify(msg(), TAB, deps);
    expect(await clearTabStateIfUrlChanged(TAB, 'https://example.com/b', deps)).toBe(true);
    expect(await getTabState(TAB, deps)).toBeNull();
    expect(deps.chrome._badges.get(TAB).text).toBe('');
  });

  it('keeps state on a hash-only change', async () => {
    const deps = await setup();
    await handleClassify(msg(), TAB, deps);
    expect(await clearTabStateIfUrlChanged(TAB, 'https://example.com/a#comments', deps)).toBe(false);
    expect((await getTabState(TAB, deps)).state).toBe('flagged');
    expect(deps.chrome._badges.get(TAB).text).toBe('AI');
  });

  it('keeps an in-flight request for the new URL', async () => {
    const { fetch, release } = gatedFetch();
    const deps = await setup({ fetch });
    await deps.chrome.storage.session.set({ [`tab:${TAB}`]: { state: 'clear', aiProbability: 0.1, url: 'https://example.com/old', provider: 'jev' } });
    const p = handleClassify(msg({ url: 'https://example.com/new' }), TAB, deps);
    expect(await clearTabStateIfUrlChanged(TAB, 'https://example.com/new', deps)).toBe(false);
    release();
    await p;
    expect(await getTabState(TAB, deps)).toMatchObject({ state: 'flagged', url: 'https://example.com/new' });
    expect(deps.chrome._badges.get(TAB).text).toBe('AI');
  });

  it('a late old-page result after navigation does not write', async () => {
    const { fetch, release } = gatedFetch();
    const deps = await setup({ fetch });
    const p = handleClassify(msg(), TAB, deps);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    expect((await getTabState(TAB, deps)).state).toBe('pending');
    expect(await clearTabStateIfUrlChanged(TAB, 'https://example.com/b', deps)).toBe(true);
    release();
    expect((await p).state).toBe('flagged');
    expect(await getTabState(TAB, deps)).toBeNull();
    expect(deps.chrome._badges.get(TAB).text).toBe('');
  });
});

describe('denyHost', () => {
  it('appends a normalized host once', async () => {
    const deps = await setup();
    await denyHost('Example.com', deps);
    const s = await denyHost('example.com', deps);
    expect(s.denyList.filter((h) => h === 'example.com')).toHaveLength(1);
    expect(s.denyList).toEqual([...DEFAULT_DENY, 'example.com']);
    expect(s.jevApiKey).toBe('k-1');
  });

  it('rejects empty or malformed hosts', async () => {
    const deps = await setup();
    for (const h of ['  ', 'a b.com', 'x.com/path', 'https://x.com', '*.x.com']) {
      await expect(denyHost(h, deps)).rejects.toThrow();
    }
    expect((await deps.chrome.storage.local.get('settings')).settings.denyList).toBeUndefined();
  });
});

describe('testProvider', () => {
  it('classifies a sample, consumes rate limit, never caches', async () => {
    const deps = await setup();
    const r = await testProvider(deps);
    expect(r).toMatchObject({ ok: true, aiProbability: 0.96 });
    expect(r.raw).toBeDefined();
    const body = JSON.parse(deps.fetch.mock.calls[0][1].body);
    expect(body.state.split(' ').length).toBeGreaterThanOrEqual(250);
    const store = await deps.chrome.storage.local.get(['cache', 'rateLog']);
    expect(store.cache).toBeUndefined();
    expect(store.rateLog).toEqual([NOW]);
    await testProvider(deps);
    expect(deps.fetch).toHaveBeenCalledTimes(2);
  });

  it('reports provider errors', async () => {
    const deps = await setup({ fetch: fakeFetch({}, 401) });
    expect(await testProvider(deps)).toEqual({ ok: false, error: 'auth' });
  });

  it('reports an invalid endpoint without a call', async () => {
    const deps = await setup({ settings: { jevApiKey: 'k-1', jevEndpoint: 'ftp://x' } });
    expect(await testProvider(deps)).toEqual({ ok: false, error: 'bad_response' });
    expect(deps.fetch).not.toHaveBeenCalled();
  });

  it('reports missing key without a call', async () => {
    const deps = await setup({ settings: null });
    expect(await testProvider(deps)).toEqual({ ok: false, error: 'no_provider' });
    expect(deps.fetch).not.toHaveBeenCalled();
  });
});

describe('setBadge', () => {
  it('maps states to badge text', async () => {
    const chrome = createChromeStub();
    await setBadge(1, { state: 'flagged' }, chrome);
    await setBadge(2, { state: 'unknown', reason: 'network' }, chrome);
    await setBadge(3, { state: 'unknown', reason: 'too_short' }, chrome);
    await setBadge(4, { state: 'clear' }, chrome);
    await setBadge(5, { state: 'pending' }, chrome);
    expect(chrome._badges.get(1)).toEqual({ text: 'AI', color: '#3c1f42' });
    expect(chrome._badges.get(2)).toEqual({ text: '?', color: '#757575' });
    expect(chrome._badges.get(3).text).toBe('');
    expect(chrome._badges.get(4).text).toBe('');
    expect(chrome._badges.get(5).text).toBe('');
  });

  it('swallows errors for closed tabs', async () => {
    const chrome = createChromeStub();
    chrome.action.setBadgeText = async () => { throw new Error('No tab with id: 9'); };
    await expect(setBadge(9, { state: 'flagged' }, chrome)).resolves.toBeUndefined();
  });
});

describe('sw.js routing', () => {
  const EXT = { url: 'chrome-extension://stubextensionid/popup/index.html' };
  const OPTS = { url: 'chrome-extension://stubextensionid/options/index.html' };
  const content = (id, extra = {}) => ({ tab: { id }, frameId: 0, url: 'https://example.com/a', ...extra });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  async function loadSw(settings = { jevApiKey: 'k-1' }) {
    const chrome = createChromeStub();
    if (settings) await chrome.storage.local.set({ settings });
    await tick();
    const fetch = fakeFetch();
    vi.stubGlobal('chrome', chrome);
    vi.stubGlobal('fetch', fetch);
    vi.resetModules();
    await import('../../src/background/sw.js');
    return { chrome, fetch };
  }

  it('registers listeners synchronously at import', async () => {
    const { chrome } = await loadSw();
    expect(chrome._listeners.message).toHaveLength(1);
    expect(chrome._listeners.tabRemoved).toHaveLength(1);
    expect(chrome._listeners.tabUpdated).toHaveLength(1);
  });

  it('routes classify using sender tab id, then get-tab-state', async () => {
    const { chrome, fetch } = await loadSw();
    const v = await chrome._fireMessage(msg(), content(3));
    expect(v).toMatchObject({ state: 'flagged', aiProbability: 0.96 });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(chrome._badges.get(3).text).toBe('AI');
    expect(await chrome._fireMessage({ type: 'get-tab-state', tabId: 3 }, EXT)).toMatchObject({ state: 'flagged' });
  });

  it('classify is forbidden without a tab, from subframes, or from extension pages', async () => {
    const { chrome, fetch } = await loadSw();
    expect(await chrome._fireMessage(msg(), { frameId: 0, url: 'https://example.com/a' })).toEqual({ error: 'forbidden' });
    expect(await chrome._fireMessage(msg(), content(3, { frameId: 2 }))).toEqual({ error: 'forbidden' });
    expect(await chrome._fireMessage(msg(), { ...EXT, tab: { id: 3 }, frameId: 0 })).toEqual({ error: 'forbidden' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('extension-only messages are forbidden from content scripts', async () => {
    const { chrome } = await loadSw();
    for (const m of [
      { type: 'get-tab-state', tabId: 3 }, { type: 'check-tab', tabId: 3 }, { type: 'deny-host', host: 'x.com' },
      { type: 'test-provider' }, { type: 'get-settings' }, { type: 'save-settings', patch: { threshold: 0.5 } }
    ]) {
      expect(await chrome._fireMessage(m, content(3))).toEqual({ error: 'forbidden' });
      expect(await chrome._fireMessage(m, {})).toEqual({ error: 'forbidden' });
    }
    expect(chrome._tabMessages).toEqual([]);
    expect((await chrome.storage.local.get('settings')).settings.threshold).toBeUndefined();
  });

  it('get-content-config returns only mode and denyList to content scripts', async () => {
    const { chrome } = await loadSw({ jevApiKey: 'k-secret', jevEndpoint: 'https://jev.example/v1', mode: 'manual' });
    const r = await chrome._fireMessage({ type: 'get-content-config' }, content(3));
    expect(r).toEqual({ mode: 'manual', denyList: DEFAULT_DENY });
    expect(Object.keys(r).sort()).toEqual(['denyList', 'mode']);
    expect(JSON.stringify(r)).not.toMatch(/k-secret|jev\.example|jevApiKey|jevEndpoint/);
  });

  it('get-content-config is forbidden from subframes, tabless and extension senders', async () => {
    const { chrome } = await loadSw();
    expect(await chrome._fireMessage({ type: 'get-content-config' }, content(3, { frameId: 1 }))).toEqual({ error: 'forbidden' });
    expect(await chrome._fireMessage({ type: 'get-content-config' }, { frameId: 0, url: 'https://example.com/a' })).toEqual({ error: 'forbidden' });
    expect(await chrome._fireMessage({ type: 'get-content-config' }, EXT)).toEqual({ error: 'forbidden' });
  });

  it('rejects non-integer tab ids', async () => {
    const { chrome } = await loadSw();
    expect(await chrome._fireMessage({ type: 'get-tab-state', tabId: '3' }, EXT)).toEqual({ error: expect.any(String) });
    expect(await chrome._fireMessage({ type: 'check-tab', tabId: 1.5 }, EXT)).toEqual({ error: expect.any(String) });
    expect(chrome._tabMessages).toEqual([]);
  });

  it('check-tab forwards run-check to the top frame', async () => {
    const { chrome } = await loadSw();
    expect(await chrome._fireMessage({ type: 'check-tab', tabId: 5, force: 1 }, EXT)).toEqual({ ok: true, skipped: null });
    expect(chrome._tabMessages).toEqual([{ tabId: 5, msg: { type: 'run-check', force: true }, options: { frameId: 0 } }]);
  });

  it('check-tab relays the content script skipped reason', async () => {
    const { chrome } = await loadSw();
    chrome._tabReply = { ok: true, skipped: 'not_article' };
    expect(await chrome._fireMessage({ type: 'check-tab', tabId: 5 }, EXT)).toEqual({ ok: true, skipped: 'not_article' });
  });

  it('deny-host, get-settings, save-settings', async () => {
    const { chrome } = await loadSw();
    const s = await chrome._fireMessage({ type: 'deny-host', host: 'Foo.com' }, EXT);
    expect(s).toEqual({ ok: true });
    expect((await chrome._fireMessage({ type: 'get-settings' }, OPTS)).denyList).toContain('foo.com');
    const ok = await chrome._fireMessage({ type: 'save-settings', patch: { threshold: 0.95 } }, OPTS);
    expect(ok).toMatchObject({ ok: true, settings: { threshold: 0.95 } });
    const bad = await chrome._fireMessage({ type: 'save-settings', patch: { threshold: 1.2 } }, OPTS);
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/Threshold/) });
  });

  it('test-provider', async () => {
    const { chrome } = await loadSw();
    expect(await chrome._fireMessage({ type: 'test-provider' }, OPTS)).toMatchObject({ ok: true, aiProbability: 0.96 });
  });

  it('get-settings, save-settings and test-provider are options-page only', async () => {
    const { chrome, fetch } = await loadSw();
    for (const sender of [
      EXT,
      { url: 'chrome-extension://stubextensionid/options/other.html' },
      { url: 'chrome-extension://stubextensionid/options/index.html.bak' },
      { url: 'chrome-extension://stubextensionid/options/index.htmlx?y=1' },
      { url: 'chrome-extension://otherid/options/index.html' }
    ]) {
      for (const m of [{ type: 'get-settings' }, { type: 'save-settings', patch: { threshold: 0.5 } }, { type: 'test-provider' }]) {
        expect(await chrome._fireMessage(m, sender)).toEqual({ error: 'forbidden' });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
    expect((await chrome.storage.local.get('settings')).settings.threshold).toBeUndefined();
    for (const url of [
      'chrome-extension://stubextensionid/options/index.html',
      'chrome-extension://stubextensionid/options/index.html?x=1',
      'chrome-extension://stubextensionid/options/index.html#y'
    ]) {
      expect((await chrome._fireMessage({ type: 'get-settings' }, { url })).provider).toBe('jev');
    }
  });

  it('classify from a deny-listed tab returns unknown/denied without a provider call or state', async () => {
    const { chrome, fetch } = await loadSw({ jevApiKey: 'k-1', denyList: ['example.com'] });
    const v = await chrome._fireMessage(msg(), content(3, { tab: { id: 3, url: 'https://www.example.com/a' } }));
    expect(v).toMatchObject({ state: 'unknown', reason: 'denied' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await chrome.storage.session.get('tab:3')).toEqual({});
  });

  it('classify stores msg.url as the view URL', async () => {
    const { chrome } = await loadSw();
    const v = await chrome._fireMessage(msg(), content(3, { tab: { id: 3, url: 'https://example.com/tab' } }));
    expect(v).toMatchObject({ state: 'flagged', url: 'https://example.com/a' });
  });

  it('classify is denied when the message URL host is denied even if the tab host is not', async () => {
    const { chrome, fetch } = await loadSw({ jevApiKey: 'k-1', denyList: ['example.com'] });
    const v = await chrome._fireMessage(msg(), content(3, { tab: { id: 3, url: 'https://other.test/a' } }));
    expect(v).toMatchObject({ state: 'unknown', reason: 'denied' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('deny-host with tabId clears that tab state and badge', async () => {
    const { chrome } = await loadSw();
    await chrome._fireMessage(msg(), content(4));
    expect(chrome._badges.get(4).text).toBe('AI');
    expect(await chrome._fireMessage({ type: 'deny-host', host: 'example.com', tabId: 4 }, EXT)).toEqual({ ok: true });
    expect(await chrome.storage.session.get('tab:4')).toEqual({});
    expect(chrome._badges.get(4).text).toBe('');
    expect((await chrome._fireMessage({ type: 'get-tab-state', tabId: 4 }, EXT))).toBeNull();
  });

  it('deny-host rejects a non-integer tabId without saving', async () => {
    const { chrome } = await loadSw();
    await chrome._fireMessage(msg(), content(4));
    expect(await chrome._fireMessage({ type: 'deny-host', host: 'example.com', tabId: '4' }, EXT)).toEqual({ error: expect.any(String) });
    expect((await chrome.storage.local.get('settings')).settings.denyList).toBeUndefined();
    expect(chrome._badges.get(4).text).toBe('AI');
  });

  it('deny-host failure leaves the tab state alone', async () => {
    const { chrome } = await loadSw();
    await chrome._fireMessage(msg(), content(4));
    expect(await chrome._fireMessage({ type: 'deny-host', host: 'bad host', tabId: 4 }, EXT)).toEqual({ error: expect.any(String) });
    expect(chrome._badges.get(4).text).toBe('AI');
  });

  it('unknown message types return an error', async () => {
    const { chrome } = await loadSw();
    expect(await chrome._fireMessage({ type: 'nope' }, EXT)).toEqual({ error: expect.stringMatching(/nope/) });
  });

  it('tab removal clears session state', async () => {
    const { chrome } = await loadSw();
    await chrome._fireMessage(msg(), content(4));
    chrome._fireTabRemoved(4);
    await tick();
    expect(await chrome.storage.session.get('tab:4')).toEqual({});
  });

  it('navigation clears state and badge; hash change does not', async () => {
    const { chrome } = await loadSw();
    await chrome._fireMessage(msg(), content(4));
    chrome._fireTabUpdated(4, { url: 'https://example.com/a#x' });
    await tick();
    expect(chrome._badges.get(4).text).toBe('AI');
    chrome._fireTabUpdated(4, { status: 'loading' });
    chrome._fireTabUpdated(4, { url: 'https://example.com/other' });
    await tick();
    expect(await chrome.storage.session.get('tab:4')).toEqual({});
    expect(chrome._badges.get(4).text).toBe('');
  });

  it('threshold change recomputes badges', async () => {
    const { chrome } = await loadSw();
    await chrome._fireMessage(msg(), content(4));
    expect(chrome._badges.get(4).text).toBe('AI');
    await chrome._fireMessage({ type: 'save-settings', patch: { threshold: 0.97 } }, OPTS);
    await tick();
    await tick();
    expect(chrome._badges.get(4).text).toBe('');
    await chrome._fireMessage({ type: 'save-settings', patch: { threshold: 0.9 } }, OPTS);
    await tick();
    await tick();
    expect(chrome._badges.get(4).text).toBe('AI');
  });
});
