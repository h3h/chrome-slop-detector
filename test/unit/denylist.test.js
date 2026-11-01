import { it, expect } from 'vitest';
import { isDenied, DEFAULT_DENY } from '../../src/lib/denylist.js';
it('suffix-matches hosts', () => {
  expect(isDenied('mail.google.com', DEFAULT_DENY)).toBe(true);
  expect(isDenied('acme.atlassian.net', DEFAULT_DENY)).toBe(true);
  expect(isDenied('notatlassian.net', DEFAULT_DENY)).toBe(false);
  expect(isDenied('www.nytimes.com', DEFAULT_DENY)).toBe(false);
  expect(isDenied('MAIL.GOOGLE.COM', DEFAULT_DENY)).toBe(true);
});
it('denies private addresses regardless of list', () => {
  for (const h of ['10.0.0.5', '192.168.1.1', '172.20.3.4', 'printer.local', 'wiki.corp.internal'])
    expect(isDenied(h, [])).toBe(true);
  expect(isDenied('172.32.0.1', [])).toBe(false);
  expect(isDenied('127.0.0.1', [])).toBe(false);
  expect(isDenied('127.0.0.1', DEFAULT_DENY)).toBe(true);
});
it('ignores blank entries', () => {
  expect(isDenied('a.com', ['', '  '])).toBe(false);
});
it('handles trailing dots and IPv6 literals', () => {
  expect(isDenied('mail.google.com.', DEFAULT_DENY)).toBe(true);
  expect(isDenied('printer.local.', [])).toBe(true);
  expect(isDenied('[::1]', [])).toBe(true);
});
