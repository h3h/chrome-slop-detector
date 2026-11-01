// Jev (TypeSafe) adapter. The API contract is UNVERIFIED (third-party write-ups only):
// every request field name lives in JEV_FIELDS and the parser accepts several shapes,
// failing closed with ProviderError('bad_response') on anything it does not recognise.
import { ProviderError } from './errors.js';

export const JEV_FIELDS = {
  model: 'model',
  input: 'input',
  questions: 'questions',
  questionId: 'id',
  questionType: 'type',
  instructions: 'instructions',
  criteria: 'criteria',
};

export const QUESTION_ID = 'ai_authorship';
export const QUESTION_TYPE = 'choice';
export const AI_OPTION = 'ai_generated';
export const OPTIONS = ['ai_generated', 'human_written', 'unclear'];
export const DEFAULT_MODEL = 'jev-1.13.0';

const INSTRUCTIONS =
  'Was this text obviously written by an AI language model? Judge the writing itself: stock phrasing, uniform rhythm, generic structure and hedged filler suggest AI; specific lived detail, idiosyncratic voice and uneven rhythm suggest a human.';

const CRITERIA = {
  ai_generated: 'The text was clearly produced by an AI language model with little human rewriting.',
  human_written: 'The text was written by a person, possibly with light tool assistance.',
  unclear: 'There is not enough evidence to tell.',
};

const RAW_MAX = 2048;

export function buildRequest({ text, model = DEFAULT_MODEL }) {
  const criteria = {};
  for (const opt of OPTIONS) criteria[opt] = CRITERIA[opt];
  return {
    [JEV_FIELDS.model]: model,
    [JEV_FIELDS.input]: text,
    [JEV_FIELDS.questions]: [{
      [JEV_FIELDS.questionId]: QUESTION_ID,
      [JEV_FIELDS.questionType]: QUESTION_TYPE,
      [JEV_FIELDS.instructions]: INSTRUCTIONS,
      [JEV_FIELDS.criteria]: criteria,
    }],
  };
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function firstOwn(o, keys) {
  for (const k of keys) if (hasOwn(o, k)) return o[k];
  return undefined;
}

function mapFromArray(arr) {
  const map = Object.create(null);
  for (const e of arr) {
    if (!isObj(e)) continue;
    const name = firstOwn(e, ['option', 'label', 'name']);
    if (typeof name !== 'string' || name in map) continue;
    map[name] = firstOwn(e, ['probability', 'score', 'p']);
  }
  return map;
}

function findMap(c) {
  if (!isObj(c)) return null;
  if (isObj(c.probabilities)) {
    const map = Object.create(null);
    for (const k of Object.keys(c.probabilities)) map[k] = c.probabilities[k];
    return map;
  }
  for (const k of ['probabilities', 'options', 'scores']) {
    if (Array.isArray(c[k])) return mapFromArray(c[k]);
  }
  return null;
}

function pickSelected(...objs) {
  for (const o of objs) {
    if (!isObj(o)) continue;
    for (const k of ['selected', 'answer', 'choice']) {
      if (typeof o[k] === 'string') return o[k];
    }
  }
  return undefined;
}

export function parseResponse(json) {
  if (!isObj(json)) throw new ProviderError('bad_response', 'Response is not an object');
  const candidates = [
    json,
    Array.isArray(json.results) ? json.results[0] : undefined,
    Array.isArray(json.answers) ? json.answers[0] : undefined,
    Array.isArray(json.questions) ? json.questions[0] : undefined,
    json.result,
  ];
  for (const c of candidates) {
    const map = findMap(c);
    // A map without ai_generated does not stop the search; a present-but-invalid
    // value fails closed rather than falling through to a later candidate.
    if (!map || !(AI_OPTION in map)) continue;
    const p = map[AI_OPTION];
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      throw new ProviderError('bad_response', 'Missing or invalid ai_generated probability');
    }
    const out = { aiProbability: p };
    const selected = pickSelected(c, json);
    if (selected !== undefined) out.selected = selected;
    return out;
  }
  throw new ProviderError('bad_response', 'No probability map in response');
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
    if (status === 429) throw new ProviderError('provider_rate_limit', 'HTTP 429', status);
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
