#!/usr/bin/env node
/**
 * Builds a static HTML page showing every card's finished art, for visual
 * review after a regeneration pass. Reads data/cards.json directly so it
 * never goes stale relative to the deck; nothing about it is specific to any
 * one art pipeline or model.
 *
 * Usage:
 *   node tools/build-gallery.mjs               # writes card-gallery.html
 *   node tools/build-gallery.mjs --out foo.html
 *
 * Open the result directly in a browser (file://) from the repo root — image
 * paths are relative, same as art.front elsewhere in the pipeline.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

const args = process.argv.slice(2);
const arg = (n, dflt) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : dflt;
};
const OUT = arg('--out', 'card-gallery.html');

const cards = JSON.parse(readFileSync(resolve(root, 'data/cards.json'), 'utf8'));

const SET_LABELS = { classic: 'Classic 22', expansion: 'Expansion 44' };

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cardTile(c) {
  const src = esc(c.art?.front || '');
  return `      <figure class="card" data-set="${esc(c.set)}" data-name="${esc(c.name.toLowerCase())}">
        <img src="${src}" alt="${esc(c.name)}" loading="lazy">
        <figcaption>
          <span class="num">#${c.number}</span>
          <span class="name">${esc(c.name)}</span>
        </figcaption>
      </figure>`;
}

function section(setKey, label, list) {
  const tiles = list
    .sort((a, b) => a.number - b.number)
    .map(cardTile)
    .join('\n');
  return `    <section>
      <h2>${esc(label)} <span class="count">(${list.length})</span></h2>
      <div class="grid">
${tiles}
      </div>
    </section>`;
}

const bySet = {};
for (const c of cards) (bySet[c.set] ??= []).push(c);

const sections = Object.keys(SET_LABELS)
  .filter((k) => bySet[k]?.length)
  .map((k) => section(k, SET_LABELS[k], bySet[k]))
  .join('\n');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Card Gallery</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 24px 32px 64px;
    background: #14100c;
    color: #e8ddc8;
    font-family: Georgia, 'Times New Roman', serif;
  }
  h1 { font-size: 1.6rem; letter-spacing: 0.04em; margin: 0 0 4px; }
  .sub { color: #a6957a; margin: 0 0 28px; font-size: 0.9rem; }
  h2 { font-size: 1.1rem; letter-spacing: 0.03em; border-bottom: 1px solid #3a3025; padding-bottom: 8px; margin: 32px 0 16px; }
  .count { color: #7a6c56; font-weight: normal; font-size: 0.85em; }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 16px;
  }
  .card {
    margin: 0; background: #1d1712; border: 1px solid #3a3025; border-radius: 6px;
    overflow: hidden; transition: transform 0.12s ease, border-color 0.12s ease;
  }
  .card:hover { transform: translateY(-2px); border-color: #7a6440; }
  .card img { width: 100%; aspect-ratio: 683 / 1013; object-fit: cover; display: block; background: #0a0806; }
  .card figcaption { padding: 6px 8px 8px; display: flex; justify-content: space-between; align-items: baseline; gap: 6px; }
  .card .num { color: #7a6c56; font-size: 0.75rem; }
  .card .name { font-size: 0.85rem; text-align: right; }
  .card.hidden { display: none; }
  #filter {
    background: #1d1712; border: 1px solid #3a3025; color: #e8ddc8;
    padding: 8px 12px; border-radius: 6px; font: inherit; font-size: 0.9rem;
    width: 260px; max-width: 100%;
  }
  #filter::placeholder { color: #7a6c56; }
</style>
</head>
<body>
  <h1>Deck of Many More Things — Card Gallery</h1>
  <p class="sub">${cards.length} cards · generated from data/cards.json</p>
  <input id="filter" type="search" placeholder="Filter by name…" autofocus>
${sections}
  <script>
    const input = document.getElementById('filter');
    const cards = Array.from(document.querySelectorAll('.card'));
    input.addEventListener('input', () => {
      const q = input.value.trim().toLowerCase();
      for (const c of cards) c.classList.toggle('hidden', q && !c.dataset.name.includes(q));
    });
  </script>
</body>
</html>
`;

writeFileSync(resolve(root, OUT), html);
console.log(`Wrote ${OUT} (${cards.length} cards)`);
