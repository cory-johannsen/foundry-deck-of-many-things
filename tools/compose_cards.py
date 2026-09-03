#!/usr/bin/env python3
"""Compose a finished card: full-bleed art + decorative frame + name plate.

Driven by tools/compose-cards.mjs. Reads a JSON array of
{id, name, src, out} on stdin.

Both the frame and the plate are composited here rather than prompted, because
the generator cannot be made to produce either reliably:
  - a name in the prompt comes back as a gibberish cartouche
  - a border in the prompt gets absorbed into the subject (it became a glass
    tank on Ooze, a hung picture frame on Staff, a temple facade on Temple)
Compositing makes both exact and identical on all 66 cards.

The frame (assets/frame.png) is generated gold ornament on a flat black field.
Its alpha is keyed on CHROMA (red minus blue), not luminance: the gold is warm
(chroma 72-97) while the black field is neutral (chroma <= 7), so chroma
separates them cleanly. Luminance does not — the field carries a faint radial
gradient peaking around 66, which would fog the art beneath.
"""
import json
import pathlib
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

FRAME_PATH = 'assets/frame.png'
CHROMA_LO, CHROMA_HI = 12.0, 55.0

# Name plate geometry, as fractions of the card.
PLATE_W, PLATE_H = 0.52, 0.052
PLATE_BOTTOM = 0.928
CORNER = 0.30

# The artwork is fitted INSIDE the frame's aperture rather than run full-bleed
# behind it, so the frame cannot cover important detail. The border area is
# filled with a blurred, darkened blow-up of the same art, which keeps a related
# background behind the ornament instead of flat black.
APERTURE_INSET = 0.99    # shrink slightly so the oval corners do not clip the art
BG_BLUR = 0.045          # blur radius as a fraction of the card's short side
BG_DARKEN = 0.42         # how far the background is pulled toward EDGE_INK
FEATHER = 0.055          # soft edge on the fitted art, as a fraction of its short side
EDGE_INK = (14, 12, 10)
EDGE_DARKEN = 0.72

PARCHMENT = (232, 221, 194)
INK = (26, 20, 16)
GOLD = (150, 118, 58)

FONT_CANDIDATES = [
    '/usr/share/fonts/truetype/liberation/LiberationSerif-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf',
    '/usr/share/fonts/truetype/noto/NotoSerif-Bold.ttf',
]


def load_font(size):
    for path in FONT_CANDIDATES:
        if pathlib.Path(path).exists():
            return ImageFont.truetype(path, size)
    raise SystemExit('No serif font found; install fonts-liberation')


def frame_rgba(size):
    """Frame image with a chroma-derived alpha, plus a mask of its aperture.

    Returns (frame RGBA, outside-aperture mask). The frame is lace-like — the
    ornament has gaps the art shows through — which looks good over dark art but
    lets a light-edged illustration read as a white border. The mask marks
    everything outside the central opening so the art beneath the ornament can
    be darkened, giving a consistent card edge whatever the art does.
    """
    im = Image.open(FRAME_PATH).convert('RGB')
    if im.size != size:
        im = im.resize(size, Image.LANCZOS)
    a = np.asarray(im).astype(np.float32)
    chroma = a[:, :, 0] - a[:, :, 2]
    alpha = np.clip((chroma - CHROMA_LO) / (CHROMA_HI - CHROMA_LO), 0.0, 1.0)
    rgba = Image.fromarray(np.dstack([a, alpha * 255.0]).astype(np.uint8), 'RGBA')

    # Backing mask for the art behind the ornament. Derived by blurring the
    # frame's own alpha: high where ornament is dense (the edges), zero in the
    # open centre. A flood fill was tried first and failed silently, darkening
    # the whole card — this cannot, because the centre has no ornament to blur.
    backing = Image.fromarray((alpha * 255).astype(np.uint8), 'L')
    backing = backing.filter(ImageFilter.GaussianBlur(min(size) * 0.035))
    b = np.asarray(backing).astype(np.float32) / 255.0
    b = np.clip(b * 2.2, 0.0, 1.0)          # solidify under the ornament

    # Aperture extents, found by scanning out from the centre until the ornament
    # starts. Everything the reader should see has to fit inside this.
    w, h = size
    cy, cx = h // 2, w // 2
    col, row = alpha[:, cx], alpha[cy, :]

    def scan(arr, start, step):
        i = start
        while 0 <= i < len(arr) and arr[i] < 0.35:
            i += step
        return i

    ap = (scan(row, cx, -1), scan(col, cy, -1), scan(row, cx, 1), scan(col, cy, 1))
    return rgba, Image.fromarray((b * 255).astype(np.uint8), 'L'), ap


def tracked_width(draw, text, font, tracking):
    return sum(draw.textlength(ch, font=font) for ch in text) + tracking * max(0, len(text) - 1)


def draw_tracked(draw, xy, text, font, fill, tracking):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking


def name_plate(card_size, text):
    W, H = card_size
    pw, ph = int(W * PLATE_W), int(H * PLATE_H)
    radius = int(ph * CORNER)

    plate = Image.new('RGB', (pw, ph), PARCHMENT)
    shade = Image.linear_gradient('L').resize((pw, ph))
    plate = Image.composite(
        Image.new('RGB', (pw, ph), tuple(int(c * 0.90) for c in PARCHMENT)),
        plate, shade.point(lambda v: int(v * 0.35)))

    d = ImageDraw.Draw(plate)
    d.rounded_rectangle([0, 0, pw - 1, ph - 1], radius=radius, outline=INK, width=max(2, ph // 26))
    inset = max(4, ph // 9)
    d.rounded_rectangle([inset, inset, pw - 1 - inset, ph - 1 - inset],
                        radius=max(1, radius - inset), outline=GOLD, width=max(1, ph // 52))

    avail_w = pw - 2 * inset - int(pw * 0.06)
    avail_h = ph - 2 * inset - int(ph * 0.14)
    size = int(ph * 0.62)
    while size > 8:
        font = load_font(size)
        tracking = max(1.0, size * 0.13)
        tw = tracked_width(d, text, font, tracking)
        box = d.textbbox((0, 0), text, font=font)
        if tw <= avail_w and (box[3] - box[1]) <= avail_h:
            break
        size -= 1
    box = d.textbbox((0, 0), text, font=font)
    draw_tracked(d, ((pw - tw) / 2, (ph - (box[3] - box[1])) / 2 - box[1]),
                 text, font, INK, tracking)
    return plate, (W - pw) // 2, int(H * PLATE_BOTTOM) - ph


def compose(card, frame_cache):
    art = Image.open(card['src']).convert('RGB')
    size = art.size
    if size not in frame_cache:
        frame_cache[size] = frame_rgba(size)
    frame, outside, ap = frame_cache[size]
    W, H = size

    # Background: the same art blown up to cover the card, blurred and darkened.
    # Gives the border area a related backdrop instead of flat black.
    scale = max(W / art.width, H / art.height) * 1.15
    bg = art.resize((round(art.width * scale), round(art.height * scale)), Image.LANCZOS)
    bg = bg.crop(((bg.width - W) // 2, (bg.height - H) // 2,
                  (bg.width - W) // 2 + W, (bg.height - H) // 2 + H))
    bg = bg.filter(ImageFilter.GaussianBlur(min(size) * BG_BLUR))
    out = Image.blend(bg, Image.new('RGB', size, EDGE_INK), BG_DARKEN)

    # Foreground: the whole artwork, fitted inside the aperture so the frame
    # cannot crop it.
    ax0, ay0, ax1, ay1 = ap
    aw, ah = (ax1 - ax0) * APERTURE_INSET, (ay1 - ay0) * APERTURE_INSET
    fit = min(aw / art.width, ah / art.height)
    fw, fh = round(art.width * fit), round(art.height * fit)
    fx, fy = (ax0 + ax1) // 2 - fw // 2, (ay0 + ay1) // 2 - fh // 2

    # Feather the fitted art into the backdrop. Without this it reads as a hard
    # rectangle pasted inside an oval aperture; the soft edge lets the artwork
    # melt into its own blurred blow-up the way a full-bleed image would.
    feather = max(2, round(min(fw, fh) * FEATHER))
    mask = Image.new('L', (fw, fh), 0)
    ImageDraw.Draw(mask).rectangle([feather, feather, fw - 1 - feather, fh - 1 - feather], fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(feather * 0.75))
    out.paste(art.resize((fw, fh), Image.LANCZOS), (fx, fy), mask)

    # Darken behind the ornament so a light-edged illustration cannot read as a
    # white border through the frame's gaps.
    darkened = Image.blend(out, Image.new('RGB', size, EDGE_INK), EDGE_DARKEN)
    out = Image.composite(darkened, out, outside)
    out.paste(frame, (0, 0), frame)

    plate, px, py = name_plate(size, card['name'].upper())
    shadow = Image.new('L', size, 0)
    ImageDraw.Draw(shadow).rounded_rectangle(
        [px, py + int(plate.height * 0.12), px + plate.width, py + plate.height + int(plate.height * 0.12)],
        radius=int(plate.height * CORNER), fill=130)
    shadow = shadow.filter(ImageFilter.GaussianBlur(plate.height * 0.18))
    out = Image.composite(Image.new('RGB', size, (0, 0, 0)), out, shadow)
    out.paste(plate, (px, py))

    dest = pathlib.Path(card['out'])
    dest.parent.mkdir(parents=True, exist_ok=True)
    out.save(dest)
    return dest


def main():
    cache = {}
    for card in json.load(sys.stdin):
        dest = compose(card, cache)
        print(f"{card['name']:<14} -> {dest}")


if __name__ == '__main__':
    main()
