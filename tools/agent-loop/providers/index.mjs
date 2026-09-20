import { decide as decideClaude } from './claude.mjs';

const PROVIDERS = { claude: decideClaude };

/** Picks the decide() function named by DOMMT_AGENT_PROVIDER (default
 * "claude") — restart the poller to switch providers, no runtime
 * switching in v1. Laya isn't wired in yet (#102, blocked). */
export function resolveProvider(name = process.env.DOMMT_AGENT_PROVIDER ?? 'claude') {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown DOMMT_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}
