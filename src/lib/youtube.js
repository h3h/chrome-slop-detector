import { normalize } from './text.js';

export const MSG_NS = '__slop';

function isYouTubeHost(hostname) {
  return hostname === 'youtube.com' || hostname.endsWith('.youtube.com');
}

// 'v' param on youtube.com/watch only; shorts and everything else → null.
export function videoIdFromUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isYouTubeHost(u.hostname) || u.pathname !== '/watch') return null;
  return u.searchParams.get('v') || null;
}

// True for an absolute https URL on youtube.com (used to vet caption baseUrls before a
// credentialed fetch).
export function isYouTubeUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && isYouTubeHost(u.hostname);
  } catch {
    return false;
  }
}

export function pickCaptionTrack(tracks) {
  if (!Array.isArray(tracks)) return null;
  const english = tracks.filter(
    (t) => t && typeof t.baseUrl === 'string' && typeof t.languageCode === 'string' && t.languageCode.toLowerCase().startsWith('en'),
  );
  const manual = english.find((t) => t.kind !== 'asr');
  if (manual) return { track: manual, asr: false };
  const asr = english.find((t) => t.kind === 'asr');
  if (asr) return { track: asr, asr: true };
  return null;
}

// Segments are joined with '' within an event (ASR segments carry their own leading
// spaces), events with ' ', then normalized.
export function parseJson3(json) {
  const events = Array.isArray(json?.events) ? json.events : [];
  const parts = [];
  for (const ev of events) {
    if (!Array.isArray(ev?.segs)) continue;
    parts.push(ev.segs.map((s) => (typeof s?.utf8 === 'string' ? s.utf8 : '')).join(''));
  }
  return normalize(parts.join(' '));
}

function trackName(name) {
  if (typeof name === 'string') return name;
  if (typeof name?.simpleText === 'string') return name.simpleText;
  if (Array.isArray(name?.runs)) return name.runs.map((r) => (typeof r?.text === 'string' ? r.text : '')).join('');
  return undefined;
}

function cleanTrack(t) {
  const out = { baseUrl: String(t.baseUrl), languageCode: String(t.languageCode) };
  if (typeof t.kind === 'string') out.kind = t.kind;
  const name = trackName(t.name);
  if (name !== undefined) out.name = name;
  return out;
}

// Only the four fields the isolated world needs, as plain cloneable data; null when the
// response has no video.
export function extractPlayerInfo(playerResponse) {
  const vd = playerResponse?.videoDetails;
  if (!vd || typeof vd.videoId !== 'string' || !vd.videoId) return null;
  const raw = playerResponse.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  const captionTracks = Array.isArray(raw)
    ? raw.filter((t) => t && typeof t.baseUrl === 'string' && typeof t.languageCode === 'string').map(cleanTrack)
    : [];
  return {
    videoId: vd.videoId,
    title: typeof vd.title === 'string' ? vd.title : '',
    shortDescription: typeof vd.shortDescription === 'string' ? vd.shortDescription : '',
    captionTracks,
  };
}

export function isValidReply(event, nonce, win, type = 'player') {
  const data = event?.data;
  return (
    event?.source === win &&
    data !== null &&
    typeof data === 'object' &&
    data[MSG_NS] === nonce &&
    data.type === type
  );
}

// Proof-of-origin token the player adds to its own timedtext requests. Without it, caption
// tracks under YouTube's PO-token experiment answer 200 with an empty body.
const POT_RE = /^[A-Za-z0-9_+/=-]{1,4096}$/;

export function isValidPot(pot) {
  return typeof pot === 'string' && POT_RE.test(pot);
}

// The pot of a youtube.com timedtext request for videoId, or null.
export function potFromUrl(url, videoId) {
  if (!isYouTubeUrl(url)) return null;
  const u = new URL(url);
  if (u.pathname !== '/api/timedtext' || u.searchParams.get('v') !== videoId) return null;
  const pot = u.searchParams.get('pot');
  return isValidPot(pot) ? pot : null;
}

export function withPot(baseUrl, pot) {
  const u = new URL(baseUrl);
  u.searchParams.set('pot', pot);
  u.searchParams.set('c', 'WEB');
  return u.toString();
}
