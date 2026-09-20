#!/usr/bin/env node
/**
 * Polls the live Foundry world (via the self-hosted foundry-rest relay) for
 * an agent-controlled combatant's due turn, asks the configured provider
 * which candidate to take, and applies it — repeating until that turn is
 * over, then waiting POLL_INTERVAL_MS before checking again. No Foundry
 * mutation happens anywhere in this file except through
 * module.api.applyAgentDecision.
 *
 * Run: node tools/agent-loop/poll.mjs
 * Requires: FOUNDRY_REST_API_KEY, FOUNDRY_BASE_URL (your self-hosted relay),
 * ANTHROPIC_API_KEY — see README.md.
 */
import { runFoundryScript } from './foundry-client.mjs';
import { resolveProvider } from './providers/index.mjs';

const POLL_INTERVAL_MS = Number(process.env.DOMMT_POLL_INTERVAL_MS ?? 3000);
const MODULE_ID = 'deck-of-many-more-things';

async function getPendingTurn() {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.getPendingAgentTurn();`
  );
}

async function applyDecision(combatId, combatantId, candidateId) {
  return runFoundryScript(
    `return game.modules.get('${MODULE_ID}').api.applyAgentDecision(${JSON.stringify(combatId)}, ${JSON.stringify(combatantId)}, ${JSON.stringify(candidateId)});`
  );
}

async function playOnePendingTurnToCompletion(decide) {
  let pending = await getPendingTurn();
  while (pending) {
    let decision;
    try {
      decision = await decide(pending.context, { fetchImpl: fetch });
    } catch (err) {
      console.error('agent-loop: provider error, skipping this cycle:', err.message);
      return; // let Foundry's own per-action timeout fallback handle it
    }
    console.log(`agent-loop: chose ${decision.candidateId} (${decision.rationale ?? 'no rationale'})`);
    try {
      pending = await applyDecision(pending.combatId, pending.combatantId, decision.candidateId);
    } catch (err) {
      console.error('agent-loop: applyAgentDecision failed, skipping this cycle:', err.message);
      return;
    }
  }
}

async function main() {
  const decide = resolveProvider();
  console.log(`agent-loop: polling every ${POLL_INTERVAL_MS}ms with provider "${process.env.DOMMT_AGENT_PROVIDER ?? 'claude'}"`);
  for (;;) {
    try {
      await playOnePendingTurnToCompletion(decide);
    } catch (err) {
      console.error('agent-loop: poll cycle failed, will retry:', err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

main();
