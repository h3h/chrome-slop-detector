import { classify as jev } from './jev.js';
import { classify as heuristic } from './heuristic.js';

const PROVIDERS = { jev: { classify: jev }, heuristic: { classify: heuristic } };

export function getProvider(name) {
  return Object.prototype.hasOwnProperty.call(PROVIDERS, name) ? PROVIDERS[name] : null;
}
