# tools/agent-loop

Polls a live Foundry world for agent-controlled combatants' turns and plays
them via an LLM, instead of ITEM-8's fixed "move toward nearest, strike
once" heuristic. See `docs/superpowers/specs/2026-09-20-agent-bridge-combat-ai-design.md`
for the full design.

## Setup

1. **Self-host the relay** (avoids the public `foundryrestapi.com` relay's
   100 requests/month free-tier limit — this polls every few seconds):
   ```bash
   git clone https://github.com/ThreeHats/foundryvtt-rest-api-relay
   cd foundryvtt-rest-api-relay
   docker compose up -d
   ```
   Point Foundry's own `foundryvtt-rest-api` module at this relay instead of
   the public one (module settings → Relay URL).

2. **Environment variables** (a `.env` in the repo root, or the shell
   environment):
   ```
   FOUNDRY_BASE_URL=http://localhost:<your relay port>
   FOUNDRY_REST_API_KEY=<your relay's key>
   ANTHROPIC_API_KEY=<your Claude API key>
   ```
   `FOUNDRY_CLIENT_ID` and `DOMMT_AGENT_PROVIDER` (default `claude`) and
   `DOMMT_POLL_INTERVAL_MS` (default `3000`) are optional overrides.

3. **Run it** alongside your Foundry session:
   ```bash
   node tools/agent-loop/poll.mjs
   ```

Leave it running for the length of a session. If it's not running (or
crashes), agent-controlled combatants still act — Foundry falls back to the
default heuristic after `AGENT_TIMEOUT_MS` (45s) and tells you so in chat.
