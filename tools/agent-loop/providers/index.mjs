import { decide as decideClaude } from './claude.mjs';
import { decide as decideLaya } from './laya.mjs';

const PROVIDERS = { claude: decideClaude, laya: decideLaya };

/** Picks the decide() function named by DOMMT_AGENT_PROVIDER (default
 * "claude") — restart the poller to switch providers, no runtime
 * switching in v1. */
export function resolveProvider(name = process.env.DOMMT_AGENT_PROVIDER ?? 'claude') {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown DOMMT_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}
