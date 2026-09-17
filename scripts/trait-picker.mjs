/**
 * A filterable multi-select for picking real creature traits, instead of a
 * free-text field. A typed word that isn't an actual trait (e.g. "castle", a
 * setting rather than a creature trait) used to silently match nothing —
 * this makes an invalid pick impossible instead of failing quietly later.
 *
 * Plain `<select multiple>` plus a text filter that hides non-matching
 * `<option>`s, wired up post-render (DialogV2's `render` hook and
 * ApplicationV2's `_onRender` both hand back the live element the same way
 * every other dialog in this module already reads form values from).
 */
export function traitOptionsHtml(traits, selected = []) {
  return traits
    .map((t) => `<option value="${t}"${selected.includes(t) ? ' selected' : ''}>${t}</option>`)
    .join('');
}

export function traitPickerFieldHtml({ name, label, placeholder = '', traits, selected = [] }) {
  return `
    <div class="form-group">
      <label>${label}</label>
      <input type="text" class="dommt-trait-filter" data-for="${name}" placeholder="${placeholder}" />
      <select name="${name}" multiple size="8" style="width:100%;">${traitOptionsHtml(traits, selected)}</select>
    </div>`;
}

export function wireTraitFilters(root) {
  root.querySelectorAll('.dommt-trait-filter').forEach((input) => {
    input.addEventListener('input', () => {
      const select = root.querySelector(`select[name="${input.dataset.for}"]`);
      if (!select) return;
      const q = input.value.trim().toLowerCase();
      for (const opt of select.options) opt.hidden = q.length > 0 && !opt.value.includes(q);
    });
  });
}

export function selectedTraits(root, name) {
  const select = root.querySelector(`select[name="${name}"]`);
  return select ? Array.from(select.selectedOptions).map((o) => o.value) : [];
}
