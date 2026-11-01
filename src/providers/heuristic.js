// Offline heuristic provider: five categories, score = 1 - 0.5^n, halved when n < 3.
// Categories: stock_phrases (>=2 distinct PHRASES), stock_phrases_heavy (>=4), em_dash,
// not_just_but, uniform_sentences. A flag (>=0.95) therefore needs all five.
// Note: the service worker applies threshold = max(settings.threshold, 0.95) when the
// provider is heuristic (Task 6).
import { normalize, countWords } from '../lib/text.js';

export const PHRASES = ['delve', 'tapestry', "it's important to note", "in today's fast-paced world", 'navigate the complexities', 'a testament to', 'in conclusion', 'unlock the potential', 'ever-evolving landscape', 'embark on a journey'];

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const PATTERNS = PHRASES.map((p) => ({
  phrase: p,
  re: p === 'delve'
    ? /\bdelv(?:e|es|ed|ing)\b/
    : new RegExp(`\\b${escapeRe(p)}\\b`),
}));

const NOT_JUST_BUT = /\bnot (just|only|merely) [^.?!]{1,80}?,? but\b/g;

export function scoreText(text) {
  const norm = normalize(text).toLowerCase().replace(/’/g, "'");
  const words = countWords(norm);
  const categories = [];
  const tells = [];

  const found = [];
  for (const { phrase, re } of PATTERNS) {
    if (re.test(norm)) {
      found.push(phrase);
      tells.push(`phrase: ${phrase}`);
    }
  }
  if (found.length >= 2) categories.push('stock_phrases');
  if (found.length >= 4) categories.push('stock_phrases_heavy');

  if (words > 0) {
    const dashes = (norm.match(/—/g) || []).length;
    const density = (dashes / words) * 100;
    if (density >= 1.0) {
      categories.push('em_dash');
      tells.push(`em-dash density ${density.toFixed(1)}/100 words`);
    }
  }

  const njb = (norm.match(NOT_JUST_BUT) || []).length;
  if (njb >= 2) {
    categories.push('not_just_but');
    tells.push(`"not just X, but Y" construction x${njb}`);
  }

  const lens = norm.split(/(?<=[.!?])\s+/).map((s) => countWords(s)).filter((n) => n >= 3);
  if (lens.length >= 15) {
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const cv = Math.sqrt(variance) / mean;
    if (cv < 0.25) {
      categories.push('uniform_sentences');
      tells.push(`uniform sentence length (CV ${cv.toFixed(2)} over ${lens.length} sentences)`);
    }
  }

  let score = 1 - Math.pow(0.5, categories.length);
  if (categories.length < 3) score *= 0.5;
  return { score, categories, tells };
}

export async function classify({ text }) {
  const { score, categories, tells } = scoreText(text);
  return { aiProbability: score, provider: 'heuristic', model: 'heuristic-v1', raw: { categories, tells, score } };
}
