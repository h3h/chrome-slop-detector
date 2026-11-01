// Isolated-world content script entry (bundled as an IIFE). `start` is exported for unit
// tests; the bottom of the file starts it only inside a live extension context.
import { shouldSkip, pageKind, extractArticle, stripHash } from './extract.js';
import { renderBanner, removeBanner } from './banner.js';
import { getYouTubeText } from './youtube-client.js';
import { videoIdFromUrl } from '../lib/youtube.js';

function contextValid(chrome) {
  try {
    return !!chrome?.runtime?.id;
  } catch {
    return false;
  }
}

function isYouTubeHost(url) {
  try {
    const h = new URL(url).hostname;
    return h === 'youtube.com' || h.endsWith('.youtube.com');
  } catch {
    return false;
  }
}

export function start({ chrome, win, doc, fetchFn, ytOptions = {}, getText = getYouTubeText }) {
  if (win.top !== win) return null; // top frame only

  let stopped = false;
  let current = null; // AbortController of the run in progress
  let lastVideoId = null; // last YouTube video whose text was obtained and sent
  let lastView = null; // the view returned for lastVideoId
  let lastPending = null; // the classify send for lastVideoId while it is in flight
  let checked = false; // a classify request was sent from this page (either mode)
  let pageUrl = stripHash(win.location.href); // for non-YouTube SPA navigation

  const abortCurrent = () => {
    current?.abort();
    current = null;
  };

  const onNavigate = () => {
    if (stopped) return;
    abortCurrent();
    removeBanner(doc);
    run(false, 'auto');
  };

  // Non-YouTube SPA navigation (Navigation API): drop the stale banner and the in-flight
  // run. No re-classify. YouTube is handled by yt-navigate-finish.
  const onNavigateSuccess = () => {
    if (stopped) return;
    const now = stripHash(win.location.href);
    if (now === pageUrl) return;
    pageUrl = now;
    if (isYouTubeHost(now)) return;
    abortCurrent();
    removeBanner(doc);
  };

  // bfcache restore: the SW cleared this tab's state when the page was hidden, so check
  // again. Skips the YouTube videoId dedupe but never forces (served from the SW cache).
  // In manual mode, only re-check if the user had already checked this page.
  const onPageShow = (e) => {
    if (stopped || !e?.persisted) return;
    run(false, checked ? 'manual' : 'auto', { redo: true });
  };

  const onPrerenderingChange = () => {
    if (!stopped) run(false, 'auto');
  };

  // Replies {ok:true, skipped} once the gates are decided (before classification), so the
  // popup can say why nothing happened. Returns true to keep the port open until then.
  const onMessage = (msg, _sender, sendResponse) => {
    if (stopped || msg?.type !== 'run-check') return false;
    let replied = false;
    const reply = (skipped) => {
      if (replied) return;
      replied = true;
      try {
        sendResponse({ ok: true, skipped });
      } catch {
        /* port already closed */
      }
    };
    run(!!msg.force, 'manual', { onGate: reply }).finally(() => reply('unavailable'));
    return true;
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    abortCurrent();
    doc.removeEventListener('yt-navigate-finish', onNavigate);
    doc.removeEventListener('prerenderingchange', onPrerenderingChange);
    win.removeEventListener?.('pageshow', onPageShow);
    win.navigation?.removeEventListener?.('navigatesuccess', onNavigateSuccess);
    try {
      chrome.runtime.onMessage.removeListener(onMessage);
    } catch {
      /* context gone */
    }
  }

  // Returns the response, or undefined on any failure. If the extension was reloaded or
  // removed (context invalidated), stops this content script for good.
  async function send(msg) {
    if (stopped) return undefined;
    try {
      const res = await chrome.runtime.sendMessage(msg);
      if (res && typeof res === 'object' && 'error' in res) return undefined;
      return res;
    } catch {
      if (!contextValid(chrome)) stop();
      return undefined;
    }
  }

  // Only 'flagged' renders; 'clear', 'unknown', 'pending' or a failed send remove the banner.
  function apply(view) {
    if (view?.state === 'flagged') renderBanner(doc, view);
    else removeBanner(doc);
  }

  // trigger 'auto' runs only in auto mode; 'manual' (popup button) runs in either mode.
  // onGate(reason|null) is called once the run is known to proceed or be skipped.
  async function run(force, trigger, { redo = false, onGate = () => {} } = {}) {
    if (stopped) return;
    abortCurrent();
    const ctl = new AbortController();
    current = ctl;
    const live = () => !stopped && !ctl.signal.aborted;

    const url = win.location.href;
    const samePage = () => stripHash(win.location.href) === stripHash(url);
    // Content scripts get only { mode, denyList }; full settings carry the API key.
    const settings = await send({ type: 'get-content-config' });
    if (!live() || !settings) return;
    if (trigger === 'auto' && settings.mode !== 'auto') return;
    const skip = shouldSkip(doc, url, settings.denyList);
    if (skip) return onGate(skip);

    const kind = pageKind(doc, url);
    if (!kind) return onGate('not_article');

    let payload;
    if (kind === 'youtube') {
      // Transcript fetching can take seconds; acknowledge before it.
      onGate(null);
      const vid = videoIdFromUrl(url);
      if (!force && !redo && vid === lastVideoId) {
        // Same video: reuse the result, waiting for it if the classify is still in flight.
        const v = lastView ?? (lastPending && (await lastPending));
        if (live() && samePage()) apply(v);
        return;
      }
      const yt = await getText(win, fetchFn, { ...ytOptions, signal: ctl.signal });
      if (!live() || !yt) return; // null: aborted or player mismatch — do not mark done
      lastVideoId = yt.videoId;
      lastView = null;
      payload = { kind, text: yt.text, title: yt.title, asr: !!yt.asr, source: yt.source };
    } else {
      const art = extractArticle(doc);
      if (!live()) return;
      if (!art) return onGate('no_text');
      onGate(null);
      payload = { kind, text: art.text, title: art.title, asr: false, source: 'article' };
    }

    checked = true;
    const pending = send({ type: 'classify', ...payload, url, force: !!force });
    const forVideo = kind === 'youtube' ? lastVideoId : null;
    if (forVideo) lastPending = pending;
    const view = await pending;
    if (forVideo && lastVideoId === forVideo && lastPending === pending) {
      lastPending = null;
      // A failed send leaves the video retryable; a real view is reused on dedupe.
      if (view) lastView = view;
      else lastVideoId = null;
    }
    if (!live() || !samePage()) return;
    apply(view);
  }

  try {
    chrome.runtime.onMessage.addListener(onMessage);
  } catch {
    return null;
  }
  doc.addEventListener('yt-navigate-finish', onNavigate);
  win.addEventListener?.('pageshow', onPageShow);
  win.navigation?.addEventListener?.('navigatesuccess', onNavigateSuccess);
  // Never send page text while prerendering; wait until the page is actually shown.
  if (doc.prerendering) doc.addEventListener('prerenderingchange', onPrerenderingChange, { once: true });
  else run(false, 'auto');

  return { run, stop, get stopped() { return stopped; } };
}

/* global chrome */
if (typeof chrome !== 'undefined' && contextValid(chrome) && typeof window !== 'undefined') {
  start({ chrome, win: window, doc: document, fetchFn: (...a) => fetch(...a) });
}
