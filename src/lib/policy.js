export const DEFAULT_THRESHOLD = 0.9, ASR_BUMP = 0.05, MIN_WORDS = 250, MIN_WORDS_TRANSCRIPT = 300, MAX_WORDS = 2500;

const r4 = (n) => Math.round(n * 10000) / 10000;

export function verdict({ aiProbability, asr }, { threshold }) {
  const effectiveThreshold = r4(threshold + (asr ? ASR_BUMP : 0));
  const state = r4(aiProbability) >= effectiveThreshold ? 'flagged' : 'clear';
  return { state, effectiveThreshold };
}
