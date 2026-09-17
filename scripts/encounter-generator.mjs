/**
 * GM-facing orchestration for "DOMMT: Generate Encounter" — dialog-driven,
 * modelled on scene-divination.mjs's direct-call style rather than the
 * card-effects plan/replay system. That machinery exists to make a single,
 * irreversible draw from the shared depleting play deck previewable; this
 * generator never touches that deck, and its own Accept/Reroll preview
 * dialog already serves the "look before you commit" purpose.
 */
import { makeFoundryApi } from './foundry-api.mjs';
import { buildEncounterDeck, dealEncounter } from './encounter-deck.mjs';
import { resolveEncounterRoster } from './encounter-roster.mjs';
import { loadCreatureArt } from './data-loader.mjs';
import { findCreatureArt, creatureArtPath } from './creature-art.mjs';
import { traitPickerFieldHtml, wireTraitFilters, selectedTraits } from './trait-picker.mjs';

const MODULE_ID = 'deck-of-many-more-things';

function freshSeed() {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function chooseThemeAndSize({ api, prefillTraits = [], prefillExcludeTraits = [] } = {}) {
  const { DialogV2 } = foundry.applications.api;
  const traits = await api.listCreatureTraits();
  return DialogV2.wait({
    window: { title: game.i18n.localize('DOMMT.Encounter.Title') },
    content: `
      <form>
        ${traitPickerFieldHtml({
          name: 'traits', label: game.i18n.localize('DOMMT.Encounter.ThemeLabel'),
          placeholder: game.i18n.localize('DOMMT.Encounter.ThemePlaceholder'), traits, selected: prefillTraits
        })}
        ${traitPickerFieldHtml({
          name: 'excludeTraits', label: game.i18n.localize('DOMMT.Encounter.ExcludeTraitsLabel'),
          placeholder: game.i18n.localize('DOMMT.Encounter.ExcludeTraitsPlaceholder'), traits, selected: prefillExcludeTraits
        })}
      </form>`,
    render: (_event, dialog) => wireTraitFilters(dialog.element),
    buttons: [
      {
        action: 'generate',
        label: game.i18n.localize('DOMMT.Encounter.GenerateButton'),
        default: true,
        callback: (_event, _button, dialog) => ({
          traits: selectedTraits(dialog.element, 'traits'),
          excludeTraits: selectedTraits(dialog.element, 'excludeTraits')
        })
      },
      { action: 'cancel', label: 'Cancel' }
    ],
    rejectClose: false
  });
}

async function showEncounterPreview(roster) {
  const { DialogV2 } = foundry.applications.api;
  const content = await renderTemplate(`modules/${MODULE_ID}/templates/encounter-chat.hbs`, { roster });
  return DialogV2.wait({
    window: { title: game.i18n.localize('DOMMT.Encounter.PreviewTitle') },
    position: { width: 480 },
    content,
    buttons: [
      { action: 'accept', label: game.i18n.localize('DOMMT.Encounter.AcceptButton'), default: true },
      { action: 'reroll', label: game.i18n.localize('DOMMT.Encounter.RerollButton') },
      { action: 'cancel', label: 'Cancel' }
    ],
    rejectClose: false
  });
}

async function postEncounterChatCard(api, roster) {
  const content = await renderTemplate(`modules/${MODULE_ID}/templates/encounter-chat.hbs`, { roster });
  await api.postChatCard({ content, whisperGM: true });
}

/** The party member (by actor id) whose token is on the current scene, to place the encounter near. */
function findFocusActorId(partyMembers) {
  const onScene = new Set((canvas.tokens?.placeables ?? []).map((t) => t.actor?.id).filter(Boolean));
  return partyMembers.find((m) => onScene.has(m.id))?.id ?? partyMembers[0]?.id ?? null;
}

/** Full module-relative art URL for a creature-art.json filename, or null. */
function resolveArt(creatureArt, ref) {
  const filename = findCreatureArt(creatureArt, ref);
  return filename ? `modules/${MODULE_ID}/assets/${creatureArtPath(filename)}` : null;
}

async function spawnEncounterTokens(api, roster, partyMembers, {
  originArea = null, forceHidden = false, extraFlags = null, creatureArt = []
} = {}) {
  const nearActorId = findFocusActorId(partyMembers);
  const place = (hidden) => ({ nearActorId, originArea, extraFlags, hidden: hidden || forceHidden });
  const withArt = (e) => ({ ...e, imgFallback: resolveArt(creatureArt, e) });

  if (roster.foes.length) {
    const entries = roster.foes
      .flatMap((f) => Array(f.count ?? 1).fill({ pack: f.pack, id: f.id }))
      .map(withArt);
    await api.spawnCreatures(entries, { ...place(false), disposition: -1 });
  }
  if (roster.friend) {
    const entries = [withArt({ pack: roster.friend.pack, id: roster.friend.id })];
    await api.spawnCreatures(entries, { ...place(false), disposition: 1 });
  }
  if (roster.twins) {
    const entries = roster.twins.map((t) => withArt({ pack: t.pack, id: t.id }));
    await api.spawnCreatures(entries, { ...place(false), disposition: -1 });
  }
  if (roster.lurker) {
    // Hidden: the book has the lurker ambush once the party is distracted, not
    // stand revealed on the table from the moment the encounter is generated.
    const entries = [withArt({ pack: roster.lurker.pack, id: roster.lurker.id })];
    await api.spawnCreatures(entries, { ...place(true), disposition: -1 });
  }
}

export async function generateEncounter({
  prefillTraits = [], prefillExcludeTraits = [], originArea = null, forceHidden = false, extraFlags = null,
  levelOffsetBias = 0, locationTag = null
} = {}) {
  if (!game.user.isGM) {
    ui.notifications.warn(game.i18n.localize('DOMMT.Encounter.GmOnlyWarning'));
    return;
  }
  if (!canvas?.scene) {
    ui.notifications.warn(game.i18n.localize('DOMMT.Encounter.NoSceneWarning'));
    return;
  }

  const api = makeFoundryApi();
  const creatureArt = await loadCreatureArt();
  const partyLevel = await api.partyLevel();
  const partyMembers = (game.actors?.party?.members ?? []).filter((m) => m.type === 'character');
  const partySize = Math.max(1, partyMembers.length);
  if (!partyMembers.length) {
    ui.notifications.warn(game.i18n.localize('DOMMT.Encounter.PartyTooSmall'));
  }

  const theme = await chooseThemeAndSize({ api, prefillTraits, prefillExcludeTraits });
  if (!theme || theme === 'cancel') return;

  let seed = freshSeed();
  let roster;
  for (;;) {
    const deckSlots = buildEncounterDeck({ seed });
    const dealt = dealEncounter(deckSlots, { seed, partySize });
    roster = await resolveEncounterRoster({
      resolved: dealt.resolved,
      api,
      partyLevel,
      traits: theme.traits,
      excludeTraits: theme.excludeTraits,
      levelOffsetBias,
      requireTrait: locationTag
    });
    const action = await showEncounterPreview(roster);
    if (action === 'accept') break;
    if (action !== 'reroll') return;
    seed = freshSeed();
  }

  await postEncounterChatCard(api, roster);
  await spawnEncounterTokens(api, roster, partyMembers, { originArea, forceHidden, extraFlags, creatureArt });
}
