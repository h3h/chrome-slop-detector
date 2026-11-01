import { DEFAULT_DENY } from './denylist.js';
import { DEFAULT_THRESHOLD } from './policy.js';

export const DEFAULT_SETTINGS = {
  provider: 'jev', // 'jev' | 'heuristic'
  jevApiKey: '',
  jevEndpoint: 'https://api.typesafe.ai/v1/systemone',
  jevModel: 'jev-1.13.0',
  threshold: DEFAULT_THRESHOLD,
  mode: 'auto', // 'auto' | 'manual'
  denyList: [...DEFAULT_DENY]
};

const PROVIDERS = ['jev', 'heuristic'];
const MODES = ['auto', 'manual'];

export function validateEndpoint(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, error: 'Endpoint must be a valid URL' };
  }
  if (u.protocol === 'https:') return { ok: true };
  if (u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1')) return { ok: true };
  return { ok: false, error: 'Endpoint must use https' };
}

export async function loadSettings(storageArea) {
  const { settings } = await storageArea.get('settings');
  return { ...structuredClone(DEFAULT_SETTINGS), ...(settings || {}) };
}

export async function saveSettings(storageArea, patch) {
  const clean = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (v !== undefined && Object.hasOwn(DEFAULT_SETTINGS, k)) clean[k] = v;
  }
  if ('denyList' in clean && !Array.isArray(clean.denyList)) throw new Error('Deny list must be a list');
  const merged = { ...(await loadSettings(storageArea)), ...clean };
  // Only known keys are persisted, so retired fields (e.g. noticeAcknowledged) drop out.
  const next = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, merged[k]]));
  next.jevModel = typeof next.jevModel === 'string' && next.jevModel.trim() ? next.jevModel.trim() : DEFAULT_SETTINGS.jevModel;
  if (!PROVIDERS.includes(next.provider)) throw new Error(`Unknown provider: ${next.provider}`);
  if (!MODES.includes(next.mode)) throw new Error(`Unknown mode: ${next.mode}`);
  if (typeof next.threshold !== 'number' || !(next.threshold >= 0.5 && next.threshold <= 0.99)) {
    throw new Error('Threshold must be between 0.5 and 0.99');
  }
  if (clean.jevEndpoint !== undefined) {
    const v = validateEndpoint(next.jevEndpoint);
    if (!v.ok) throw new Error(v.error);
  }
  next.denyList = [...new Set((next.denyList || []).map((d) => String(d).trim().toLowerCase()).filter(Boolean))];
  await storageArea.set({ settings: next });
  return next;
}
