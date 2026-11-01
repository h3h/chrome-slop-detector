import { Readability, isProbablyReaderable } from '@mozilla/readability';
import { isDenied } from '../lib/denylist.js';
import { videoIdFromUrl } from '../lib/youtube.js';
import { normalize } from '../lib/text.js';

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

// Returns a skip reason or null. Order: scheme, deny list, language. The <html lang> gate
// does not apply to YouTube watch pages: there lang reflects the viewer's UI language, and
// English caption-track selection already handles the video's language (escalation E5).
export function shouldSkip(doc, url, denyList) {
  const u = parseUrl(url);
  if (!u || (u.protocol !== 'http:' && u.protocol !== 'https:')) return 'scheme';
  if (isDenied(u.hostname, denyList || [])) return 'denied';
  if (isYouTubeWatch(u)) return null;
  const lang = String(doc?.documentElement?.lang ?? '').trim();
  if (lang && !lang.toLowerCase().startsWith('en')) return 'lang';
  return null;
}

function isYouTubeWatch(u) {
  return (u.hostname === 'www.youtube.com' || u.hostname === 'youtube.com') && u.pathname === '/watch' && !!videoIdFromUrl(u.href);
}

export function pageKind(doc, url) {
  const u = parseUrl(url);
  if (!u) return null;
  if (isYouTubeWatch(u)) return 'youtube';
  // Other YouTube pages (home, shorts, channels) are never classified as articles.
  if (u.hostname === 'youtube.com' || u.hostname.endsWith('.youtube.com')) return null;
  try {
    return isProbablyReaderable(doc) ? 'article' : null;
  } catch {
    return null;
  }
}

// Pages larger than this are not cloned or parsed (cost on huge DOMs).
export const MAX_ELEMS = 20000;

// Strips the fragment; used wherever two URLs are compared as "the same page".
export function stripHash(url) {
  const s = String(url ?? '');
  const i = s.indexOf('#');
  return i === -1 ? s : s.slice(0, i);
}

// Readability mutates the document it parses, so it always gets a clone.
export function extractArticle(doc) {
  let parsed;
  try {
    if (doc.getElementsByTagName('*').length > MAX_ELEMS) return null;
    parsed = new Readability(doc.cloneNode(true), { maxElemsToParse: MAX_ELEMS }).parse();
  } catch {
    return null;
  }
  if (!parsed) return null;
  const title = normalize(parsed.title || '');
  const body = normalize(parsed.textContent || '');
  if (!body) return null;
  return { title, text: title + '\n\n' + body };
}
