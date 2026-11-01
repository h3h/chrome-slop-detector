// Popup: shows the stored result for one tab and offers check / re-check / deny / settings.
// Never requests settings, so it never has (or displays) the API key.

export const REASON_TEXT = {
  too_short: 'Not enough text to judge',
  no_provider: 'Add an API key in Settings',
  auth: 'API key rejected',
  rate_limit: 'Hourly limit reached (30 checks)',
  provider_rate_limit: 'Provider rate limit',
  bad_response: 'Unexpected response from provider',
  network: 'Network error',
  timeout: 'Provider timed out'
};

export const SKIP_TEXT = {
  denied: 'This site is on your never-check list',
  lang: "Page isn't in English",
  scheme: "This kind of page can't be checked",
  not_article: 'Not an article or YouTube video',
  no_text: 'No readable text found',
  unavailable: "Couldn't reach the page — try reloading it"
};

const POLL_MS = 500;
const POLL_MAX_MS = 30000;
const DONE_STATES = new Set(['flagged', 'clear', 'unknown']);

const stripHash = (u) => String(u ?? '').split('#')[0];
const pct = (p) => `${Math.round(p * 100)}%`;

function sourceText(view) {
  const s = view.source;
  let out;
  if (s === 'transcript') out = view.asr ? 'transcript (auto-captions)' : 'transcript';
  else if (s === 'description') out = 'description — transcript unavailable';
  else if (s === 'article') out = 'article';
  else out = typeof s === 'string' ? s : '';
  if (view.cached) out = out ? `${out} · cached` : 'cached';
  return out;
}

function providerText(view) {
  if (typeof view.provider !== 'string') return '';
  return typeof view.model === 'string' && view.model ? `${view.provider} · ${view.model}` : view.provider;
}

function stateText(view) {
  switch (view.state) {
    case 'flagged':
      return 'Flagged: likely AI-written';
    case 'clear':
      return 'Not flagged';
    case 'pending':
      return 'Checking…';
    case 'unknown':
      return `Unknown — ${REASON_TEXT[view.reason] || 'No result'}`;
    default:
      return 'Not checked';
  }
}

export function createPopup({ chrome, doc, win }) {
  const $ = (id) => doc.getElementById(id);
  const el = {
    state: $('state'),
    score: $('score'),
    provider: $('provider'),
    source: $('source'),
    check: $('check'),
    recheck: $('recheck'),
    deny: $('deny'),
    settings: $('settings'),
    message: $('message')
  };
  let tab = { id: null, url: null };
  let lastView = null;
  let busy = false;

  async function send(msg) {
    try {
      const res = await chrome.runtime.sendMessage(msg);
      return res === undefined ? null : res;
    } catch (e) {
      return { error: String(e?.message || e) };
    }
  }

  // A stored view for another URL (stale state the SW has not cleared yet) counts as none.
  function relevant(view) {
    if (!view || typeof view !== 'object' || 'error' in view) return null;
    if (tab.url && typeof view.url === 'string' && stripHash(view.url) !== stripHash(tab.url)) return null;
    return view;
  }

  function setMessage(text) {
    el.message.textContent = text || '';
  }

  function render(view) {
    const v = relevant(view);
    el.state.textContent = v ? stateText(v) : 'Not checked';
    el.state.dataset.state = v?.state || 'none';
    if (v && typeof v.aiProbability === 'number') {
      const t = typeof v.effectiveThreshold === 'number' ? v.effectiveThreshold : v.threshold;
      el.score.textContent = typeof t === 'number' ? `${pct(v.aiProbability)} (threshold ${pct(t)})` : pct(v.aiProbability);
    } else {
      el.score.textContent = '';
    }
    el.provider.textContent = v ? providerText(v) : '';
    el.source.textContent = v ? sourceText(v) : '';
    el.recheck.hidden = !(v && DONE_STATES.has(v.state));
    // One check button at a time: "Re-check" replaces "Check this page" once a result exists.
    el.check.hidden = !el.recheck.hidden;
  }

  function setBusy(b) {
    busy = b;
    el.check.disabled = b;
    el.recheck.disabled = b;
  }

  async function fetchState() {
    if (tab.id == null) return null;
    const res = await send({ type: 'get-tab-state', tabId: tab.id });
    return res && !('error' in res) ? res : null;
  }

  const sleep = (ms) => new Promise((r) => win.setTimeout(r, ms));

  function showPending() {
    el.state.textContent = 'Checking…';
    el.state.dataset.state = 'pending';
  }

  // Polls get-tab-state until a finished view for this tab's URL arrives whose ts differs from
  // `baseline`, or (from poll number `sameTsFrom` on) any finished view. Gives up after 30 s.
  async function poll(baseline, sameTsFrom) {
    const deadline = Date.now() + POLL_MAX_MS;
    let n = 0;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      n += 1;
      const view = relevant(await fetchState());
      if (view && DONE_STATES.has(view.state) && (view.ts !== baseline || n >= sameTsFrom)) {
        lastView = view;
        render(view);
        return true;
      }
      if (view?.state === 'pending') showPending();
    }
    render(lastView);
    setMessage('No result after 30 seconds.');
    return false;
  }

  function showSkipped(reason) {
    el.state.textContent = `This page isn't checked: ${SKIP_TEXT[reason] || reason}`;
    el.state.dataset.state = 'none';
  }

  async function check(force) {
    if (busy || tab.id == null) return;
    setBusy(true);
    setMessage('');
    const baseline = relevant(lastView)?.ts ?? null;
    try {
      showPending();
      const res = await send({ type: 'check-tab', tabId: tab.id, force });
      if (res && typeof res.error === 'string') {
        el.state.textContent = "This page can't be checked";
        el.state.dataset.state = 'none';
        setMessage('Reload the page and try again. Browser pages and the Web Store are never checked.');
        return;
      }
      if (res && typeof res.skipped === 'string' && res.skipped) {
        showSkipped(res.skipped);
        return;
      }
      // Re-check (force) always produces a fresh result, so never accept an unchanged ts.
      // For a plain check, a view that existed before the click may come back unchanged (the
      // content script can reuse its last result); accept it from the 2nd poll on, giving a
      // slower check ~1 s to write its pending state first.
      await poll(baseline, force ? Infinity : baseline === null ? 1 : 2);
    } finally {
      setBusy(false);
    }
  }

  async function deny() {
    let host;
    try {
      const u = new URL(tab.url);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('scheme');
      host = u.hostname;
    } catch {
      setMessage('This page has no site to add.');
      return;
    }
    const res = await send({ type: 'deny-host', host, tabId: tab.id });
    if (res && typeof res.error === 'string') {
      setMessage(`Could not add ${host}: ${res.error}`);
      return;
    }
    setMessage(`${host} will not be checked again.`);
    // The SW cleared this tab's state and badge; re-run the content script so it hits the
    // deny gate and removes its banner.
    lastView = null;
    render(null);
    const r = await send({ type: 'check-tab', tabId: tab.id, force: false });
    if (r && typeof r.skipped === 'string' && r.skipped) showSkipped(r.skipped);
  }

  async function resolveTab() {
    const param = new URLSearchParams(win.location.search).get('tabId');
    const id = param !== null && /^\d+$/.test(param) ? Number(param) : null;
    if (id !== null) {
      let url = null;
      try {
        url = (await chrome.tabs.get(id))?.url ?? null;
      } catch {
        // Tab gone or not readable; staleness check is skipped.
      }
      return { id, url };
    }
    try {
      const [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (t && Number.isInteger(t.id)) return { id: t.id, url: t.url ?? null };
    } catch {
      // fall through
    }
    return { id: null, url: null };
  }

  async function init() {
    el.check.addEventListener('click', () => check(false));
    el.recheck.addEventListener('click', () => check(true));
    el.deny.addEventListener('click', () => deny());
    el.settings.addEventListener('click', () => chrome.runtime.openOptionsPage());
    tab = await resolveTab();
    if (tab.id == null) {
      render(null);
      setBusy(true);
      el.deny.disabled = true;
      setMessage('No tab to check.');
      return;
    }
    lastView = relevant(await fetchState());
    render(lastView);
    // A check is already running (e.g. Auto mode on page load): follow it to the result.
    // Not awaited: init (and `ready`) resolve after the first render.
    if (lastView?.state === 'pending') {
      setBusy(true);
      poll(lastView.ts, 1).finally(() => setBusy(false));
    }
  }

  return { init, render, check };
}

export const ready =
  typeof chrome !== 'undefined' && chrome?.runtime && typeof document !== 'undefined'
    ? createPopup({ chrome, doc: document, win: window }).init()
    : Promise.resolve();
