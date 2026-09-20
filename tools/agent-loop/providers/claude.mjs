/**
 * Claude adapter for agent-controlled combat decisions — v1's only
 * provider (Laya tracked separately, #102, blocked on its own setup). Uses
 * tool-use with an enum of exactly the offered candidate ids, so a response
 * can't name something that was never on the list — no freeform-text
 * parsing to get wrong.
 */

const CLAUDE_MODEL = 'claude-sonnet-5';

export async function decide(context, { apiKey = process.env.ANTHROPIC_API_KEY, fetchImpl = fetch } = {}) {
  const candidateIds = context.candidates.map((c) => c.id);
  const body = {
    model: CLAUDE_MODEL,
    max_tokens: 512,
    tools: [{
      name: 'choose_action',
      description: 'Choose exactly one candidate action for this combatant\'s turn.',
      input_schema: {
        type: 'object',
        properties: {
          candidateId: { type: 'string', enum: candidateIds },
          rationale: { type: 'string', description: 'One short sentence explaining the choice.' }
        },
        required: ['candidateId', 'rationale']
      }
    }],
    tool_choice: { type: 'tool', name: 'choose_action' },
    messages: [{
      role: 'user',
      content: `You are controlling an NPC's turn in a Pathfinder 2e combat. Pick the best candidate action.\n\n${JSON.stringify(context, null, 2)}`
    }]
  };

  const res = await fetchImpl('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const payload = await res.json();
  const toolUse = payload.content?.find((c) => c.type === 'tool_use' && c.name === 'choose_action');
  if (!toolUse) throw new Error('claude provider: no choose_action tool call in response');

  const { candidateId, rationale } = toolUse.input;
  if (!candidateIds.includes(candidateId)) {
    throw new Error(`claude provider: candidateId "${candidateId}" was not offered`);
  }
  return { candidateId, rationale };
}
