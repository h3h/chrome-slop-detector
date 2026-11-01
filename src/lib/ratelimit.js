export const RATE_LIMIT = 30, RATE_WINDOW_MS = 3600 * 1000;

// Serialize read-modify-write cycles so concurrent callers can't race across awaits.
let chain = Promise.resolve();

async function unlocked(storageArea, now) {
  const { rateLog } = await storageArea.get('rateLog');
  const log = (rateLog || []).filter((t) => t >= now - RATE_WINDOW_MS && t <= now);
  if (log.length >= RATE_LIMIT) {
    await storageArea.set({ rateLog: log });
    return false;
  }
  log.push(now);
  await storageArea.set({ rateLog: log });
  return true;
}

export function tryConsume(storageArea, now = Date.now()) {
  const p = chain.then(() => unlocked(storageArea, now));
  chain = p.catch(() => {});
  return p;
}
