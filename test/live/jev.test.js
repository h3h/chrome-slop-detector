// Calls the real Jev API with the production prompt. Run with `npm run test:live`; skipped
// without JEV_API_KEY.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { classify } from '../../src/providers/jev.js';
import { DEFAULT_SETTINGS } from '../../src/lib/settings.js';
import { DEFAULT_THRESHOLD } from '../../src/lib/policy.js';

// Fixtures start with a one-line label; strip it.
const text = (f) => readFileSync(new URL(`../fixtures/${f}`, import.meta.url), 'utf8').split('\n').slice(1).join('\n');
const score = async (f) => (await classify({ text: text(f) }, {
  apiKey: process.env.JEV_API_KEY, endpoint: DEFAULT_SETTINGS.jevEndpoint, model: DEFAULT_SETTINGS.jevModel, fetch,
})).aiProbability;

describe.skipIf(!process.env.JEV_API_KEY)('Jev live scoring', () => {
  it.each(['real-ai-hotsprings-guide.txt', 'real-ai-youtube-transcript.txt', 'text-ai.txt'])(
    '%s is flagged', async (f) => {
      expect(await score(f)).toBeGreaterThanOrEqual(DEFAULT_THRESHOLD);
    });
  it('text-human.txt is not flagged', async () => {
    expect(await score('text-human.txt')).toBeLessThan(0.5);
  });
});
