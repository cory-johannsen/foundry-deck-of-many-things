/**
 * The dialogs a card uses to ask a question.
 *
 * Shared because either side of the table may be answering: the GM resolving a
 * card, or the player whose character it landed on, prompted across a socket.
 * Both must see the same question.
 */
const ABILITIES = [
  ['str', 'Strength'], ['dex', 'Dexterity'], ['con', 'Constitution'],
  ['int', 'Intelligence'], ['wis', 'Wisdom'], ['cha', 'Charisma']
];


export async function promptChooseAbility(card, delta) {
  const { DialogV2 } = foundry.applications.api;
  const options = ABILITIES
    .map(([k, label]) => `<option value="${k}">${label}</option>`).join('');
  return DialogV2.wait({
    window: { title: card.name },
    content: `
      <form>
        <p>${game.i18n.format('DOMMT.GM.ChooseAbility.Prompt', { delta })}</p>
        <div class="form-group">
          <label>${game.i18n.localize('DOMMT.GM.ChooseAbility.Label')}</label>
          <select name="ability" style="width:100%;">${options}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: 'apply',
        label: game.i18n.localize('DOMMT.GM.Apply'),
        default: true,
        callback: (_e, _b, dialog) => dialog.element.querySelector('[name="ability"]').value
      },
      { action: 'cancel', label: game.i18n.localize('DOMMT.GM.Cancel') }
    ],
    rejectClose: false
  });
}

/**
 * A card that says "choose one" — which element, which hoard, XP or draws.
 * The options come from the handler, so a new choice needs no new dialog.
 */
export async function promptChooseOption(card, prompt, options) {
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const html = options
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join('');
  return DialogV2.wait({
    window: { title: card.name },
    content: `
      <form>
        <p>${esc(prompt)}</p>
        <div class="form-group">
          <select name="choice" style="width:100%;">${html}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: 'pick',
        label: game.i18n.localize('DOMMT.GM.Apply'),
        default: true,
        callback: (_e, _b, dialog) => dialog.element.querySelector('[name="choice"]').value
      },
      { action: 'cancel', label: game.i18n.localize('DOMMT.GM.Cancel') }
    ],
    rejectClose: false
  });
}

