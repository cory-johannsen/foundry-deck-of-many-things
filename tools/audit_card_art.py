#!/usr/bin/env python3
"""Audit generated card art for the two defects we know the generator produces.

1. BORDER  — every card must have a decorative frame. A card whose art bleeds to
   the edge reads as broken in the deck. Detected by measuring how uniform each
   edge strip is along its length: a frame is a continuous band, so its
   luminance profile is flat, while bare art varies with whatever it depicts.

2. TEXT    — the generator used to render "TAROT" into a cartouche (see
   docs/card-art-audit.md). Flags high-contrast horizontal streaks in the label
   bands at top and bottom, which is what rendered lettering looks like. This is
   a screening signal, not OCR — it says "look at this card", not "this says X".

Usage:
  python3 tools/audit_card_art.py assets/cards            # all cards
  python3 tools/audit_card_art.py assets/cards beast.png  # specific files
"""
import pathlib
import sys

import numpy as np
from PIL import Image

EDGE_FRAC = 0.075      # thickness of the strip sampled at each edge
BORDER_SYM_MIN = 0.45  # min coarse left/right mirror correlation (screening only)

BAND_TOP = (0.02, 0.14)     # where a title band appears, as fractions of height
BAND_BOTTOM = (0.86, 0.985)
TEXT_STREAK_MIN = 0.055     # fraction of rows in the band that look like text


def luminance(im):
    return np.asarray(im.convert('L'), dtype=np.float64)


def _corr(a, b):
    a = a.ravel() - a.mean()
    b = b.ravel() - b.mean()
    d = np.sqrt((a * a).sum() * (b * b).sum())
    return float((a * b).sum() / d) if d > 1e-9 else 0.0


def border_report(lum):
    """Mirror symmetry of the edge strips.

    A decorative frame is left-right symmetric and top-bottom symmetric by
    construction, so the left strip correlates with the mirrored right strip.
    Artwork running to the edge does not. Uniformity was tried first and fails:
    these frames are dense gold filigree with high variance along their length,
    so a flatness metric cannot tell an ornate frame from bleeding art.
    """
    h, w = lum.shape
    t, s = int(h * EDGE_FRAC), int(w * EDGE_FRAC)

    def coarse(a, shape):
        """Downsample before correlating. Diffusion frames are symmetric in
        structure but not pixel-for-pixel, so a full-resolution correlation
        reads a perfectly good frame as asymmetric."""
        return np.asarray(Image.fromarray(a).resize(shape, Image.BILINEAR), dtype=np.float64)

    left = coarse(lum[:, 0:s], (24, 48))
    right = coarse(lum[:, w - s:w][:, ::-1], (24, 48))
    top = coarse(lum[0:t, :], (48, 24))
    bottom = coarse(lum[h - t:h, :][::-1, :], (48, 24))
    scores = {
        'lr': _corr(left, right),
        'tb': _corr(top, bottom),
    }
    # Left/right symmetry is the reliable one; top/bottom often differs because
    # a card's composition is not vertically symmetric even when framed.
    scores['score'] = max(scores['lr'], 0.5 * (scores['lr'] + scores['tb']))
    return scores, scores['score'] >= BORDER_SYM_MIN


def text_score(lum, band):
    """Fraction of rows in `band` carrying a text-like high-contrast streak.

    Rendered lettering produces rows with many sharp dark/light transitions
    against an otherwise flat plate; ornament produces smoother variation.
    """
    h, w = lum.shape
    y0, y1 = int(h * band[0]), int(h * band[1])
    strip = lum[y0:y1, int(w * 0.18):int(w * 0.82)]
    if strip.size == 0:
        return 0.0
    grad = np.abs(np.diff(strip, axis=1))
    # A "text row" has many strong horizontal transitions.
    strong = (grad > 38).sum(axis=1)
    return float((strong > strip.shape[1] * 0.11).mean())


def audit(path):
    im = Image.open(path)
    lum = luminance(im)
    scores, has_border = border_report(lum)
    top = text_score(lum, BAND_TOP)
    bot = text_score(lum, BAND_BOTTOM)
    return {
        'file': path.name,
        'scores': scores,
        'has_border': has_border,
        'top_text': top,
        'bottom_text': bot,
        'text_suspect': top > TEXT_STREAK_MIN or bot > TEXT_STREAK_MIN,
    }


def main():
    root = pathlib.Path(sys.argv[1])
    names = sys.argv[2:]
    files = ([root / n for n in names] if names
             else sorted(p for p in root.glob('*.png') if p.name != 'back.png'))

    rows = [audit(p) for p in files]
    print(f"{'card':<16}{'border':>8}{'sym':>7}{'lr':>7}{'tb':>7}{'topTxt':>8}{'botTxt':>8}  flag")
    print('-' * 76)
    for r in rows:
        flags = []
        if not r['has_border']:
            flags.append('NO-BORDER')
        if r['top_text'] > TEXT_STREAK_MIN:
            flags.append('TOP-TEXT')
        if r['bottom_text'] > TEXT_STREAK_MIN:
            flags.append('BOTTOM-TEXT')
        print(f"{r['file'][:-4]:<16}{'ok' if r['has_border'] else 'MISSING':>8}"
              f"{r['scores']['score']:>7.2f}{r['scores']['lr']:>7.2f}{r['scores']['tb']:>7.2f}"
              f"{r['top_text']:>8.3f}{r['bottom_text']:>8.3f}  {' '.join(flags)}")

    bad_border = [r['file'] for r in rows if not r['has_border']]
    suspect = [r['file'] for r in rows if r['text_suspect']]
    print('-' * 76)
    print(f"{len(rows)} cards | missing border: {len(bad_border)} | text suspected: {len(suspect)}")
    if bad_border:
        print('  no border : ' + ', '.join(f[:-4] for f in bad_border))
    if suspect:
        print('  check text: ' + ', '.join(f[:-4] for f in suspect))


if __name__ == '__main__':
    main()
