#!/usr/bin/env python3
"""Build a review contact sheet of the composed cards.

Every card at thumbnail size on one scrollable page, with its name and the
flavor text it is supposed to depict, so scene mismatches are judgable without
cross-referencing cards.json. Images are embedded as data URIs, so the page is
self-contained and opens straight from disk.

Usage:
  python3 tools/contact_sheet.py [out.html]
"""
import base64
import html
import io
import json
import pathlib
import sys

from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
CARDS = json.loads((ROOT / 'data/cards.json').read_text())
SRC = ROOT / 'assets/cards-labeled'
THUMB_W = 300


def thumb(path):
    im = Image.open(path).convert('RGB')
    im = im.resize((THUMB_W, round(im.height * THUMB_W / im.width)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, 'JPEG', quality=82, optimize=True)
    return 'data:image/jpeg;base64,' + base64.b64encode(buf.getvalue()).decode()


def main():
    out = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / 'docs/card-contact-sheet.html'
    tiles, missing = [], []
    for card in CARDS:
        p = SRC / f"{card['id']}.png"
        if not p.exists():
            missing.append(card['id'])
            continue
        tiles.append(
            '<figure>'
            f'<img src="{thumb(p)}" alt="{html.escape(card["name"])}">'
            f'<figcaption><b>{html.escape(card["name"])}</b>'
            f'<span>{html.escape(card["flavor"])}</span></figcaption>'
            '</figure>')

    note = ''
    if missing:
        note = (f'<p class="warn">Not yet composed ({len(missing)}): '
                f'{html.escape(", ".join(missing))}</p>')

    page = f"""<!doctype html>
<meta charset="utf-8">
<title>Card Contact Sheet</title>
<style>
  :root {{ color-scheme: dark; }}
  body {{ background:#0F1418; color:#E9E2D2; margin:0; padding:2rem 1.5rem 4rem;
         font:15px/1.55 "IBM Plex Sans",system-ui,sans-serif; }}
  h1 {{ font:600 2rem/1.1 "Cormorant Garamond",Georgia,serif; margin:0 0 .3rem; letter-spacing:.02em; }}
  .sub {{ color:#8E9BA4; margin:0 0 2rem; }}
  .warn {{ color:#B4644E; margin:0 0 1.5rem; }}
  .grid {{ display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr));
           gap:1.75rem; max-width:1500px; margin:0 auto; }}
  figure {{ margin:0; display:flex; flex-direction:column; gap:.6rem; }}
  img {{ width:100%; height:auto; display:block; border-radius:2px;
         box-shadow:0 10px 26px -12px rgba(0,0,0,.7); }}
  figcaption {{ display:flex; flex-direction:column; gap:.25rem; }}
  figcaption b {{ font:600 1.15rem/1.2 "Cormorant Garamond",Georgia,serif;
                  letter-spacing:.08em; text-transform:uppercase; }}
  figcaption span {{ color:#8E9BA4; font-size:.82rem; }}
</style>
<h1>Card Contact Sheet</h1>
<p class="sub">{len(tiles)} composed cards. The grey line under each name is the flavor text the
art is meant to depict &mdash; compare them to spot scene mismatches.</p>
{note}
<div class="grid">{''.join(tiles)}</div>
"""
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(page)
    mb = out.stat().st_size / 1024 / 1024
    print(f'{len(tiles)} cards -> {out}  ({mb:.1f} MB)')
    if missing:
        print(f'missing {len(missing)}: {", ".join(missing)}')


if __name__ == '__main__':
    main()
