export const CACHE_TTL_MS = 30 * 24 * 3600 * 1000, CACHE_CAP = 500;

// Serialize writes so concurrent puts can't lose updates across awaits.
let chain = Promise.resolve();

const expired = (e, now) => e.ts > now || now - e.ts > CACHE_TTL_MS;

export function cacheKey({ provider, model, textHash }) {
  return `${provider}|${model || ''}|${textHash}`;
}

export async function cacheGet(storageArea, key, now = Date.now()) {
  const { cache } = await storageArea.get('cache');
  const e = cache && cache[key];
  if (!e || expired(e, now)) return null;
  return e;
}

async function unlockedPut(storageArea, key, entry, now) {
  const { cache } = await storageArea.get('cache');
  const next = {};
  for (const [k, v] of Object.entries(cache || {})) if (!expired(v, now)) next[k] = v;
  next[key] = { ...entry, ts: now };
  const keys = Object.keys(next);
  if (keys.length > CACHE_CAP) {
    keys.sort((a, b) => next[b].ts - next[a].ts);
    for (const k of keys.slice(CACHE_CAP)) delete next[k];
  }
  await storageArea.set({ cache: next });
}

export function cachePut(storageArea, key, entry, now = Date.now()) {
  const p = chain.then(() => unlockedPut(storageArea, key, entry, now));
  chain = p.catch(() => {});
  return p;
}
