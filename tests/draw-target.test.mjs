import { describe, it, expect } from 'vitest';
import { resolveDrawActor } from '../scripts/draw-target.mjs';
import { pendingKind } from '../scripts/gm-resolution.mjs';

const token = (actor) => ({ actor });
const actorsMap = (entries) => new Map(entries);

describe('resolveDrawActor — a player draws for themselves', () => {
  it('uses the assigned character, ignoring any selected token', () => {
    const assigned = { id: 'pc', name: 'Mira' };
    const r = resolveDrawActor({
      isGM: false,
      canvasRef: { tokens: { controlled: [token({ id: 'other' })] } },
      userRef: { character: assigned }
    });
    expect(r.actor).toBe(assigned);
    expect(r.source).toBe('assigned');
  });

  it('falls back to a controlled token when no character is assigned', () => {
    const tok = { id: 't1' };
    const r = resolveDrawActor({
      isGM: false,
      canvasRef: { tokens: { controlled: [token(tok)] } },
      userRef: { character: null }
    });
    expect(r.actor).toBe(tok);
    expect(r.source).toBe('token');
  });

  it('resolves to nothing when the player has neither', () => {
    const r = resolveDrawActor({
      isGM: false,
      canvasRef: { tokens: { controlled: [] } },
      userRef: { character: null }
    });
    expect(r.actor).toBeNull();
    expect(r.source).toBe('none');
  });
});

describe('resolveDrawActor — a GM draws on someone\'s behalf', () => {
  it('uses the selected token', () => {
    const tok = { id: 'sel', name: 'Vex' };
    const r = resolveDrawActor({
      isGM: true,
      canvasRef: { tokens: { controlled: [token(tok)] } },
      userRef: { character: { id: 'gm-char' } }
    });
    expect(r.actor).toBe(tok);
    expect(r.source).toBe('token');
  });

  it('ignores the GM\'s own assigned character', () => {
    const r = resolveDrawActor({
      isGM: true,
      canvasRef: { tokens: { controlled: [] } },
      userRef: { character: { id: 'gm-char' } }
    });
    expect(r.actor).toBeNull();
    expect(r.source).toBe('none');
  });

  it('resolves to nothing with no selection, deferring the choice to apply time', () => {
    const r = resolveDrawActor({
      isGM: true,
      canvasRef: { tokens: { controlled: [] } },
      userRef: { character: null }
    });
    expect(r.actor).toBeNull();
  });

  it('skips controlled tokens carrying no actor', () => {
    const real = { id: 'a9' };
    const r = resolveDrawActor({
      isGM: true,
      canvasRef: { tokens: { controlled: [token(null), token(real)] } },
      userRef: { character: null }
    });
    expect(r.actor).toBe(real);
  });

  it('flags an ambiguous selection without refusing to act', () => {
    const first = { id: 'a1' };
    const r = resolveDrawActor({
      isGM: true,
      canvasRef: { tokens: { controlled: [token(first), token({ id: 'a2' })] } },
      userRef: { character: null }
    });
    expect(r.actor).toBe(first);
    expect(r.ambiguous).toBe(true);
  });
});

describe('resolveDrawActor — explicit override', () => {
  it('honours an explicit actorId from the scripting API', () => {
    const wanted = { id: 'x1', name: 'Scripted' };
    const r = resolveDrawActor({
      actorId: 'x1',
      isGM: true,
      canvasRef: { tokens: { controlled: [token({ id: 'selected' })] } },
      userRef: { character: null },
      actorsRef: actorsMap([['x1', wanted]])
    });
    expect(r.actor).toBe(wanted);
    expect(r.source).toBe('explicit');
  });

  it('ignores an actorId that no longer exists and falls through', () => {
    const tok = { id: 'sel' };
    const r = resolveDrawActor({
      actorId: 'deleted',
      isGM: true,
      canvasRef: { tokens: { controlled: [token(tok)] } },
      userRef: { character: null },
      actorsRef: actorsMap([])
    });
    expect(r.actor).toBe(tok);
  });

  it('survives a missing canvas, user and actor collection', () => {
    const r = resolveDrawActor({ isGM: true, canvasRef: null, userRef: null, actorsRef: null });
    expect(r.actor).toBeNull();
    expect(r.source).toBe('none');
  });
});

describe('pendingKind', () => {
  it('routes an ability choice to its own prompt', () => {
    expect(pendingKind({ requires: 'choose_ability', delta: 1 })).toBe('choose_ability');
  });

  it('treats everything else as an acknowledgement', () => {
    expect(pendingKind({ kind: 'gm_only' })).toBe('acknowledge');
    expect(pendingKind(null)).toBe('acknowledge');
    expect(pendingKind(undefined)).toBe('acknowledge');
  });
});
