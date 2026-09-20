/**
 * Thin wrapper around the foundry-rest relay's own HTTP protocol
 * (POST {base}/execute-js?clientId=... — see .claude/skills/foundry-rest/
 * foundry-exec.sh for the reference implementation this mirrors). Talks to
 * a self-hosted foundryvtt-rest-api-relay instance by default (unlimited
 * requests, no third-party dependency — see the design doc's Alternatives
 * Considered section for why).
 */

import { readFileSync } from 'node:fs';

function readEnvOrDotenv(name) {
  if (process.env[name]) return process.env[name];
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).trim() : undefined;
  } catch {
    return undefined;
  }
}

export async function findOnlineClientId({ baseUrl, apiKey, fetchImpl = fetch }) {
  const res = await fetchImpl(`${baseUrl}/clients`, { headers: { 'x-api-key': apiKey } });
  const body = await res.json();
  const clients = body.clients ?? [];
  const chosen = clients.find((c) => c.isOnline) ?? clients[0];
  if (!chosen) throw new Error('foundry-client: no Foundry client registered with the relay');
  return chosen.clientId;
}

/** Runs `script` inside the live Foundry world and returns its `result`.
 * Throws on a relay-level refusal or a script-level error, with the same
 * distinction foundry-exec.sh makes (banned pattern / no client / thrown). */
export async function runFoundryScript(script, {
  baseUrl = readEnvOrDotenv('FOUNDRY_BASE_URL') ?? 'https://foundryrestapi.com',
  apiKey = readEnvOrDotenv('FOUNDRY_REST_API_KEY'),
  clientId = readEnvOrDotenv('FOUNDRY_CLIENT_ID'),
  fetchImpl = fetch
} = {}) {
  if (!apiKey) throw new Error('foundry-client: FOUNDRY_REST_API_KEY not set');
  const client = clientId ?? await findOnlineClientId({ baseUrl, apiKey, fetchImpl });
  const res = await fetchImpl(`${baseUrl}/execute-js?clientId=${client}`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ script })
  });
  const body = await res.json();
  if (body.success === false) throw new Error(`foundry-client: script threw: ${body.error ?? 'unknown'}`);
  if (body.error) throw new Error(`foundry-client: ${body.error}`);
  return body.result;
}
