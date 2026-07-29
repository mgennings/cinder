#!/usr/bin/env python3
"""Prove the shipped social cards are what build-brand.py renders, and that what
it renders survives what platforms do to it.

    python3 scripts/test-brand.py

Every assertion here measures the rendered PNG. None of them reads a token value
and agrees with itself -- the defect this card set replaced was a card whose
source said "brand mark" while its pixels were a mid-rotation screen capture, and
no assertion about a constant would ever have caught that.

Meaningful ink is found by DIFFERENCE against a plate: the identical card
rendered with the mark and every glyph omitted. Any pixel that differs is
content; any pixel that matches is terrain. It is the only method that sees ink
over a gradient, and this card has a gradient behind its type.
"""

import importlib.util
import io
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
spec = importlib.util.spec_from_file_location("build_brand", ROOT / "scripts" / "build-brand.py")
bb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bb)

MARK_SVG = (bb.BRAND / "cinder-mark.svg").read_text()
FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    print(("  ok   " if condition else "  FAIL ") + message)
    if not condition:
        FAILURES.append(message)


def rasterize(svg: str) -> np.ndarray:
    png = subprocess.run(
        ["rsvg-convert", "-w", str(bb.CARD_W), "-h", str(bb.CARD_H), "-b", bb.GROUND],
        input=svg.encode(), check=True, capture_output=True,
    ).stdout
    return np.asarray(Image.open(io.BytesIO(png)).convert("RGB")).astype(int)


def luminance(rgb) -> float:
    channels = []
    for value in np.asarray(rgb, dtype=float) / 255:
        channels.append(value / 12.92 if value <= 0.03928 else ((value + 0.055) / 1.055) ** 2.4)
    return float(np.dot([0.2126, 0.7152, 0.0722], channels))


def contrast(ink, ground) -> float:
    a, b = luminance(ink), luminance(ground)
    lo, hi = sorted((a, b))
    return (hi + 0.05) / (lo + 0.05)


# The three fills the card declares. Glyph-body pixels are the masked pixels that
# actually landed on one of them; the rest of the mask is antialiasing, which
# WCAG does not measure.
ROLES = {"headline": bb.BODY, "eyebrow/support": bb.MIST}


def rgb(token: str) -> np.ndarray:
    return np.array([int(token[i : i + 2], 16) for i in (1, 3, 5)])


print("social_card rejects anything outside the literal set:")
for bad in ["", "Primary", "note ", "../og", None, 0]:
    try:
        bb.social_card(bad, MARK_SVG)
        check(False, f"rejects {bad!r}")
    except (ValueError, TypeError, AttributeError):
        check(True, f"rejects {bad!r}")

check(sorted(bb.CARDS) == ["file", "note", "primary"], "exactly three card kinds")
check(
    min(bb.EYEBROW_PX, bb.HEADLINE_PX, bb.SUPPORT_PX) >= bb.MIN_TYPE_PX,
    f"smallest type is {min(bb.EYEBROW_PX, bb.HEADLINE_PX, bb.SUPPORT_PX)}px, floor is {bb.MIN_TYPE_PX}px",
)

mark_alpha = np.asarray(
    Image.open(io.BytesIO(subprocess.run(
        ["rsvg-convert", "-w", "630", "-h", "630", str(bb.BRAND / "cinder-mark.svg")],
        check=True, capture_output=True).stdout)).convert("RGBA")
).astype(int)[..., 3]
TRUE_SYMMETRY = (np.abs(mark_alpha - mark_alpha[:, ::-1]) <= 12).mean()
print(f"\ncinder-mark.svg vertical-mirror overlap: {TRUE_SYMMETRY * 100:.1f}%")

for kind, card in bb.CARDS.items():
    shipped_path = bb.STATIC / card["file"]
    print(f"\n== {kind} ({card['file']})")

    shipped = np.asarray(Image.open(shipped_path).convert("RGB")).astype(int)
    check(shipped.shape[:2] == (bb.CARD_H, bb.CARD_W), f"{bb.CARD_W}x{bb.CARD_H}")

    # Pixel identity rather than byte identity: librosvg and libpng emit different
    # bytes across versions for identical pixels, so a byte check would fail on a
    # machine that changed nothing. Pixels still catch a hand-edited PNG, which is
    # the thing this contract exists to forbid.
    fresh = rasterize(bb.social_card(kind, MARK_SVG))
    check(np.array_equal(shipped, fresh), "shipped PNG is pixel-identical to a fresh render")

    # Every measurement below reads the SHIPPED bytes, never `fresh`. Measuring
    # the fresh render would compare the generator to itself and pass on any file
    # at all -- proven by swapping the old torn card in and watching only the
    # identity check notice.
    plate = rasterize(bb.social_card(kind, MARK_SVG, plate=True))
    content = np.abs(shipped - plate).max(axis=2) > 8
    lum = shipped @ [0.2126, 0.7152, 0.0722]

    # Crop safety. Platforms crop toward square; only terrain may be lost.
    height, width = content.shape
    square = ((width - height) // 2, (width + height) // 2)
    four_five = ((width - round(height * 4 / 5)) // 2, (width + round(height * 4 / 5)) // 2)
    total = content.sum()
    kept_11 = content[:, square[0] : square[1]].sum() / total
    kept_45 = content[:, four_five[0] : four_five[1]].sum() / total
    print(f"     meaningful ink {total} px -> 1:1 keeps {kept_11 * 100:.1f}%, 4:5 keeps {kept_45 * 100:.1f}%")
    check(kept_11 == 1.0, "a 1:1 crop keeps 100% of the mark and type")
    check(kept_45 == 1.0, "a 4:5 crop keeps 100% of the mark and type")

    thirds = [content[i * height // 3 : (i + 1) * height // 3].sum() / total * 100 for i in range(3)]
    print(f"     ink by vertical third: {thirds[0]:.1f}% / {thirds[1]:.1f}% / {thirds[2]:.1f}%")

    # The figure is the brand mark, not a capture of the ambient animation.
    #
    # Sampled at the EXACT box the card places the mark in, widened to the live
    # area so a figure that sprawls past the mark's footprint is caught rather
    # than cropped out of the measurement. An earlier version of this check took
    # a band from the top of the content mask, which on the old card landed on
    # empty ground and reported 99.8% for a figure that measures 8.3%.
    # Measured on the SHIPPED PIXELS, not on the plate-difference mask. Diffing a
    # foreign card against this generator's plate saturates the mask -- every
    # pixel differs -- and a saturated mask is trivially mirror-symmetric, so the
    # old torn card scored 99.5% and sailed through. Luminance sees the figure.
    x, y, size = bb.mark_box(kind)
    band = lum[y : y + size, bb.LIVE_X : bb.LIVE_X + bb.LIVE_W]
    keep = np.abs(np.arange(y, y + size) - bb.TRACE_Y) > 4  # the trace is drawn
    band = band[keep]                                       # asymmetric on purpose
    check(
        content[y : y + size, bb.LIVE_X : bb.LIVE_X + bb.LIVE_W].mean() > 0.02,
        "the mark's box actually contains a figure",
    )
    symmetry = (np.abs(band - band[:, ::-1]) <= 12).mean()
    print(f"     figure vertical-mirror overlap: {symmetry * 100:.2f}% (box x{x} y{y} {size}px)")
    check(symmetry > 0.995, f"figure is the mark, mirror-true ({symmetry * 100:.2f}% > 99.5%)")

    # No tear. The replaced card stepped across 1,185 of its 1,200 columns at
    # y=400, the signature of a screen capture stitched at a frame boundary.
    #
    # MEDIAN over a 12-row window, not a row-to-row difference. This card draws a
    # 60px grid and a full-width ember trace on purpose, and every one of those
    # IS a full-width row-to-row luminance step -- a naive diff calls the design
    # a tear and reports 1,200 of 1,200 columns on a perfectly clean card. A thin
    # drawn line is one outlier row among twelve and does not move a median; a
    # real tear shifts the whole distribution on one side of the boundary. The
    # torn card still measures 98.8% of columns under this instrument, and these
    # cards measure about 30%, so the two are not close.
    span = 12
    seams = [
        (y, int((np.abs(np.median(lum[y - span : y], axis=0) - np.median(lum[y : y + span], axis=0)) > 4).sum()))
        for y in range(span, height - span)
    ]
    worst_y, worst_columns = max(seams, key=lambda row: row[1])
    print(f"     widest sustained seam: y={worst_y}, {worst_columns} of {width} columns")
    check(worst_columns < width * 0.5, f"no stitched seam (worst row touches {worst_columns} columns)")

    # Contrast, measured against the pixels actually behind each glyph, on the
    # full card and on both crops -- a crop can change what sits behind a glyph.
    for label, (x0, x1) in [("full", (0, width)), ("1:1", square), ("4:5", four_five)]:
        for role, token in ROLES.items():
            target = rgb(token)
            on_token = (np.abs(shipped - target).max(axis=2) <= 6) & content
            on_token[:, :x0] = False
            on_token[:, x1:] = False
            if not on_token.any():
                continue
            ratios = [contrast(shipped[y, x], plate[y, x]) for y, x in zip(*np.nonzero(on_token))]
            floor = 4.5 if role == "eyebrow/support" else 3.0
            print(f"     {label:4} {role:15} min {min(ratios):.2f}:1 (needs {floor}:1)")
            check(min(ratios) >= floor, f"{label} {role} clears {floor}:1")

        ember = (np.abs(shipped - rgb(bb.EMBER)).max(axis=2) <= 6) & content
        ember[:, :x0] = False
        ember[:, x1:] = False
        if ember.any():
            ratios = [contrast(shipped[y, x], plate[y, x]) for y, x in zip(*np.nonzero(ember))]
            print(f"     {label:4} {'mark stroke':15} min {min(ratios):.2f}:1 (needs 3.0:1)")
            check(min(ratios) >= 3.0, f"{label} mark stroke clears 3:1 as a non-text graphic")

print()
if FAILURES:
    print(f"{len(FAILURES)} failing check(s)")
    for failure in FAILURES:
        print(f"  - {failure}")
    sys.exit(1)
print("brand pass: three cards, crop-safe, mirror-true, seamless, AA in every crop")
