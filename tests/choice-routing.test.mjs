import { describe, it, expect } from 'vitest';
import { whoDecides } from '../scripts/choice-routing.mjs';

const gm = { id: 'gm', name: 'GM', isGM: true, active: true };
const player = (over = {}) => ({ id: 'p1', name: 'Mira', isGM: false, active: true, ...over });

/** An actor owned by whoever is listed, using raw ownership levels. */
const actorOf = (ownership = {}, id = 'a1') => ({ id, ownership: { default: 0, ...ownership } });

describe('whoDecides — the player answers for their own character', () => {
  it('routes to the owning player', () => {
    const p = player();
    const r = whoDecides({ actor: actorOf({ p1: 3 }), users: [gm, p] });
    expect(r.user).toBe(p);
    expect(r.reason).toBe('player-owned');
  });

  it('routes to the player whose assigned character it is', () => {
    const actor = actorOf({ p1: 3, p2: 3 });
    const other = player({ id: 'p2', name: 'Vex', character: { id: 'a1' } });
    const r = whoDecides({ actor, users: [gm, player(), other] });
    expect(r.user).toBe(other);
  });

  it('honours an assigned character even without an ownership entry', () => {
    const p = player({ character: { id: 'a1' } });
    expect(whoDecides({ actor: actorOf(), users: [gm, p] }).user).toBe(p);
  });

  it('uses Foundry\'s own permission check when it is available', () => {
    const p = player();
    const actor = { id: 'a1', testUserPermission: (u, lvl) => u.id === 'p1' && lvl === 'OWNER' };
    expect(whoDecides({ actor, users: [gm, p] }).user).toBe(p);
  });
});

describe('whoDecides — the GM answers otherwise', () => {
  it('keeps the decision for an actor no player owns', () => {
    const r = whoDecides({ actor: actorOf(), users: [gm, player()] });
    expect(r.user).toBeNull();
    expect(r.reason).toBe('gm-owned');
  });

  it('keeps the decision when the owner is offline', () => {
    // A card must not stall waiting for someone who went home.
    const r = whoDecides({ actor: actorOf({ p1: 3 }), users: [gm, player({ active: false })] });
    expect(r.user).toBeNull();
    expect(r.reason).toBe('owner-offline');
  });

  it('never routes to a GM, even one who owns the actor', () => {
    const owningGm = { ...gm, id: 'gm', character: { id: 'a1' } };
    const r = whoDecides({ actor: actorOf({ gm: 3 }), users: [owningGm] });
    expect(r.user).toBeNull();
  });

  it('copes with no actor and no users', () => {
    expect(whoDecides({ actor: null, users: [] }).user).toBeNull();
    expect(whoDecides({}).user).toBeNull();
  });

  it('treats observer-level access as not owning', () => {
    // Ownership 2 is OBSERVER; only 3 (OWNER) may answer for the character.
    const r = whoDecides({ actor: actorOf({ p1: 2 }), users: [gm, player()] });
    expect(r.user).toBeNull();
  });

  it('respects a world-wide default ownership of OWNER', () => {
    const r = whoDecides({ actor: actorOf({ default: 3 }), users: [gm, player()] });
    expect(r.user?.id).toBe('p1');
  });
});
