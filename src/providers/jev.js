// Jev (TypeSafe) adapter for POST /v1/systemone, per https://docs.typesafe.ai/api.md:
// one Choice question over the page text; aiProbability is that answer's p(ai_generated).
// Anything that does not match the documented ChoiceAnswer fails closed with bad_response.
import { ProviderError } from './errors.js';

export const QUESTION_ID = 'ai_authorship';
export const AI_OPTION = 'ai_generated';
export const OPTIONS = ['ai_generated', 'human_written', 'unclear'];
export const DEFAULT_MODEL = 'jev-1.13.0';

// The question id is never sent to the model, so the instructions carry the full meaning.
const INSTRUCTIONS =
  'Was the `state` text obviously written by an AI language model? Judge the writing itself: stock phrasing, uniform rhythm, generic structure and hedged filler suggest AI; specific lived detail, idiosyncratic voice and uneven rhythm suggest a human.';

const CRITERIA = {
  ai_generated: 'The text was clearly produced by an AI language model with little human rewriting.',
  human_written: 'The text was written by a person, possibly with light tool assistance.',
  unclear: 'There is not enough evidence to tell.',
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
