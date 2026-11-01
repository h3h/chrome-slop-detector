import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { scoreText, classify } from '../../src/providers/heuristic.js';
import { getProvider } from '../../src/providers/index.js';
import { classify as jevClassify } from '../../src/providers/jev.js';

// Fixtures start with a one-line "SYNTHETIC FIXTURE" label; strip it.
const load = (f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8').split('\n').slice(1).join('\n');

const ALL5 = ['stock_phrases', 'stock_phrases_heavy', 'em_dash', 'not_just_but', 'uniform_sentences'];

describe('heuristic', () => {
  it('fires all five categories on the AI fixture', () => {
    const r = scoreText(load('text-ai.txt'));
    expect(r.score).toBeGreaterThanOrEqual(0.95);
    for (const c of ALL5) expect(r.categories).toContain(c);
  });
  it('fires nothing on the human fixture', () => {
    const r = scoreText(load('text-human.txt'));
    expect(r.categories).toEqual([]);
    expect(r.score).toBe(0);
  });
  it('does not flag a realistic news-wire paragraph', () => {
    const text = 'WASHINGTON — The Senate voted 52-48 on Tuesday to advance a spending bill after a long overnight session. Democrats said the measure protects funding for rural hospitals. Republicans argued it adds too much to the deficit. Several members left the chamber without comment. The bill now returns to the House, where leaders have not set a date for a vote. Analysts expect a tight margin. A spokesperson for the majority leader said talks would continue through the week. Some senators from both parties floated amendments late in the day. Others warned that a shutdown remained possible if no deal emerged by Friday. In conclusion, aides said, the next several days will decide the outcome.';
    expect(scoreText(text).score).toBeLessThan(0.95);
    // Doubled to 20 sentences so uniform_sentences can fire; the all-five rule is what protects it.
    const doubled = scoreText(text + ' ' + text);
    expect(doubled.categories.length).toBeLessThanOrEqual(2);
    expect(doubled.score).toBeLessThan(0.95);
  });
  it('em_dash: dense em-dashes', () => {
    const r = scoreText('One—two three four five six seven eight nine ten.');
    expect(r.categories).toContain('em_dash');
  });
  it('not_just_but: two constructions', () => {
    const r = scoreText('It is not just fast, but cheap. It is not only small, but light.');
    expect(r.categories).toContain('not_just_but');
  });
  it('uniform_sentences: 15 equal-length sentences', () => {
    const text = Array.from({ length: 15 }, () => 'The quick brown fox jumps over it.').join(' ');
    expect(scoreText(text).categories).toContain('uniform_sentences');
  });
  it('one phrase gives no stock_phrases', () => {
    expect(scoreText('We should delve into the data.').categories).not.toContain('stock_phrases');
  });
  it('two categories only gives 0.375', () => {
    const r = scoreText('We should delve into the data. Life is a tapestry of small things.');
    expect(r.categories).toEqual(['stock_phrases']);
    const r2 = scoreText('We should delve into the data. Life is a tapestry of small things. X—y z a b c d e f g h i j k l m n o p q r s t u v w x y z.');
    expect(r2.categories).toEqual(['stock_phrases', 'em_dash']);
    expect(r2.score).toBeCloseTo(0.375, 10);
  });
  it.each(['delves', 'delved', 'delving'])('%s counts as phrase delve', (w) => {
    expect(scoreText(`They ${w} into it.`).tells).toContain('phrase: delve');
  });
  it('matches curly apostrophes', () => {
    expect(scoreText('It’s important to note that this works.').tells).toContain("phrase: it's important to note");
  });
  it('classify returns provider shape', async () => {
    const r = await classify({ text: load('text-ai.txt') });
    expect(r).toMatchObject({ provider: 'heuristic', model: 'heuristic-v1' });
    expect(r.aiProbability).toBe(r.raw.score);
  });
  it('registry', () => {
    expect(getProvider('jev').classify).toBe(jevClassify);
    expect(getProvider('heuristic')).not.toBeNull();
    expect(getProvider('nope')).toBeNull();
    expect(getProvider('constructor')).toBeNull();
  });
});
