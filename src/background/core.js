// Background core: classification pipeline, tab state, badge. `chrome` and `fetch` are
// injected (deps) so this module is unit-testable and touches no globals at import time.
import { countWords, truncateWords } from '../lib/text.js';
import { sha256Hex } from '../lib/hash.js';
import { verdict, MIN_WORDS, MIN_WORDS_TRANSCRIPT, MAX_WORDS } from '../lib/policy.js';
import { loadSettings, saveSettings, validateEndpoint } from '../lib/settings.js';
import { cacheKey, cacheGet, cachePut } from '../lib/cache.js';
import { tryConsume } from '../lib/ratelimit.js';
import { isDenied } from '../lib/denylist.js';
import { getProvider } from '../providers/index.js';
import { ProviderError } from '../providers/errors.js';
import { PROMPT_VERSION as JEV_PROMPT_VERSION } from '../providers/jev.js';

export const HEURISTIC_MODEL = 'heuristic-v1';
export const HEURISTIC_MIN_THRESHOLD = 0.95;
const BADGE_QUIET_REASONS = ['too_short', 'no_provider'];
export const PENDING_MAX_AGE_MS = 60 * 1000;
const HOST_RE = /^[a-z0-9.-]+$/;

// Per-tab latest request: Map<tabId, {sig, url, promise, done}>. The entry stays after
// completion (removed on tab close/navigation) so a superseded request can tell it is stale. sw.js passes its own
// top-level Map via deps.inflight; this default keeps direct callers (tests) working.
const defaultInflight = new Map();

const tabKey = (tabId) => `tab:${tabId}`;
const TAB_KEY_RE = /^tab:(\d+)$/;
const stripHash = (u) => String(u ?? '').split('#')[0];
const inflightOf = (deps) => deps.inflight || defaultInflight;
const nowOf = (deps) => (deps.now ? deps.now() : Date.now());
const modelFor = (settings) => (settings.provider === 'jev' ? settings.jevModel : HEURISTIC_MODEL);

function thresholdFor(provider, settings) {
  return provider === 'heuristic' ? Math.max(settings.threshold, HEURISTIC_MIN_THRESHOLD) : settings.threshold;
}

// Throws ProviderError('bad_response') for an endpoint that fails validation (e.g. edited in
// storage directly), so the API key is never sent to it.
function providerOptions(settings, deps) {
  if (settings.provider === 'jev') {
    if (!validateEndpoint(settings.jevEndpoint).ok) throw new ProviderError('bad_response', 'Invalid endpoint');
    return { apiKey: settings.jevApiKey, endpoint: settings.jevEndpoint, model: settings.jevModel, fetch: deps.fetch };
  }
  return { fetch: deps.fetch };
}

function hasKey(settings) {
  return typeof settings.jevApiKey === 'string' && settings.jevApiKey.trim() !== '';
}

function validateClassifyMsg(msg) {
  if (!msg || typeof msg.text !== 'string') throw new Error('Invalid classify message: text must be a string');
  if (typeof msg.url !== 'string') throw new Error('Invalid classify message: url must be a string');
}

export async function setBadge(tabId, view, chrome) {
  let text = '';
  let color = null;
  if (view?.state === 'flagged') {
    text = 'AI';
    color = '#3c1f42';
  } else if (view?.state === 'unknown' && !BADGE_QUIET_REASONS.includes(view.reason)) {
    text = '?';
    color = '#757575';
  }
  try {
    await chrome.action.setBadgeText({ tabId, text });
    if (color) await chrome.action.setBadgeBackgroundColor({ tabId, color });
  } catch {
    // Tab closed or navigated away; badge is cosmetic.
  }
}

async function runClassify(msg, deps, onPending) {
  const { chrome } = deps;
  const settings = await loadSettings(chrome.storage.local);
  const source = msg.source || (msg.kind === 'youtube' ? 'description' : 'article');
  const asr = !!msg.asr;
  const provider = settings.provider;
  const base = {
    provider,
    model: modelFor(settings),
    source,
    asr,
    url: msg.url,
    title: typeof msg.title === 'string' ? msg.title : undefined,
  };
  const unknown = (reason, extra = {}) => ({
    ...base, ...extra, state: 'unknown', reason, threshold: settings.threshold, ts: nowOf(deps)
  });

  const words = countWords(msg.text);
  const minWords = source === 'transcript' ? MIN_WORDS_TRANSCRIPT : MIN_WORDS;
  if (words < minWords) return unknown('too_short', { words });

  const impl = getProvider(provider);
  if (!impl || (provider === 'jev' && !hasKey(settings))) return unknown('no_provider', { words });

  const { text: sent, truncated } = truncateWords(msg.text, MAX_WORDS);
  const keyModel = provider === 'jev' ? `${base.model}+p${JEV_PROMPT_VERSION}` : base.model;
  const key = cacheKey({ provider, model: keyModel, textHash: await sha256Hex(sent) });

  let aiProbability;
  let cached = false;
  const hit = msg.force ? null : await cacheGet(chrome.storage.local, key, nowOf(deps));
  if (hit && typeof hit.aiProbability === 'number') {
    aiProbability = hit.aiProbability;
    cached = true;
  } else {
    let opts;
    try {
      opts = providerOptions(settings, deps);
    } catch (e) {
      if (e instanceof ProviderError) return unknown(e.code, { words, truncated });
      throw e;
    }
    await onPending({ ...base, state: 'pending', words, truncated, ts: nowOf(deps) });
    if (provider === 'jev' && !(await tryConsume(chrome.storage.local, nowOf(deps)))) {
      return unknown('rate_limit', { words, truncated });
    }
    let result;
    try {
      result = await impl.classify({ text: sent, kind: msg.kind, url: msg.url, title: msg.title }, opts);
    } catch (e) {
      if (e instanceof ProviderError) return unknown(e.code, { words, truncated });
      throw e;
    }
    aiProbability = result.aiProbability;
    try {
      await cachePut(chrome.storage.local, key, { aiProbability, raw: result.raw, source, asr }, nowOf(deps));
    } catch {
      // Cache is an optimisation (e.g. storage quota); the result is still valid.
    }
  }

  const v = verdict({ aiProbability, asr }, { threshold: thresholdFor(provider, settings) });
  return { ...base, ...v, threshold: settings.threshold, aiProbability, cached, words, truncated, ts: nowOf(deps) };
}

export function handleClassify(msg, tabId, deps) {
  try {
    validateClassifyMsg(msg);
  } catch (e) {
    return Promise.reject(e);
  }
  const inflight = inflightOf(deps);
  // Synchronous signature so the check-and-set below cannot interleave with another call.
  const sig = JSON.stringify([msg.kind, msg.source, !!msg.asr, !!msg.force, msg.url, msg.title, msg.text]);
  const current = inflight.get(tabId);
  if (current && !current.done && current.sig === sig) return current.promise;

  const entry = { sig, url: msg.url, promise: null, done: false };
  // Only the tab's current request may write its state/badge; a superseded (or navigated-away)
  // request still returns its view to its own caller.
  const write = async (view) => {
    if (tabId == null || inflight.get(tabId) !== entry) return;
    await deps.chrome.storage.session.set({ [tabKey(tabId)]: view });
    await setBadge(tabId, view, deps.chrome);
  };
  entry.promise = (async () => {
    try {
      const view = await runClassify(msg, deps, write);
      await write(view);
      return view;
    } finally {
      entry.done = true;
      entry.sig = null;
    }
  })();
  inflight.set(tabId, entry);
  return entry.promise;
}

function httpUrl(u) {
  if (typeof u !== 'string') return null;
  try {
    const parsed = new URL(u);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

// The page URL stored with a classify result: the message's URL (what the content script
// extracted from) when it is http(s), else the sender tab's URL. The popup compares it with
// the tab URL to drop stale views.
export function viewUrlFor(msg, sender) {
  return httpUrl(msg?.url) ? msg.url : sender?.tab?.url;
}

// SW entry point for content-script classify requests. Re-checks the deny list so a stale
// content script (deny list changed after its config was read) never sends text for a denied
// site. Denied if EITHER the tab's host (set by Chrome) or the message URL's host is denied.
// Denied requests touch neither the provider nor tab state.
export async function classifyForSender(msg, sender, deps) {
  validateClassifyMsg(msg);
  const url = viewUrlFor(msg, sender);
  if (!httpUrl(url)) throw new Error('Invalid classify message: url must be http(s)');
  const hosts = [httpUrl(sender?.tab?.url), httpUrl(msg.url)].filter(Boolean).map((u) => u.hostname);
  const settings = await loadSettings(deps.chrome.storage.local);
  if (hosts.some((h) => isDenied(h, settings.denyList || []))) {
    return {
      state: 'unknown',
      reason: 'denied',
      provider: settings.provider,
      source: msg.source || (msg.kind === 'youtube' ? 'description' : 'article'),
      threshold: settings.threshold,
      url,
      ts: nowOf(deps)
    };
  }
  return handleClassify({ ...msg, url }, Number.isInteger(sender?.tab?.id) ? sender.tab.id : null, deps);
}

export async function getTabState(tabId, deps) {
  const key = tabKey(tabId);
  const { [key]: stored } = await deps.chrome.storage.session.get(key);
  if (!stored) return null;
  if (stored.state === 'pending') {
    return nowOf(deps) - (stored.ts || 0) > PENDING_MAX_AGE_MS ? null : stored;
  }
  if ((stored.state === 'flagged' || stored.state === 'clear') && typeof stored.aiProbability === 'number') {
    const settings = await loadSettings(deps.chrome.storage.local);
    const v = verdict({ aiProbability: stored.aiProbability, asr: !!stored.asr }, { threshold: thresholdFor(stored.provider, settings) });
    return { ...stored, ...v, threshold: settings.threshold };
  }
  return stored;
}

export async function clearTabState(tabId, deps) {
  inflightOf(deps).delete(tabId);
  await deps.chrome.storage.session.remove(tabKey(tabId));
}

// Called on tabs.onUpdated with a new URL. Keeps state if the stored view or the current
// in-flight request is for this URL (ignoring #fragment); otherwise clears state and badge
// so the popup never shows the previous page's verdict.
export async function clearTabStateIfUrlChanged(tabId, url, deps) {
  const target = stripHash(url);
  const key = tabKey(tabId);
  const { [key]: stored } = await deps.chrome.storage.session.get(key);
  if (stored && stripHash(stored.url) === target) return false;
  const entry = inflightOf(deps).get(tabId);
  if (entry && stripHash(entry.url) === target) return false;
  await clearTabStateAndBadge(tabId, deps);
  return true;
}

export async function clearTabStateAndBadge(tabId, deps) {
  await clearTabState(tabId, deps);
  try {
    await deps.chrome.action.setBadgeText({ tabId, text: '' });
  } catch {
    // Tab gone.
  }
}

// Re-derive every tab's badge from stored probabilities (after a threshold change).
export async function refreshBadges(deps) {
  const all = await deps.chrome.storage.session.get(null);
  for (const k of Object.keys(all || {})) {
    const m = TAB_KEY_RE.exec(k);
    if (!m) continue;
    const tabId = Number(m[1]);
    const e = inflightOf(deps).get(tabId);
    if (e && !e.done) continue;
    await setBadge(tabId, await getTabState(tabId, deps), deps.chrome);
  }
}

export async function denyHost(host, deps) {
  const h = String(host ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!h || !HOST_RE.test(h)) throw new Error('Invalid host');
  const settings = await loadSettings(deps.chrome.storage.local);
  const list = settings.denyList || [];
  if (list.includes(h)) return settings;
  return saveSettings(deps.chrome.storage.local, { denyList: [...list, h] });
}

// Fixed, neutral sample (~300 words) used by the Options "Test" button.
export const TEST_SAMPLE = [
  'The bakery on the corner of our street opens at six, and by a quarter past there is usually a short line of',
  'people in work boots and pajama pants waiting for the first tray of rolls. The owner, a retired bus driver named',
  'Walt, started the place eight years ago after his wife told him he was spending too much time in the garage.',
  'He bakes everything himself, which means the menu changes depending on what he feels like making and how well',
  'he slept. Tuesdays are rye. Fridays are cinnamon knots, unless it rained on Thursday, in which case nobody quite',
  'knows. Last winter the oven broke for nine days and he handed out coffee for free from a borrowed urn, standing',
  'on the sidewalk in a parka and apologizing to every single customer as if the weather had been his fault too.',
  'The neighborhood association once asked him to put up a proper sign, and he painted one by hand on a piece of',
  'plywood that still leans against the window, slightly crooked, with the second letter of bakery smaller than the',
  'rest because he ran out of room. Kids from the elementary school stop in on the way home to spend loose change',
  'on day-old cookies, and he pretends not to notice when they come up a dime short. When the city repaved the road',
  'in the spring, the crew ate lunch on his steps every day for three weeks, and by the end of it the foreman knew',
  'the names of all his grandchildren. Nobody would call the place efficient. The register sticks, the hours are',
  'whatever Walt decides, and the bread sometimes comes out darker than anyone ordered. Still, on a cold morning,',
  'standing in that line with the windows fogged and the radio playing an old ball game recap, it is hard to imagine',
  'the street without it. People move away and write him letters. He keeps them in a shoebox under the counter and',
  'reads one aloud now and then, usually to whoever is buying the last loaf of the day.',
].join(' ');

export async function testProvider(deps) {
  const { chrome } = deps;
  const settings = await loadSettings(chrome.storage.local);
  const impl = getProvider(settings.provider);
  if (!impl || (settings.provider === 'jev' && !hasKey(settings))) return { ok: false, error: 'no_provider' };
  let opts;
  try {
    opts = providerOptions(settings, deps);
  } catch (e) {
    return { ok: false, error: e instanceof ProviderError ? e.code : String(e?.message || e) };
  }
  if (settings.provider === 'jev' && !(await tryConsume(chrome.storage.local, nowOf(deps)))) {
    return { ok: false, error: 'rate_limit' };
  }
  try {
    const r = await impl.classify(
      { text: TEST_SAMPLE, kind: 'article', url: 'about:blank', title: 'Slop Flag test sample' },
      opts
    );
    return { ok: true, aiProbability: r.aiProbability, raw: r.raw };
  } catch (e) {
    if (e instanceof ProviderError) return { ok: false, error: e.code };
    return { ok: false, error: String(e?.message || e) };
  }
}
