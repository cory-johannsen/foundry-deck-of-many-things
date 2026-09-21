/**
 * Claude adapter for agent-controlled combat decisions — v1's only
 * provider (Laya tracked separately, #102, blocked on its own setup). Uses
 * tool-use with an enum of exactly the offered candidate ids, so a response
 * can't name something that was never on the list — no freeform-text
 * parsing to get wrong.
 *
 * Also the *only* provider `customizeTrap` (#136) can ever use, full stop
 * — not gated by `DOMMT_AGENT_PROVIDER` the way `decide` is. Laya is
 * non-autoregressive (calibrated probabilities over a fixed candidate set,
 * per `tools/agent-loop/README.md`), which is exactly what makes it usable
 * for `decide`'s "pick one of these" shape and exactly what makes it
 * structurally unable to do `customizeTrap`'s "write new prose" shape at
 * all — there's no candidate set to score. `tools/agent-loop/poll.mjs`
 * imports `customizeTrap` directly from this file rather than through
 * `providers/index.mjs`'s `resolveProvider`, and simply skips trap
 * customization for a cycle if `ANTHROPIC_API_KEY` isn't configured, same
 * as it would skip a combat decision it couldn't reach.
 */

import { readEnvOrDotenv } from "../foundry-client.mjs";

const CLAUDE_MODEL = "claude-sonnet-5";

async function callClaude(
  body,
  { apiKey = readEnvOrDotenv("ANTHROPIC_API_KEY"), fetchImpl = fetch } = {},
) {
  const res = await fetchImpl("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  if (!res.ok) {
    throw new Error(
      `claude provider: API request failed (${res.status}): ${payload?.error?.message ?? "unknown error"}`,
    );
  }
  return payload;
}

export async function decide(context, opts = {}) {
  const candidateIds = context.candidates.map((c) => c.id);
  const payload = await callClaude(
    {
      model: CLAUDE_MODEL,
      // Generous headroom above the ~50-100 tokens the tool_use block itself
      // needs: claude-sonnet-5's adaptive thinking tokens count against
      // max_tokens too, and with no explicit thinking/effort configuration a
      // small budget can be entirely consumed before the forced tool_use
      // block is ever emitted — surfacing as the same misleading "no
      // choose_action tool call" error below, just from a different cause.
      max_tokens: 4096,
      tools: [
        {
          name: "choose_action",
          description:
            "Choose exactly one candidate action for this combatant's turn.",
          input_schema: {
            type: "object",
            properties: {
              candidateId: { type: "string", enum: candidateIds },
              rationale: {
                type: "string",
                description: "One short sentence explaining the choice.",
              },
            },
            required: ["candidateId", "rationale"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "choose_action" },
      messages: [
        {
          role: "user",
          content: `You are controlling an NPC's turn in a Pathfinder 2e combat. Pick the best candidate action.\n\n${JSON.stringify(context, null, 2)}`,
        },
      ],
    },
    opts,
  );

  const toolUse = payload.content?.find(
    (c) => c.type === "tool_use" && c.name === "choose_action",
  );
  if (!toolUse)
    throw new Error("claude provider: no choose_action tool call in response");

  const { candidateId, rationale } = toolUse.input;
  if (!candidateIds.includes(candidateId)) {
    throw new Error(
      `claude provider: candidateId "${candidateId}" was not offered`,
    );
  }
  return { candidateId, rationale };
}

/**
 * `context` is `getPendingTrapCustomization`'s own return shape (name,
 * description, trapLevel, locationTag, partyLevel) — deliberately never
 * the trap's mechanical data (`system.details.disable`/`system.actions`),
 * so nothing in this prompt can even suggest changing how the trap
 * actually works, only how it reads. Returns `{name, description}`.
 */
export async function customizeTrap(context, opts = {}) {
  const payload = await callClaude(
    {
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      tools: [
        {
          name: "customize_trap",
          description:
            "Write a new name and flavor description for this trap, fitting the room and party — never its mechanics, only how it reads.",
          input_schema: {
            type: "object",
            properties: {
              name: {
                type: "string",
                description:
                  "A short, evocative name for this specific trap instance.",
              },
              description: {
                type: "string",
                description:
                  "A short paragraph describing what the party perceives/experiences discovering or triggering it, matching the room's terrain/theme. Do not state exact DCs, damage, or other mechanical numbers.",
              },
            },
            required: ["name", "description"],
          },
        },
      ],
      tool_choice: { type: "tool", name: "customize_trap" },
      messages: [
        {
          role: "user",
          content: `You are dressing a mechanical trap for a Pathfinder 2e dungeon room in fresh narrative flavor, without changing anything about how it actually works — only its name and flavor text. Base trap:\n\n${JSON.stringify(context, null, 2)}\n\nWrite a new name and description matching the room's own terrain/theme, not the base template's generic text.`,
        },
      ],
    },
    opts,
  );

  const toolUse = payload.content?.find(
    (c) => c.type === "tool_use" && c.name === "customize_trap",
  );
  if (!toolUse)
    throw new Error("claude provider: no customize_trap tool call in response");
  return toolUse.input;
}
