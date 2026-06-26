#!/usr/bin/env python3
"""
AI-composited brand assets for **ComfyUI Agent Panel**.

Same crisp brand layer (squircle badge + node mark + wordmark + provider chips)
as brand_assets.py, but the atmospheric backdrop is now the royal-blue neural
node-field generated on-device via the **Nano Banana 2** API node, instead of
the procedural scene(). Diffusion paints the soul; Pillow stamps the sharp logo.

Plates (from ComfyUI output/):
  brand_banner_plate_00001_.png  21:9 2K  -> banner backdrop (flipped: cluster L)
  brand_og_plate_00001_.png      16:9 2K  -> OG backdrop
  brand_icon_plate_00001_.png    1:1  1K  -> icon squircle texture
"""

import os
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

import brand_assets as B  # reuse palette, fonts, helpers, mark + chip drawing

SS = B.SS
PLATES = r"C:/Users/Artokun/ComfyUI-Shared/output"
BANNER_PLATE = os.path.join(PLATES, "brand_banner_plate_00001_.png")
OG_PLATE     = os.path.join(PLATES, "brand_og_plate_00001_.png")
ICON_PLATE   = os.path.join(PLATES, "brand_icon_plate_00001_.png")

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "brand-preview-ai")
os.makedirs(OUT, exist_ok=True)

NAVY = (8, 13, 33)


# ------------------------------------------------------------------ helpers ---
def cover(img, tw, th, flip=False):
    """Resize+center-crop `img` to exactly (tw,th) covering the frame."""
    img = img.convert("RGB")
    if flip:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
    iw, ih = img.size
    s = max(tw / iw, th / ih)
    nw, nh = int(round(iw * s)), int(round(ih * s))
    img = img.resize((nw, nh), Image.LANCZOS)
    x = (nw - tw) // 2
    y = (nh - th) // 2
    return img.crop((x, y, x + tw, y + th))


def polish(img, contrast=1.06, sat=1.10, bright=0.96):
    img = ImageEnhance.Contrast(img).enhance(contrast)
    img = ImageEnhance.Color(img).enhance(sat)
    img = ImageEnhance.Brightness(img).enhance(bright)
    return img


def hscrim(w, h, a_left, a_right, color=NAVY):
    xs = np.linspace(0.0, 1.0, w, dtype=np.float32)
    alpha = a_left + (a_right - a_left) * xs
    alpha = np.tile(alpha, (h, 1))
    arr = np.zeros((h, w, 4), np.uint8)
    arr[..., 0], arr[..., 1], arr[..., 2] = color
    arr[..., 3] = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


def vscrim(w, h, a_top, a_bot, color=NAVY):
    ys = np.linspace(0.0, 1.0, h, dtype=np.float32)
    alpha = a_top + (a_bot - a_top) * ys
    alpha = np.tile(alpha[:, None], (1, w))
    arr = np.zeros((h, w, 4), np.uint8)
    arr[..., 0], arr[..., 1], arr[..., 2] = color
    arr[..., 3] = (np.clip(alpha, 0, 1) * 255).astype(np.uint8)
    return Image.fromarray(arr, "RGBA")


# ----------------------------------------------------- AI-textured badge ------
def make_ai_badge(size, plate_img, radius_ratio=0.225, mark_scale=1.12):
    """Squircle badge whose fill is the AI radial node-burst plate."""
    badge = cover(plate_img, size, size).convert("RGBA")
    badge = polish(badge, contrast=1.10, sat=1.16, bright=1.0).convert("RGBA")

    # top-left gloss + bottom-right deepen for app-icon dimensionality
    badge = Image.alpha_composite(badge, B.radial_glow(
        size, size, size * 0.30, size * 0.22, size * 0.85, (120, 175, 255), 0.30, 2.0))
    badge = Image.alpha_composite(badge, B.radial_glow(
        size, size, size * 0.82, size * 0.86, size * 0.70, (8, 18, 54), 0.45, 2.0))
    # dark scrim behind the mark so the white logo pops over the busy field
    badge = Image.alpha_composite(badge, B.radial_glow(
        size, size, size * 0.5, size * 0.5, size * 0.46, (6, 12, 36), 0.50, 1.8))

    # the crisp node mark, strong glow
    mark = B.draw_mark(size, stroke_ratio=0.112, color=B.WHITE,
                       glow=(B.WHITE, size * 0.018, 130), mscale=mark_scale)
    badge = Image.alpha_composite(badge, mark)

    # hairline inner stroke
    edge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    r = int(size * radius_ratio)
    ImageDraw.Draw(edge).rounded_rectangle(
        [1, 1, size - 2, size - 2], radius=r,
        outline=(255, 255, 255, 46), width=max(1, int(size * 0.006)))
    badge = Image.alpha_composite(badge, edge)

    mask = B.rounded_rect_mask(size, size, r)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(badge, (0, 0), mask)
    return out


# ===================================================================== ICON ===
def render_icon(px=400):
    size = px * SS
    plate = Image.open(ICON_PLATE)
    badge = make_ai_badge(size, plate)
    out = badge.resize((px, px), Image.LANCZOS)
    out.save(os.path.join(OUT, "icon.png"))
    print("icon.png", out.size)


# =================================================================== BANNER ====
def render_banner(W=1680, H=720):  # 21:9
    w, h = W * SS, H * SS
    plate = Image.open(BANNER_PLATE)
    base = cover(plate, w, h, flip=True).convert("RGBA")  # flip -> cluster on left
    base = polish(base).convert("RGBA")

    # darken the right 55% so the wordmark reads cleanly
    base = Image.alpha_composite(base, hscrim(w, h, 0.0, 0.55))
    # gentle global navy unify
    base = Image.alpha_composite(base, hscrim(w, h, 0.10, 0.10))

    badge_cx = w * 0.205
    bsize = int(h * 0.66)
    # drop glow behind badge
    base = Image.alpha_composite(base, B.radial_glow(
        w, h, badge_cx, h * 0.5, bsize * 1.0, B.BLUE_LT, 0.50, 2.0))
    badge = B.make_badge(bsize)  # clean blue badge as the logo lockup
    bx = int(badge_cx - bsize / 2)
    by = int(h * 0.5 - bsize / 2)
    base.alpha_composite(badge, (bx, by))

    d = ImageDraw.Draw(base)
    tx = bx + bsize + int(78 * SS)
    avail = w - tx - int(56 * SS)

    track = int(-2 * SS)
    fsize = 152 * SS
    while fsize > 40 * SS:
        fw = B.font(B.F_BLACK, fsize)
        if B.measure_tracked(d, "ComfyUI Agent Panel", fw, track) <= avail:
            break
        fsize -= 2 * SS
    fw = B.font(B.F_BLACK, fsize)

    line_h = fsize * 1.0
    tagline_f = B.font(B.F_SEMI, 38 * SS)
    block_h = line_h + 26 * SS + tagline_f.size * 1.2 + 30 * SS + 64 * SS
    ty = int(h * 0.5 - block_h / 2)

    x = tx
    for word, col in [("ComfyUI", B.WHITE), (" ", B.WHITE), ("Agent", B.BLUE_LT),
                      (" ", B.WHITE), ("Panel", B.WHITE)]:
        wlen = B.text_tracked(d, (x, ty), word, fw, col, tracking=track)
        x += wlen + track

    ty2 = ty + int(line_h) + int(20 * SS)
    d.text((tx, ty2), "Autonomous AI agent in your ComfyUI sidebar",
           font=tagline_f, fill=B.OFFWHITE)

    ty3 = ty2 + int(tagline_f.size * 1.2) + int(28 * SS)
    B.draw_chip_row(base, tx, ty3, SS)

    flat = B.vignette(base, strength=0.40, power=2.2)
    out = flat.resize((W, H), Image.LANCZOS)
    out.save(os.path.join(OUT, "banner.png"))
    print("banner.png", out.size)


# ====================================================================== OG =====
def render_og(W=1200, H=630):
    w, h = W * SS, H * SS
    plate = Image.open(OG_PLATE)
    base = cover(plate, w, h).convert("RGBA")
    base = polish(base).convert("RGBA")
    # bottom scrim for the centred text block + slight top darken
    base = Image.alpha_composite(base, vscrim(w, h, 0.12, 0.62))

    bsize = int(h * 0.30)
    base = Image.alpha_composite(base, B.radial_glow(
        w, h, w * 0.5, h * 0.30, bsize * 1.05, B.BLUE_LT, 0.45, 2.0))
    badge = B.make_badge(bsize)
    bx = int(w * 0.5 - bsize / 2)
    by = int(h * 0.135)
    base.alpha_composite(badge, (bx, by))

    d = ImageDraw.Draw(base)
    track = int(-2 * SS)
    fw = B.font(B.F_BLACK, 104 * SS)
    parts = [("ComfyUI ", B.WHITE), ("Agent", B.BLUE_LT), (" Panel", B.WHITE)]
    total = sum(B.measure_tracked(d, t, fw, track) + track for t, _ in parts) - track
    x = int(w * 0.5 - total / 2)
    ty = by + bsize + int(54 * SS)
    for t, col in parts:
        wl = B.text_tracked(d, (x, ty), t, fw, col, tracking=track)
        x += wl + track

    tf = B.font(B.F_SEMI, 40 * SS)
    tg = "Autonomous AI agent in your ComfyUI sidebar"
    tgw = B.measure_tracked(d, tg, tf)
    ty2 = ty + int(fw.size * 1.05) + int(18 * SS)
    d.text((int(w * 0.5 - tgw / 2), ty2), tg, font=tf, fill=B.OFFWHITE)

    ty3 = ty2 + int(tf.size * 1.2) + int(30 * SS)
    f_chip = B.font(B.F_SEMI, 30 * SS); f_or = B.font(B.F_REG, 28 * SS); f_mut = B.font(B.F_REG, 30 * SS)
    dot_r = int(9 * SS); gap = int(12 * SS); pad = int(16 * SS)
    seg = lambda l: dot_r * 2 + gap + B.measure_tracked(d, l, f_chip)
    parts_w = seg("Claude") + B.measure_tracked(d, "  or  ", f_or) + seg("ChatGPT")
    pill_w = int(parts_w + pad * 2)
    tail_w = B.measure_tracked(d, "your subscription · no API keys", f_mut)
    roww = pill_w + int(20 * SS) + tail_w
    cx = int(w * 0.5 - roww / 2)
    B.draw_chip_row(base, cx, ty3, SS)

    flat = B.vignette(base, strength=0.36, power=2.2)
    out = flat.resize((W, H), Image.LANCZOS)
    out.save(os.path.join(OUT, "og.png"))
    print("og.png", out.size)


if __name__ == "__main__":
    render_icon()
    render_banner()
    render_og()
    print("done ->", os.path.abspath(OUT))
