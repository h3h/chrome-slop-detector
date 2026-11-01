// Jev (TypeSafe) adapter for POST /v1/systemone, per https://docs.typesafe.ai/api.md:
// one Choice question over the page text; aiProbability is that answer's p(ai_generated).
// Anything that does not match the documented ChoiceAnswer fails closed with bad_response.
import { ProviderError } from './errors.js';

export const QUESTION_ID = 'ai_authorship';
export const AI_OPTION = 'ai_generated';
export const OPTIONS = ['ai_generated', 'human_written', 'unclear'];
export const DEFAULT_MODEL = 'jev-1.13.0';
// Bump whenever INSTRUCTIONS or CRITERIA change: it is part of the cache key, so verdicts from
// an older prompt are not reused.
export const PROMPT_VERSION = 2;

// The question id is never sent to the model, so the instructions carry the full meaning.
// Modern AI prose is confident and number-dense rather than hedged, so the signs describe its
// style; tuned on a small labeled set (AI SEO guides, AI explainers, human essays, wikis).
const INSTRUCTIONS = {
  question: 'Was the `state` text written by an AI language model (such as ChatGPT or Claude), with little human rewriting?',
  judge: 'Judge the prose style, not the topic or whether the facts are accurate. Modern AI writing is often confident and dense with numbers rather than hedged, so do not treat specificity or statistics as evidence of a human.',
  ai_signs: [
    'Frequent em-dash asides and "X — not Y" or "not X, but Y" contrasts',
    'Short punchy verdict sentences and tidy aphorisms that sum up the point just made',
    'Items given personified role labels (the reliable one, the big sibling, the wild card)',
    'Statistics restated as verdicts and tidy takeaways after every fact',
    'Section titles with a colon and a subtitle; rule-of-three lists; polished, even, salesy tone throughout',
    'Second-person tour-guide advice with no first-hand experience, anecdote or sensory detail',
  ],
  human_signs: [
    'First-hand experience, anecdotes, digressions or opinions only a particular person would hold',
    'Uneven or idiosyncratic rhythm, asides, humor, informal slips or typos',
    'Neutral encyclopedic or reference style with citations, as in Wikipedia or wiki travel guides',
  ],
};

const CRITERIA = {
  ai_generated: 'Shows several AI writing signs and few human signs: the text was produced by an AI language model.',
  human_written: 'Shows human signs, or reads like ordinary human writing: the text was written by a person, possibly with light tool assistance.',
  unclear: 'Too short or mixed to tell.',
};

const RAW_MAX = 2048;

export function buildRequest({ text, model = DEFAULT_MODEL }) {
  return {
    model,
    state: text,
    questions: { [QUESTION_ID]: { type: 'choice', instructions: INSTRUCTIONS, criteria: CRITERIA } },
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseResponse(json) {
  const answer = isObj(json) && isObj(json.answers) ? json.answers[QUESTION_ID] : undefined;
  if (!isObj(answer) || answer.type !== 'choice' || !isObj(answer.probabilities)) {
    throw new ProviderError('bad_response', 'No choice answer in response');
  }
  const p = answer.probabilities[AI_OPTION];
  if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
    throw new ProviderError('bad_response', 'Missing or invalid ai_generated probability');
  }
  const out = { aiProbability: p };
  if (typeof answer.choice === 'string') out.selected = answer.choice;
  return out;
}

function trimRaw(raw, parsed) {
  let len;
  try { len = JSON.stringify(raw).length; } catch { len = Infinity; }
  if (len <= RAW_MAX) return raw;
  const out = { truncated: true, aiProbability: parsed.aiProbability };
  if (OPTIONS.includes(parsed.selected)) out.selected = parsed.selected;
  return out;
}

function discardBody(res) {
  try {
    const p = res.body?.cancel?.();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch { /* ignore */ }
}

export async function classify({ text }, { apiKey, endpoint, model = DEFAULT_MODEL, fetch, timeoutMs = 20000, signal } = {}) {
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new ProviderError('auth', 'No API key');

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  let status;
  let bodyText;
  try {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(buildRequest({ text, model })),
        signal: controller.signal,
      });
    } catch {
      if (timedOut) throw new ProviderError('timeout', `No response within ${timeoutMs} ms`);
      throw new ProviderError('network', 'Request failed');
    }
    status = res.status;
    if (!res.ok) discardBody(res);
    if (status === 401 || status === 403) throw new ProviderError('auth', `HTTP ${status}`, status);
    // 529 is TypeSafe's "overloaded": same retry-later handling as a rate limit.
    if (status === 429 || status === 529) throw new ProviderError('provider_rate_limit', `HTTP ${status}`, status);
    if (!res.ok) throw new ProviderError('bad_response', `HTTP ${status}`, status);
    try {
      bodyText = await res.text();
    } catch {
      if (timedOut) throw new ProviderError('timeout', `No response within ${timeoutMs} ms`);
      throw new ProviderError('network', 'Failed reading response');
    }
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }

  let json;
  try { json = JSON.parse(bodyText); } catch {
    throw new ProviderError('bad_response', 'Response is not JSON', status);
  }
  const parsed = parseResponse(json);
  return { aiProbability: parsed.aiProbability, provider: 'jev', model, raw: trimRaw(json, parsed) };
}
