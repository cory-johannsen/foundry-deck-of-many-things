/**
 * The abstract "dungeon crawl" sequence — a linear generalization of the
 * sourcebook's Journey Spread (a Challenge card each day, then a card read as
 * a Reward or a Ruin depending on how the challenge went) into rooms instead
 * of days, ending in a goal/boss room. Kept free of any Foundry dependency,
 * same split as encounter-deck.mjs, so the sequencing/outcome rules are fully
 * unit-testable.
 *
 * Room kinds and outcomes are picked by a seeded hash of the room's own index
 * rather than a pre-shuffled fixed-length array, so growing the sequence
 * later (Extra Travel Time inserting a room) never disturbs rooms already
 * handed to the table.
 */
import { splitmix32, seedFromString, shuffle } from './prng.mjs';

// Tunable, with no anchor in the source material — unlike the encounter
// deck's XP table, the Journey Spread never specifies a room-kind mix.
export const ROOM_KIND_WEIGHTS = [
  { kind: 'combat', weight: 5 },
  { kind: 'skill_challenge', weight: 2 },
  { kind: 'puzzle_or_trap', weight: 2 },
  { kind: 'narrative', weight: 1 }
];

// Each slot pairs a Reward meaning (the challenge was handled well) with a
// Ruin meaning (handled poorly), read off the SAME drawn slot — the book
// never fixes a Reward/Ruin correspondence, so these pairings are a tunable,
// thematic choice that covers all 4 rewards and all 5 ruins from the Journey
// Spread. `mutation` describes what a resolution does to the room sequence
// or the encounter flow; absent means "flavor only, no mechanical effect."
export const OUTCOME_SLOT_TEMPLATES = [
  {
    id: 'aid_or_ambush',
    reward: { key: 'friendly_aid' },
    ruin: { key: 'encounter', mutation: 'rerun_encounter' }
  },
  {
    id: 'rest_or_ruin',
    reward: { key: 'ready_foraging' },
    ruin: { key: 'restless_night' }
  },
  {
    id: 'pace',
    reward: { key: 'reduced_travel_time', mutation: 'remove_next' },
    ruin: { key: 'extra_travel_time', mutation: 'insert_after' }
  },
  {
    id: 'loot_or_loss',
    reward: { key: 'treasure' },
    ruin: { key: 'lost_gear' }
  },
  {
    id: 'cost_of_loot',
    reward: { key: 'treasure' },
    ruin: { key: 'exhaustion' }
  }
];

export function findOutcomeTemplate(id) {
  return OUTCOME_SLOT_TEMPLATES.find((t) => t.id === id) ?? null;
}

function weightedPick(items, r) {
  const weights = items.map((it) => it.weight ?? 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let x = r * total;
  for (let i = 0; i < items.length; i += 1) {
    x -= weights[i];
    if (x < 0) return items[i];
  }
  return items[items.length - 1];
}

function pickAt(seed, salt, items) {
  const r = splitmix32(seedFromString(`${seed}-${salt}`))();
  return weightedPick(items, r);
}

/** The room kind at a given absolute room index, deterministic per seed. */
export function roomKindAt(seed, index) {
  return pickAt(seed, `kind-${index}`, ROOM_KIND_WEIGHTS).kind;
}

/** The outcome-slot template at a given absolute room index. */
export function outcomeSlotAt(seed, index) {
  return pickAt(seed, `outcome-${index}`, OUTCOME_SLOT_TEMPLATES);
}

/**
 * The set-piece for the Nth puzzle_or_trap room encountered in a run (0
 * indexed by occurrence, not by absolute room index). `setpieceIds` is
 * shuffled once per seed, then cycled by occurrence, so a short dungeon
 * rarely repeats a set-piece and a long one cycles rather than repeating the
 * same one back-to-back. Returns null when no set-pieces are available.
 */
export function setpieceAt(seed, occurrenceIndex, setpieceIds) {
  if (!setpieceIds?.length) return null;
  const rand = splitmix32(seedFromString(`${seed}-setpiece-order`));
  const order = shuffle(setpieceIds, rand);
  return order[occurrenceIndex % order.length];
}

/**
 * Build a fresh linear room sequence. `roomCount` includes the goal room, so
 * it must be at least 2. The last room is always a combat room flagged
 * `isGoal: true` with no outcome slot — the climactic fight, and the end of
 * the line for reward/ruin resolution.
 */
export function buildRoomSequence({ seed, roomCount, setpieceIds = [] }) {
  if (!Number.isInteger(roomCount) || roomCount < 2) {
    throw new Error('roomCount must be an integer of at least 2 (rooms plus a goal room)');
  }
  const rooms = [];
  let puzzleOccurrence = 0;
  for (let i = 0; i < roomCount - 1; i += 1) {
    const kind = roomKindAt(seed, i);
    const setpieceId = kind === 'puzzle_or_trap' ? setpieceAt(seed, puzzleOccurrence++, setpieceIds) : null;
    const outcomeSlot = outcomeSlotAt(seed, i);
    rooms.push({ id: `room-${i}`, kind, isGoal: false, setpieceId, outcomeSlotId: outcomeSlot.id });
  }
  rooms.push({
    id: `room-${roomCount - 1}`,
    kind: 'combat',
    isGoal: true,
    setpieceId: null,
    outcomeSlotId: null
  });
  return rooms;
}

/**
 * Resolve one non-goal room's outcome slot against how its challenge went.
 * Exported separately from the sequence builder (like encounter-deck.mjs's
 * resolveDraws) so each of the 9 reward/ruin branches can be tested directly
 * against a hand-picked template instead of fighting the seeded picks.
 */
export function resolveRoomOutcome(outcomeSlotTemplate, succeeded) {
  const branch = succeeded ? outcomeSlotTemplate.reward : outcomeSlotTemplate.ruin;
  return { effectKey: branch.key, mutation: branch.mutation ?? null };
}

/**
 * Apply a reward/ruin's sequence mutation. Pure — returns a new rooms array,
 * or the same array reference when there is nothing to do. Never removes or
 * inserts past the goal room: `remove_next` is a no-op if the next room is
 * the goal, and `insert_after` always lands strictly before it since the
 * goal room is never `currentIndex`'s neighbour once it's still ahead.
 */
export function applySequenceMutation(rooms, currentIndex, mutation, { seed, setpieceIds = [] } = {}) {
  if (mutation === 'remove_next') {
    const next = rooms[currentIndex + 1];
    if (!next || next.isGoal) return rooms;
    return [...rooms.slice(0, currentIndex + 1), ...rooms.slice(currentIndex + 2)];
  }
  if (mutation === 'insert_after') {
    const salt = `extra-${currentIndex}-${rooms.length}`;
    const kind = pickAt(seed, `${salt}-kind`, ROOM_KIND_WEIGHTS).kind;
    const outcomeTemplate = pickAt(seed, `${salt}-outcome`, OUTCOME_SLOT_TEMPLATES);
    const setpieceId = kind === 'puzzle_or_trap' ? setpieceAt(seed, rooms.length, setpieceIds) : null;
    const newRoom = {
      id: `room-${salt}`,
      kind,
      isGoal: false,
      setpieceId,
      outcomeSlotId: outcomeTemplate.id
    };
    return [...rooms.slice(0, currentIndex + 1), newRoom, ...rooms.slice(currentIndex + 1)];
  }
  return rooms;
}
