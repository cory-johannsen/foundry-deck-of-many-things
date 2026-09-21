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

   **To use Laya instead of Claude** (`DOMMT_AGENT_PROVIDER=laya`), add:

   ```
   LAYA_API_KEY=<your Laya deployment's key, if auth is enabled>
   LAYA_BASE_URL=<your Laya deployment, default https://laya.johannsen.cloud>
   ```

   Laya never generates a `rationale` (it's non-autoregressive, calibrated
   probabilities only) — decisions still work, just without the "why" text
   Claude's adapter includes.

3. **Run it** alongside your Foundry session:
   ```bash
   node tools/agent-loop/poll.mjs
   ```

Leave it running for the length of a session. If it's not running (or
crashes), agent-controlled combatants still act — Foundry falls back to the
default heuristic after `AGENT_TIMEOUT_MS` (45s) and tells you so in chat,
distinguishing "the poller is running but didn't respond in time" from "the
poller doesn't appear to be running at all" (#113) using the heartbeat
below.

## Checking whether it's actually running (#113)

The poller pings a heartbeat into the world once per loop iteration, so a
GM can check its status without watching this terminal: click the robot
icon in the token scene controls, or run
`game.modules.get('deck-of-many-more-things').api.postAgentLoopStatus()`
from the console. Both post a GM-whispered chat card saying whether it's
connected, stale (was running, hasn't checked in recently), or never seen
this session.

## If it stops recovering after a relay hiccup (#115)

Every request sends `Connection: close`, so a dropped-then-restored relay
connection can't leave the poller stuck reusing a dead pooled socket — each
retry opens a fresh connection instead. If it still won't recover after a
relay blip, the terminal logs a louder warning once 10 poll cycles in a row
have failed; at that point, restarting the process (`Ctrl-C`, then
`node tools/agent-loop/poll.mjs` again) is the known-working fix.

## Trap flavor customization (#136)

Once per loop iteration, the poller also checks for a newly spawned,
still-hidden trap (#135) waiting to be customized, and — if
`ANTHROPIC_API_KEY` is configured — asks Claude to rewrite its name and
flavor text to fit the room, before the party ever reaches its door. This
is **always Claude, regardless of `DOMMT_AGENT_PROVIDER`**: Laya is a
classifier over a fixed candidate set, not a text generator, so it can't do
this at all. If the key isn't configured, or nothing responds before the
room's reveal door opens, the trap just keeps its original compendium name
and description — the same graceful degradation the combat-AI half already
relies on, and never anything that blocks room reveal or discovery.

## Skill-challenge flavor customization (#166)

Same idea as trap customization, for a `skill_challenge` room's own name,
summary, and per-skill flavor text — also always Claude, also silently
skipped without `ANTHROPIC_API_KEY`. The one real difference: a trap is
spawned hidden, with a genuine window to customize it before the party
ever sees it; a skill-challenge room's content is shown the instant the
room becomes current, so there's no such window here — the party may see
the un-customized name/summary first and see it change in place once (and
if) the agent's customization lands and something re-renders the Dungeon
Crawl tracker. Accepted as the honest trade-off rather than blocking room
display on it, same as every other use of this infrastructure.
