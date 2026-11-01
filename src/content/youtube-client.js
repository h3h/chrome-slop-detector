// Isolated-world side of the YouTube bridge.
//
// The nonce and `event.source === win` checks only keep replies paired with their request and
// filter messages from other frames. They are NOT a security boundary against the page
// itself: page script shares the window with the MAIN-world script and can read or forge
// any of these messages. What prevents a forged reply from steering a credentialed fetch
// is fetchTranscript's check that baseUrl is an https youtube.com URL.
import { MSG_NS, videoIdFromUrl, pickCaptionTrack, parseJson3, isValidReply, isYouTubeUrl } from '../lib/youtube.js';

function newNonce(win) {
  const c = win.crypto ?? globalThis.crypto;
  return c.randomUUID();
}

export function requestPlayer(win, { timeoutMs = 1500 } = {}) {
  return new Promise((resolve) => {
    let nonce;
    let timer;
    const finish = (value) => {
      clearTimeout(timer);
      win.removeEventListener('message', onMessage);
      resolve(value);
    };
    function onMessage(event) {
      if (!isValidReply(event, nonce, win)) return;
      const d = event.data;
      finish({
        videoId: d.videoId,
        title: typeof d.title === 'string' ? d.title : '',
        shortDescription: typeof d.shortDescription === 'string' ? d.shortDescription : '',
        captionTracks: Array.isArray(d.captionTracks) ? d.captionTracks : [],
      });
    }
    try {
      nonce = newNonce(win);
      win.addEventListener('message', onMessage);
      timer = setTimeout(() => finish(null), timeoutMs);
      win.postMessage({ [MSG_NS]: nonce, type: 'get-player' }, win.location.origin);
    } catch {
      finish(null);
    }
  });
}

// GET baseUrl with fmt=json3. The timeout and the caller's signal cover both the request and
// the body read; any failure, timeout or abort yields ''.
export async function fetchTranscript(track, fetchFn, { timeoutMs = 8000, signal } = {}) {
  const base = track?.baseUrl;
  if (typeof base !== 'string' || !isYouTubeUrl(base)) return '';
  if (signal?.aborted) return '';
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  // Rejects on abort even if fetchFn or its body read ignores the signal.
  const aborted = new Promise((_, reject) => {
    controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  aborted.catch(() => {});
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const url = new URL(base);
    url.searchParams.set('fmt', 'json3');
    const work = (async () => {
      const res = await fetchFn(url.toString(), { credentials: 'include', signal: controller.signal });
      if (!res || !res.ok) return '';
      return parseJson3(await res.json());
    })();
    work.catch(() => {});
    return await Promise.race([work, aborted]);
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

function delay(ms, signal) {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

// Returns the text to classify, or:
// - null when the player bridge does not answer, when the player data never matches the URL's
//   video (SPA navigation can leave the player a step behind, so a mismatch is retried), when
//   the URL changes while the transcript loads, or when the caller aborts;
// - {skip:'lang'} when no English track is usable and at least one track has a non-English
//   languageCode (E6: the video is not English).
// The title + description fallback is used only when there are no caption tracks or the
// English track yields no text.
export async function getYouTubeText(win, fetchFn, { signal, retries = 2, retryDelayMs = 400, requestTimeoutMs } = {}) {
  const want = () => videoIdFromUrl(win.location.href);
  const reqOpts = requestTimeoutMs === undefined ? {} : { timeoutMs: requestTimeoutMs };
  let info = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (signal?.aborted) return null;
    if (attempt > 0) {
      await delay(retryDelayMs, signal);
      if (signal?.aborted) return null;
    }
    info = await requestPlayer(win, reqOpts);
    if (!info || signal?.aborted) return null;
    if (info.videoId && info.videoId === want()) break;
    info = null;
  }
  if (!info || signal?.aborted) return null;
  const { videoId, title, shortDescription } = info;
  const picked = pickCaptionTrack(info.captionTracks);
  // E6: captions exist but none is English, so the video is not English. The description
  // fallback would send non-English text; skip instead.
  // Malformed tracks alone (no string languageCode) don't prove a language: fall back.
  const hasNonEn = info.captionTracks.some(
    (t) => typeof t?.languageCode === 'string' && !t.languageCode.toLowerCase().startsWith('en'),
  );
  if (!picked && hasNonEn) return { skip: 'lang' };
  if (picked) {
    const text = await fetchTranscript(picked.track, fetchFn, { signal });
    if (signal?.aborted || videoId !== want()) return null;
    if (text) return { text, title, source: 'transcript', asr: picked.asr, videoId };
  }
  return { text: title + '\n\n' + shortDescription, title, source: 'description', asr: false, videoId };
}
