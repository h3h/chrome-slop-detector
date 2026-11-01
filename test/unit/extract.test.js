// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://news.example.com/2026/ferry"}
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldSkip, pageKind, extractArticle, stripHash, MAX_ELEMS } from '../../src/content/extract.js';
import { DEFAULT_DENY } from '../../src/lib/denylist.js';
import { countWords } from '../../src/lib/text.js';

const fixture = (name) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../fixtures', name), 'utf8');
const parse = (html) => new DOMParser().parseFromString(html, 'text/html');
const ARTICLE_URL = 'https://news.example.com/2026/ferry';

function loadIntoGlobalDocument(html) {
  const parsed = parse(html);
  document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement);
}

describe('pageKind', () => {
  it('article fixture is an article', () => {
    expect(pageKind(parse(fixture('article.html')), ARTICLE_URL)).toBe('article');
  });
  it('homepage fixture is not', () => {
    expect(pageKind(parse(fixture('homepage.html')), 'https://news.example.com/')).toBeNull();
  });
  it('app fixture is not', () => {
    expect(pageKind(parse(fixture('app.html')), 'https://console.example.com/')).toBeNull();
  });
  it('youtube watch URL is youtube regardless of document', () => {
    expect(pageKind(parse('<html><body></body></html>'), 'https://www.youtube.com/watch?v=abc123')).toBe('youtube');
    expect(pageKind(parse('<html><body></body></html>'), 'https://youtube.com/watch?v=abc123')).toBe('youtube');
  });
  it('youtube non-watch pages are null, even if readerable', () => {
    expect(pageKind(parse('<html><body></body></html>'), 'https://www.youtube.com/')).toBeNull();
    expect(pageKind(parse(fixture('article.html')), 'https://www.youtube.com/')).toBeNull();
    expect(pageKind(parse('<html><body></body></html>'), 'https://www.youtube.com/watch')).toBeNull();
    expect(pageKind(parse('<html><body></body></html>'), 'https://www.youtube.com/shorts/abc')).toBeNull();
  });
});

describe('extractArticle', () => {
  it('returns title + text with at least 400 words and leaves the document untouched', () => {
    loadIntoGlobalDocument(fixture('article.html'));
    const before = document.body.innerHTML;
    const out = extractArticle(document);
    expect(out).not.toBeNull();
    expect(out.title).toContain('Harbor Town Reopens Its Century-Old Ferry Line');
    expect(out.text.startsWith(out.title + '\n\n')).toBe(true);
    expect(countWords(out.text)).toBeGreaterThanOrEqual(400);
    expect(document.body.innerHTML).toBe(before);
  });
  it('returns null without cloning when the page exceeds the element cap', () => {
    const doc = parse(fixture('article.html'));
    const filler = doc.createElement('div');
    for (let i = 0; i <= MAX_ELEMS; i++) filler.appendChild(doc.createElement('span'));
    doc.body.appendChild(filler);
    const spy = vi.spyOn(doc, 'cloneNode');
    expect(extractArticle(doc)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it('stripHash drops only the fragment', () => {
    expect(stripHash('https://a.example/x?y=1#z')).toBe('https://a.example/x?y=1');
    expect(stripHash('https://a.example/x')).toBe('https://a.example/x');
  });
  it('returns null when Readability cannot parse', () => {
    expect(extractArticle(parse('<html><head></head><body></body></html>'))).toBeNull();
  });
});

describe('shouldSkip', () => {
  const en = parse('<html lang="en"><body></body></html>');
  it('non-http schemes', () => {
    expect(shouldSkip(en, 'chrome://x', DEFAULT_DENY)).toBe('scheme');
    expect(shouldSkip(en, 'file:///tmp/a.html', DEFAULT_DENY)).toBe('scheme');
    expect(shouldSkip(en, 'not a url', DEFAULT_DENY)).toBe('scheme');
  });
  it('deny-listed host', () => {
    expect(shouldSkip(en, 'https://mail.google.com/', DEFAULT_DENY)).toBe('denied');
  });
  it('non-English lang', () => {
    expect(shouldSkip(parse('<html lang="de"><body></body></html>'), ARTICLE_URL, DEFAULT_DENY)).toBe('lang');
  });
  it('English variants and missing lang pass', () => {
    expect(shouldSkip(parse('<html lang="en-US"><body></body></html>'), ARTICLE_URL, DEFAULT_DENY)).toBeNull();
    expect(shouldSkip(parse('<html lang="EN"><body></body></html>'), ARTICLE_URL, DEFAULT_DENY)).toBeNull();
    expect(shouldSkip(parse('<html><body></body></html>'), ARTICLE_URL, DEFAULT_DENY)).toBeNull();
    expect(shouldSkip(en, 'http://news.example.com/', DEFAULT_DENY)).toBeNull();
  });
  it('does not apply the lang gate on YouTube watch pages', () => {
    const de = parse('<html lang="de-DE"><body></body></html>');
    expect(shouldSkip(de, 'https://www.youtube.com/watch?v=abc123', DEFAULT_DENY)).toBeNull();
    expect(shouldSkip(de, 'https://youtube.com/watch?v=abc123', DEFAULT_DENY)).toBeNull();
    // Other YouTube pages and other hosts keep the gate.
    expect(shouldSkip(de, 'https://www.youtube.com/', DEFAULT_DENY)).toBe('lang');
    expect(shouldSkip(de, 'https://www.youtube.com/watch', DEFAULT_DENY)).toBe('lang');
    // The deny list still applies on YouTube.
    expect(shouldSkip(de, 'https://www.youtube.com/watch?v=abc123', ['youtube.com'])).toBe('denied');
  });
  it('tolerates a missing deny list', () => {
    expect(shouldSkip(en, ARTICLE_URL, undefined)).toBeNull();
  });
});
