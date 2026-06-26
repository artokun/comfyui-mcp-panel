#!/usr/bin/env python3
"""
Brand asset generator for **ComfyUI Agent Panel** (comfyui-mcp-panel).

Renders the Comfy Registry images (square icon <=400px, 21:9 banner) plus a
1200x630 Open Graph card, on-brand with the existing identity:

  - Royal blue (#2563EB) primary, navy depth, white "two node rings + stepped
    connector" mark (ComfyUI graph x MCP link).
  - New positioning: an autonomous agent in the sidebar, on Claude OR ChatGPT,
    your own subscription, no API keys.

Pure Pillow + numpy, supersampled 3x for crisp anti-aliasing. No network.
"""

import os
import math
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

SS = 3  # supersample factor
OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "brand-preview")
os.makedirs(OUT, exist_ok=True)

# ---------------------------------------------------------------- palette ----
WHITE      = (255, 255, 255)
OFFWHITE   = (226, 232, 240)   # slate-200
SLATE      = (148, 163, 184)   # slate-400 (muted)
NAVY_TOP   = (8,  13,  33)     # #080D21  scene background, top
NAVY_BOT   = (10, 22,  56)     # #0A1638  scene background, bottom
BLUE_DEEP  = (29,  64, 175)    # #1D40AF
BLUE       = (37,  99, 235)    # #2563EB  brand primary
BLUE_BRT   = (59, 130, 246)    # #3B82F6
BLUE_LT    = (96, 165, 250)    # #60A5FA  accent
CLAUDE     = (217, 119,  87)   # #D97757  Anthropic clay
CODEX      = (16, 163, 127)    # #10A37F  OpenAI green

# ---------------------------------------------------------------- fonts ------
FONTDIR = r"C:\Windows\Fonts"
def font(name, size):
    return ImageFont.truetype(os.path.join(FONTDIR, name), int(size))
F_BLACK = "seguibl.ttf"    # Segoe UI Black
F_BOLD  = "segoeuib.ttf"   # Segoe UI Bold
F_SEMI  = "seguisb.ttf"    # Segoe UI Semibold
F_REG   = "segoeui.ttf"    # Segoe UI

# ---------------------------------------------------------------- helpers ----
def lerp(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))

def linear_gradient(w, h, c_top, c_bot, angle_deg=90):
    """Linear gradient as an RGB numpy image. angle 90 = top->bottom."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    a = math.radians(angle_deg)
    # projection of each pixel onto the gradient axis, normalised 0..1
    proj = xx * math.cos(a) + yy * math.sin(a)
    proj -= proj.min()
    proj /= max(proj.max(), 1e-6)
    grad = np.zeros((h, w, 3), np.float32)
    for i in range(3):
        grad[..., i] = c_top[i] + (c_bot[i] - c_top[i]) * proj
    return grad

def radial_glow(w, h, cx, cy, radius, color, strength=1.0, falloff=2.2):
    """RGBA glow layer: a soft radial blob of `color` centred at (cx,cy)."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt((xx - cx) ** 2 + (yy - cy) ** 2) / max(radius, 1e-6)
    a = np.clip(1.0 - d, 0.0, 1.0) ** falloff
    a = (a * strength * 255).astype(np.uint8)
    out = np.zeros((h, w, 4), np.uint8)
    out[..., 0], out[..., 1], out[..., 2] = color
    out[..., 3] = a
    return Image.fromarray(out, "RGBA")

def vignette(img, strength=0.55, power=2.4):
    w, h = img.size
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
    cx, cy = w / 2, h / 2
    d = np.sqrt(((xx - cx) / (w / 2)) ** 2 + ((yy - cy) / (h / 2)) ** 2)
    d = np.clip(d / 1.42, 0, 1) ** power
    mask = 1.0 - d * strength
    arr = np.asarray(img.convert("RGB")).astype(np.float32)
    arr *= mask[..., None]
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")

def dot_grid(w, h, spacing, r, color, alpha, jitter_skip=None):
    """Faint ComfyUI-canvas dot grid as an RGBA overlay."""
    layer = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    col = (color[0], color[1], color[2], alpha)
    for gy in range(spacing // 2, h, spacing):
        for gx in range(spacing // 2, w, spacing):
            d.ellipse([gx - r, gy - r, gx + r, gy + r], fill=col)
    return layer

def text_tracked(draw, xy, text, fnt, fill, tracking=0, anchor_lm=False):
    """Draw text with letter tracking (px between glyphs). Returns total width.
    anchor_lm=True -> xy is the left-middle baseline-ish; we use top-left here."""
    x, y = xy
    # measure
    total = 0
    widths = []
    for ch in text:
        bb = draw.textbbox((0, 0), ch, font=fnt)
        cw = bb[2] - bb[0]
        # advance = char width via textlength for accuracy
        adv = draw.textlength(ch, font=fnt)
        widths.append(adv)
        total += adv + tracking
    total -= tracking
    for ch, adv in zip(text, widths):
        draw.text((x, y), ch, font=fnt, fill=fill)
        x += adv + tracking
    return total

def measure_tracked(draw, text, fnt, tracking=0):
    total = sum(draw.textlength(ch, font=fnt) + tracking for ch in text)
    return total - tracking if text else 0

def rounded_rect_mask(w, h, radius):
    m = Image.new("L", (w, h), 0)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, w - 1, h - 1], radius=radius, fill=255)
    return m

# ---------------------------------------------------------- the node mark ----
def draw_mark(size, stroke_ratio=0.135, color=WHITE, glow=None, mscale=1.0):
    """
    The signature mark on a transparent RGBA canvas of (size,size):
    two white rings (top-left, bottom-right) joined by a stepped 'elbow'
    connector -- ComfyUI graph node x MCP link.

    Geometry mirrors docs/logo/mcpmarket-icon.svg (400 viewBox):
      ring A center (140,160) r36 ; ring B center (260,240) r36 ;
      connector: right of A -> elbow -> top of B.
    `mscale` enlarges the mark about the badge centre.
    """
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    s = (size / 400.0) * mscale
    off = (size - size * mscale) / 2.0   # recentre after scaling
    stroke = max(2, int(size * stroke_ratio * mscale))

    ax, ay, ar = 140 * s + off, 158 * s + off, 38 * s
    bx, by, br = 262 * s + off, 244 * s + off, 38 * s

    # connector: from right edge of A, horizontal, elbow, vertical to top of B
    a_port = (ax + ar - stroke * 0.15, ay)
    corner = (bx, ay)
    b_port = (bx, by - br + stroke * 0.15)
    pts = [a_port, corner, b_port]

    col = color
    d.line(pts, fill=col, width=stroke, joint="curve")
    # round caps at the connector ends
    rcap = stroke / 2
    for (px, py) in (a_port, b_port):
        d.ellipse([px - rcap, py - rcap, px + rcap, py + rcap], fill=col)

    # the two rings (outline only -> interior shows whatever is behind)
    d.ellipse([ax - ar, ay - ar, ax + ar, ay + ar], outline=col, width=stroke)
    d.ellipse([bx - br, by - br, bx + br, by + br], outline=col, width=stroke)

    if glow:
        gcol, grad, galpha = glow
        g = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        gd = ImageDraw.Draw(g)
        gstroke = stroke
        gd.line(pts, fill=(gcol[0], gcol[1], gcol[2], galpha), width=gstroke, joint="curve")
        gd.ellipse([ax - ar, ay - ar, ax + ar, ay + ar], outline=(gcol[0], gcol[1], gcol[2], galpha), width=gstroke)
        gd.ellipse([bx - br, by - br, bx + br, by + br], outline=(gcol[0], gcol[1], gcol[2], galpha), width=gstroke)
        g = g.filter(ImageFilter.GaussianBlur(grad))
        out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        out = Image.alpha_composite(out, g)
        out = Image.alpha_composite(out, img)
        return out
    return img

# --------------------------------------------------------------- badge -------
def make_badge(size, radius_ratio=0.225, with_mark=True, mark_glow=True, mark_scale=1.12):
    """An app-icon 'squircle' badge: diagonal blue gradient + gloss + node mark."""
    grad = linear_gradient(size, size, BLUE_BRT, BLUE_DEEP, angle_deg=58)
    badge = Image.fromarray(grad.astype(np.uint8), "RGB").convert("RGBA")

    # top-left gloss highlight
    gloss = radial_glow(size, size, size * 0.30, size * 0.22, size * 0.85,
                        (120, 175, 255), strength=0.42, falloff=2.0)
    badge = Image.alpha_composite(badge, gloss)
    # bottom-right deepen
    deepen = radial_glow(size, size, size * 0.82, size * 0.86, size * 0.7,
                         (10, 24, 70), strength=0.5, falloff=2.0)
    badge = Image.alpha_composite(badge, deepen)

    # faint inner dot-grid (canvas texture)
    grid = dot_grid(size, size, int(size * 0.085), max(1, int(size * 0.007)),
                    WHITE, 16)
    badge = Image.alpha_composite(badge, grid)

    if with_mark:
        glow = (WHITE, size * 0.015, 105) if mark_glow else None
        mark = draw_mark(size, stroke_ratio=0.112, color=WHITE, glow=glow, mscale=mark_scale)
        badge = Image.alpha_composite(badge, mark)

    # hairline inner stroke for definition
    edge = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ed = ImageDraw.Draw(edge)
    r = int(size * radius_ratio)
    ed.rounded_rectangle([1, 1, size - 2, size - 2], radius=r,
                         outline=(255, 255, 255, 38), width=max(1, int(size * 0.006)))
    badge = Image.alpha_composite(badge, edge)

    # clip to squircle
    mask = rounded_rect_mask(size, size, r)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(badge, (0, 0), mask)
    return out

# --------------------------------------------------------- scene backdrop ----
def scene(w, h, glow_cx, glow_cy, glow_r=None):
    """Deep atmospheric blue backdrop: gradient + radial brand glow + grid."""
    glow_r = glow_r or w * 0.6
    base = Image.fromarray(linear_gradient(w, h, NAVY_TOP, NAVY_BOT, 100).astype(np.uint8), "RGB").convert("RGBA")
    base = Image.alpha_composite(base, radial_glow(w, h, glow_cx, glow_cy, glow_r * 1.15, BLUE_DEEP, 0.55, 2.0))
    base = Image.alpha_composite(base, radial_glow(w, h, glow_cx, glow_cy, glow_r * 0.62, BLUE, 0.55, 2.1))
    base = Image.alpha_composite(base, radial_glow(w, h, glow_cx, glow_cy, glow_r * 0.30, BLUE_BRT, 0.40, 2.3))
    base = Image.alpha_composite(base, dot_grid(w, h, int(h * 0.052), max(1, int(h * 0.004)), WHITE, 11))
    return base

# ---------------------------------------------------- provider chip row ------
def draw_chip_row(base, x, y, scale):
    """Pill: '(o) Claude  or  (o) ChatGPT' + ' · your subscription · no API keys'."""
    d = ImageDraw.Draw(base)
    f_chip = font(F_SEMI, 30 * scale)
    f_mut  = font(F_REG, 30 * scale)
    pad = int(16 * scale)
    dot_r = int(9 * scale)
    gap = int(12 * scale)

    def seg_w(label):
        return dot_r * 2 + gap + measure_tracked(d, label, f_chip, 0)

    or_label = "or"
    f_or = font(F_REG, 28 * scale)
    parts_w = seg_w("Claude") + measure_tracked(d, "  or  ", f_or) + seg_w("ChatGPT")
    pill_w = int(parts_w + pad * 2)
    pill_h = int(64 * scale)
    r = pill_h // 2

    # pill background
    pill = Image.new("RGBA", (pill_w, pill_h), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pill)
    pd.rounded_rectangle([0, 0, pill_w - 1, pill_h - 1], radius=r,
                         fill=(255, 255, 255, 26), outline=(255, 255, 255, 46),
                         width=max(1, int(1.5 * scale)))
    base.alpha_composite(pill, (x, y))

    cx = x + pad
    cy = y + pill_h // 2
    # Claude dot + label
    d.ellipse([cx, cy - dot_r, cx + dot_r * 2, cy + dot_r], fill=CLAUDE)
    cx += dot_r * 2 + gap
    text_tracked(d, (cx, cy - f_chip.size * 0.62), "Claude", f_chip, WHITE)
    cx += measure_tracked(d, "Claude", f_chip)
    # or
    d.text((cx + int(6 * scale), cy - f_or.size * 0.6), "  or  ", font=f_or, fill=SLATE)
    cx += measure_tracked(d, "  or  ", f_or)
    # ChatGPT dot + label
    d.ellipse([cx, cy - dot_r, cx + dot_r * 2, cy + dot_r], fill=CODEX)
    cx += dot_r * 2 + gap
    text_tracked(d, (cx, cy - f_chip.size * 0.62), "ChatGPT", f_chip, WHITE)

    # trailing muted text
    tx = x + pill_w + int(20 * scale)
    tail = "your subscription · no API keys"
    d.text((tx, cy - f_mut.size * 0.62), tail, font=f_mut, fill=SLATE)
    return pill_h

# =============================================================== ICON ========
def render_icon(px=400):
    size = px * SS
    badge = make_badge(size)
    # outer glow so it pops on light registry backgrounds is unnecessary (icon
    # sits in its own cell) -> keep crisp. Downscale.
    out = badge.resize((px, px), Image.LANCZOS)
    # flatten onto nothing: keep alpha (registry shows squircle on its own bg)
    out.save(os.path.join(OUT, "icon.png"))
    print("icon.png", out.size)

# =============================================================== BANNER =======
def render_banner(W=1680, H=720):  # 21:9
    w, h = W * SS, H * SS
    badge_cx = w * 0.20
    base = scene(w, h, glow_cx=badge_cx, glow_cy=h * 0.5, glow_r=w * 0.52)

    # hero badge on the left
    bsize = int(h * 0.66)
    badge = make_badge(bsize)
    # soft drop glow behind badge
    bg_glow = radial_glow(w, h, badge_cx, h * 0.5, bsize * 0.98, BLUE_LT, 0.52, 2.0)
    base = Image.alpha_composite(base, bg_glow)
    bx = int(badge_cx - bsize / 2)
    by = int(h * 0.5 - bsize / 2)
    base.alpha_composite(badge, (bx, by))

    d = ImageDraw.Draw(base)
    tx = bx + bsize + int(78 * SS)
    avail = w - tx - int(56 * SS)

    # --- wordmark: "ComfyUI Agent Panel" (Agent accented) ---
    track = int(-2 * SS)
    # auto-fit font size to available width
    fsize = 152 * SS
    while fsize > 40 * SS:
        fw = font(F_BLACK, fsize)
        wm = measure_tracked(d, "ComfyUI Agent Panel", fw, track)
        if wm <= avail:
            break
        fsize -= 2 * SS
    fw = font(F_BLACK, fsize)

    # vertical layout block, centred-ish on badge axis
    line_h = fsize * 1.0
    tagline_f = font(F_SEMI, 38 * SS)
    block_h = line_h + 26 * SS + tagline_f.size * 1.2 + 30 * SS + 64 * SS
    ty = int(h * 0.5 - block_h / 2)

    # wordmark with per-word color
    x = tx
    words = [("ComfyUI", WHITE), (" ", WHITE), ("Agent", BLUE_LT), (" ", WHITE), ("Panel", WHITE)]
    for word, col in words:
        wlen = text_tracked(d, (x, ty), word, fw, col, tracking=track)
        x += wlen + track

    # tagline
    ty2 = ty + int(line_h) + int(20 * SS)
    d.text((tx, ty2), "Autonomous AI agent in your ComfyUI sidebar",
           font=tagline_f, fill=OFFWHITE)

    # provider chip row
    ty3 = ty2 + int(tagline_f.size * 1.2) + int(28 * SS)
    draw_chip_row(base, tx, ty3, SS)

    flat = vignette(base, strength=0.42, power=2.2)
    out = flat.resize((W, H), Image.LANCZOS)
    out.save(os.path.join(OUT, "banner.png"))
    print("banner.png", out.size)

# =============================================================== OG ==========
def render_og(W=1200, H=630):
    w, h = W * SS, H * SS
    base = scene(w, h, glow_cx=w * 0.5, glow_cy=h * 0.40, glow_r=w * 0.62)

    # centred badge near top
    bsize = int(h * 0.30)
    badge = make_badge(bsize)
    base = Image.alpha_composite(base, radial_glow(w, h, w * 0.5, h * 0.30, bsize * 1.05, BLUE_LT, 0.5, 2.0))
    bx = int(w * 0.5 - bsize / 2)
    by = int(h * 0.135)
    base.alpha_composite(badge, (bx, by))

    d = ImageDraw.Draw(base)
    track = int(-2 * SS)
    fw = font(F_BLACK, 104 * SS)
    # measure full wordmark for centering
    parts = [("ComfyUI ", WHITE), ("Agent", BLUE_LT), (" Panel", WHITE)]
    total = sum(measure_tracked(d, t, fw, track) + track for t, _ in parts) - track
    x = int(w * 0.5 - total / 2)
    ty = by + bsize + int(54 * SS)
    for t, col in parts:
        wl = text_tracked(d, (x, ty), t, fw, col, tracking=track)
        x += wl + track

    # tagline centred
    tf = font(F_SEMI, 40 * SS)
    tg = "Autonomous AI agent in your ComfyUI sidebar"
    tgw = measure_tracked(d, tg, tf)
    ty2 = ty + int(fw.size * 1.05) + int(18 * SS)
    d.text((int(w * 0.5 - tgw / 2), ty2), tg, font=tf, fill=OFFWHITE)

    # chip row centred: build then composite at measured center
    # estimate width by drawing onto a scratch to measure is complex; reuse
    # draw_chip_row but we need centering -> compute pill geometry quickly.
    ty3 = ty2 + int(tf.size * 1.2) + int(30 * SS)
    # measure pill row width using same logic as draw_chip_row
    dd = d
    f_chip = font(F_SEMI, 30 * SS); f_or = font(F_REG, 28 * SS); f_mut = font(F_REG, 30 * SS)
    dot_r = int(9 * SS); gap = int(12 * SS); pad = int(16 * SS)
    seg = lambda l: dot_r * 2 + gap + measure_tracked(dd, l, f_chip)
    parts_w = seg("Claude") + measure_tracked(dd, "  or  ", f_or) + seg("ChatGPT")
    pill_w = int(parts_w + pad * 2)
    tail = "your subscription · no API keys"
    tail_w = measure_tracked(dd, tail, f_mut)
    roww = pill_w + int(20 * SS) + tail_w
    cx = int(w * 0.5 - roww / 2)
    draw_chip_row(base, cx, ty3, SS)

    flat = vignette(base, strength=0.40, power=2.2)
    out = flat.resize((W, H), Image.LANCZOS)
    out.save(os.path.join(OUT, "og.png"))
    print("og.png", out.size)

if __name__ == "__main__":
    render_icon()
    render_banner()
    render_og()
    print("done ->", os.path.abspath(OUT))
