import { describe, it, expect } from 'vitest';
import { traitOptionsHtml, traitPickerFieldHtml } from '../scripts/trait-picker.mjs';

describe('traitOptionsHtml', () => {
  it('renders one option per trait', () => {
    const html = traitOptionsHtml(['undead', 'goblin']);
    expect(html).toBe('<option value="undead">undead</option><option value="goblin">goblin</option>');
  });

  it('marks selected traits, and only those', () => {
    const html = traitOptionsHtml(['undead', 'goblin', 'fiend'], ['goblin']);
    expect(html).toContain('<option value="goblin" selected>goblin</option>');
    expect(html).toContain('<option value="undead">undead</option>');
    expect(html).toContain('<option value="fiend">fiend</option>');
  });

  it('returns an empty string for no traits', () => {
    expect(traitOptionsHtml([])).toBe('');
  });
});

describe('traitPickerFieldHtml', () => {
  it('includes the label, filter input and select with the given name', () => {
    const html = traitPickerFieldHtml({ name: 'traits', label: 'Favor', traits: ['undead'] });
    expect(html).toContain('<label>Favor</label>');
    expect(html).toContain('data-for="traits"');
    expect(html).toContain('<select name="traits"');
    expect(html).toContain('<option value="undead">undead</option>');
  });

  it('threads selected traits through to the rendered options', () => {
    const html = traitPickerFieldHtml({ name: 'excludeTraits', label: 'Exclude', traits: ['undead', 'fiend'], selected: ['fiend'] });
    expect(html).toContain('<option value="fiend" selected>fiend</option>');
    expect(html).toContain('<option value="undead">undead</option>');
  });
});
