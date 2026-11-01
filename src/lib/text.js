const ZERO_WIDTH = /[​‌‍⁠﻿]/g;

export function normalize(text) {
  return String(text ?? '').replace(ZERO_WIDTH, '').replace(/\s+/g, ' ').trim();
}

export function countWords(text) {
  const m = normalize(text).match(/\S+/g);
  return m ? m.length : 0;
}

export function truncateWords(text, max) {
  const n = Math.max(0, Math.floor(max));
  const words = normalize(text).match(/\S+/g) || [];
  if (words.length <= n) return { text: words.join(' '), truncated: false };
  return { text: words.slice(0, n).join(' '), truncated: true };
}
