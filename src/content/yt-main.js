// MAIN-world script (YouTube only). Answers requests from the isolated content script:
// - {__slop: nonce, type: 'get-player'}: the four player fields, never the full player response;
// - {__slop: nonce, type: 'get-pot', videoId, languageCode, timeoutMs}: a caption pot (see capturePot).
import { MSG_NS, extractPlayerInfo, potFromUrl } from '../lib/youtube.js';

const CAPTION_PREF = /^yt-player-caption/;
let potInFlight = null;

function existingPot(videoId) {
  for (const e of performance.getEntriesByType('resource')) {
    const pot = potFromUrl(e.name, videoId);
    if (pot) return pot;
  }
  return null;
}

function snapshotCaptionPrefs() {
  const snap = new Map();
  try {
    for (const k of Object.keys(localStorage)) if (CAPTION_PREF.test(k)) snap.set(k, localStorage.getItem(k));
  } catch { /* storage blocked */ }
  return snap;
}

function restoreCaptionPrefs(snap) {
  try {
    for (const k of Object.keys(localStorage)) if (CAPTION_PREF.test(k) && !snap.has(k)) localStorage.removeItem(k);
    for (const [k, v] of snap) localStorage.setItem(k, v);
  } catch { /* storage blocked */ }
}

// Only the player can mint a pot, and it does so when it loads a caption track. Reuse one from a
// request it already made; otherwise turn the track on, take the pot from the player's request,
// and put the previous track and the player's saved caption preferences back.
function capturePot(videoId, languageCode, timeoutMs) {
  const found = existingPot(videoId);
  if (found) return Promise.resolve(found);
  const player = document.getElementById('movie_player');
  if (typeof player?.setOption !== 'function' || typeof PerformanceObserver !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    const snap = snapshotCaptionPrefs();
    let prior;
    try { prior = player.getOption?.('captions', 'track'); } catch { /* no captions module yet */ }
    let done = false;
    let observer;
    let timer;
    const finish = (pot) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      observer?.disconnect();
      try {
        if (prior?.languageCode) player.setOption('captions', 'track', prior);
        else {
          player.setOption('captions', 'track', {});
          player.unloadModule?.('captions');
        }
      } catch { /* leave the player as it is */ }
      restoreCaptionPrefs(snap);
      resolve(pot);
    };
    try {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          const pot = potFromUrl(e.name, videoId);
          if (pot) return finish(pot);
        }
      });
      observer.observe({ type: 'resource' });
      timer = setTimeout(() => finish(null), timeoutMs);
      player.loadModule?.('captions');
      player.setOption('captions', 'track', { languageCode });
    } catch {
      finish(null);
    }
  });
}

async function replyPot(nonce, data) {
  let pot = null;
  try {
    if (typeof data.videoId === 'string' && typeof data.languageCode === 'string') {
      const timeoutMs = Math.min(Math.max(Number(data.timeoutMs) || 5000, 0), 10000);
      potInFlight ??= capturePot(data.videoId, data.languageCode, timeoutMs).finally(() => { potInFlight = null; });
      pot = await potInFlight;
    }
  } catch { /* reply null */ }
  window.postMessage({ [MSG_NS]: nonce, type: 'pot', pot }, window.location.origin);
}

function onMessage(event) {
  try {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;
    const nonce = data[MSG_NS];
    if (typeof nonce !== 'string' || !nonce) return;
    if (data.type === 'get-pot') return void replyPot(nonce, data);
    if (data.type !== 'get-player') return;
    const player = document.getElementById('movie_player');
    const pr = (typeof player?.getPlayerResponse === 'function' ? player.getPlayerResponse() : null) ?? window.ytInitialPlayerResponse;
    const info = extractPlayerInfo(pr);
    if (!info) return;
    window.postMessage({ [MSG_NS]: nonce, type: 'player', ...info }, window.location.origin);
  } catch {
    // Reply nothing; the isolated side times out and falls back.
  }
}

window.addEventListener('message', onMessage);
