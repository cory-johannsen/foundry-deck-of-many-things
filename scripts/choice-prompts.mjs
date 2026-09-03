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


/**
 * A card that says "choose several" — Book's languages, for instance.
 *
 * One dialog rather than a run of single-choice prompts: asking eight times in
 * a row for eight languages is a worse experience than one list, and it also
 * keeps the socket round trip to a single exchange when a player is answering.
 *
 * The Apply button stays disabled until exactly the right number is ticked, so
 * an under- or over-filled answer cannot be submitted at all.
 */
export async function promptChooseMany(card, prompt, options, count) {
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const boxes = options.map((o) => `
    <label style="display:block;padding:1px 0;">
      <input type="checkbox" name="pick" value="${esc(o.value)}"> ${esc(o.label)}
    </label>`).join('');

  return DialogV2.wait({
    window: { title: card.name },
    position: { width: 420 },
    content: `
      <form>
        <p>${esc(prompt)}</p>
        <p class="hint" data-counter>Chosen 0 of ${count}.</p>
        <div style="max-height:320px;overflow-y:auto;border:1px solid var(--color-border-light-2);padding:4px;">
          ${boxes}
        </div>
      </form>`,
    buttons: [
      {
        action: 'pick',
        label: game.i18n.localize('DOMMT.GM.Apply'),
        default: true,
        callback: (_e, _b, dialog) => Array.from(
          dialog.element.querySelectorAll('[name="pick"]:checked')).map((i) => i.value)
      },
      { action: 'cancel', label: game.i18n.localize('DOMMT.GM.Cancel') }
    ],
    rejectClose: false,
    render: (_event, dialog) => {
      const root = dialog.element ?? dialog;
      const apply = root.querySelector('button[data-action="pick"]');
      const counter = root.querySelector('[data-counter]');
      const sync = () => {
        const n = root.querySelectorAll('[name="pick"]:checked').length;
        if (counter) counter.textContent = `Chosen ${n} of ${count}.`;
        if (apply) apply.disabled = n !== count;
        // Stop the player ticking past the allowance in the first place.
        for (const box of root.querySelectorAll('[name="pick"]')) {
          box.disabled = !box.checked && n >= count;
        }
      };
      root.querySelectorAll('[name="pick"]').forEach((b) => b.addEventListener('change', sync));
      sync();
    }
  });
}
