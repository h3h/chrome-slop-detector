import { describe, it, expect } from 'vitest';
import { normalize, countWords, truncateWords } from '../../src/lib/text.js';
describe('text', () => {
  it('normalizes zero-width and whitespace', () => {
    expect(normalize('  a​ b\n\n\tc  ')).toBe('a b c');
  });
  it('counts words', () => {
    expect(countWords('')).toBe(0);
    expect(countWords(' one  two\nthree ')).toBe(3);
  });
  it('truncates at word boundary', () => {
    expect(truncateWords('a b c d', 2)).toEqual({ text: 'a b', truncated: true });
    expect(truncateWords('a b', 5)).toEqual({ text: 'a b', truncated: false });
  });
});
