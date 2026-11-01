import { it, expect } from 'vitest';
import { verdict, DEFAULT_THRESHOLD } from '../../src/lib/policy.js';
it('flags at or above threshold', () => {
  expect(verdict({ aiProbability: 0.9 }, { threshold: DEFAULT_THRESHOLD }).state).toBe('flagged');
  expect(verdict({ aiProbability: 0.8999 }, { threshold: 0.9 }).state).toBe('clear');
});
it('bumps threshold for ASR transcripts', () => {
  expect(verdict({ aiProbability: 0.92, asr: true }, { threshold: 0.9 })).toEqual({ state: 'clear', effectiveThreshold: 0.95 });
  expect(verdict({ aiProbability: 0.95, asr: true }, { threshold: 0.9 }).state).toBe('flagged');
});
