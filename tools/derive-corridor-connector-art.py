#!/usr/bin/env python3
"""Derive open-sided corridor connector art from the existing corridor.webp.

corridor.webp is a small self-contained "box" texture — floor with a wall
painted on all four sides — designed for a single isolated 1x1 gap between two
rooms. dungeon-scene.mjs tiles it once per grid square to fill a longer
connecting gallery (ITEM-9/ITEM-13), but repeating the same fully-walled box
N times makes the gallery read as a stack of N separate boxed alcoves instead
of one continuous hallway (ITEM-12) — every tile shows walls on sides that, in
the real Wall geometry, are open to the next tile.

This script crops the thin white margin baked into corridor.webp, then derives
two variants used for any gallery longer than one tile:
  - corridor-mid.webp: walls only on its left/right; the wall band top and
    bottom is replaced with the floor band stretched to fill the tile, so it's
    open at both ends — used for every tile strictly between the two ends of a
    gallery.
  - corridor-end.webp: keeps the top wall band, replaces only the bottom wall
    band with floor — used for the two end tiles (each end needs a wall
    against the actual outer cap and an open side facing inward), rotated 180
    degrees for the far end by dungeon-scene.mjs at placement time.

Both are built in the same "wall on top" canonical orientation; a vertical
gallery (east/west connections) uses them unrotated (dy=0 wall on top) and
180-rotated (far end), a horizontal gallery (south/row-wrap connections) uses
them rotated 90/270 — see dungeon-layout.mjs's corridorTileVariant and
dungeon-scene.mjs's buildRoomAtSlot. corridor.webp itself is untouched and
still used as-is for a single-tile gallery (aligned doors), where a fully
boxed alcove is correct.

Usage:
  python3 tools/derive-corridor-connector-art.py
"""
from pathlib import Path

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / 'assets/dungeon-rooms/corridor.webp'
OUT_MID = ROOT / 'assets/dungeon-rooms/corridor-mid.webp'
OUT_END = ROOT / 'assets/dungeon-rooms/corridor-end.webp'

# The wall band width, measured against the margin-cropped 512x512 image —
# found by sampling brightness along the center row/column of corridor.webp
# for the darkest wall/floor shadow line; both axes came out ~115-120px, so
# one constant serves all four sides (the source art is edge-symmetric).
WALL_BAND = 118


def stretch_vertical(arr, y0, y1, out_h, width):
    band = Image.fromarray(arr[y0:y1, :, :].astype('uint8'))
    return np.array(band.resize((width, out_h), Image.LANCZOS)).astype(np.float64)


def crop_margin(im):
    """corridor.webp has a few px of white padding baked in around the box —
    left as-is it produces a visible seam every time a tile repeats, so it's
    cropped out and the box rescaled to fill the full canvas before deriving
    anything from it."""
    arr = np.array(im)
    is_white_row = (arr.mean(axis=2) > 240).all(axis=1)
    is_white_col = (arr.mean(axis=2) > 240).all(axis=0)
    rows = np.where(~is_white_row)[0]
    cols = np.where(~is_white_col)[0]
    top, bottom = rows[0], rows[-1]
    left, right = cols[0], cols[-1]
    return im.crop((left, top, right + 1, bottom + 1)).resize(im.size, Image.LANCZOS)


def make_mid(arr, h, w):
    out = arr.copy()
    floor_full = stretch_vertical(arr, WALL_BAND, h - WALL_BAND, h, w)
    out[:, :, :] = floor_full
    out[:, :WALL_BAND, :] = arr[:, :WALL_BAND, :]
    out[:, w - WALL_BAND:, :] = arr[:, w - WALL_BAND:, :]
    return out


def make_end(arr, h, w):
    out = arr.copy()
    floor_lower = stretch_vertical(arr, WALL_BAND, h - WALL_BAND, h - WALL_BAND, w)
    out[WALL_BAND:, :, :] = floor_lower
    out[:, :WALL_BAND, :] = arr[:, :WALL_BAND, :]
    out[:, w - WALL_BAND:, :] = arr[:, w - WALL_BAND:, :]
    return out


def main():
    src = Image.open(SRC).convert('RGB')
    cropped = crop_margin(src)
    arr = np.array(cropped).astype(np.float64)
    h, w, _ = arr.shape

    Image.fromarray(make_mid(arr, h, w).astype('uint8')).save(OUT_MID)
    Image.fromarray(make_end(arr, h, w).astype('uint8')).save(OUT_END)
    print(f'wrote {OUT_MID.relative_to(ROOT)}')
    print(f'wrote {OUT_END.relative_to(ROOT)}')


if __name__ == '__main__':
    main()
