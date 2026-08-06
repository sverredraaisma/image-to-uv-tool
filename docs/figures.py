"""Draw the figures for docs/printed-lenses.md.

    pip install matplotlib numpy
    python docs/figures.py        # writes docs/images/*.png

Nothing in the app depends on this — it is a one-off tool for regenerating the
pictures in the guide, which is why matplotlib is not in package.json.

Most of these are not illustrations of the maths — they *are* the maths. The
lens solve below is a direct port of `lensGeometry()` in src/lib/lenticular.ts,
and the cross-sections, the feasibility curve, the quantisation plot and the
interlace comparison are all drawn from it, at true scale wherever the shape
allows. If the implementation changes, rerun this and the pictures follow.
"""

from __future__ import annotations

import math
import os

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import Arc, Circle, FancyArrowPatch, Polygon, Rectangle, Wedge

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "images")

# A restrained palette: dark ink for structure, amber for the clear-ink relief,
# blue for the artwork, green for light.
INK = "#1f2933"
SUB = "#7b8794"
FAINT = "#cbd2d9"
GLOSS = "#c98a10"
GLOSS_FILL = "#fdf1d6"
ART = "#2f6fd0"
ART_FILL = "#dce8fb"
RAY = "#1f9e6f"
WARN = "#c2410c"

plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 10,
        "axes.edgecolor": SUB,
        "axes.labelcolor": INK,
        "text.color": INK,
        "xtick.color": SUB,
        "ytick.color": SUB,
        "figure.facecolor": "white",
        "savefig.facecolor": "white",
    }
)


# ---------------------------------------------------------------------------
# The lens solve — a port of lensGeometry() in src/lib/lenticular.ts
# ---------------------------------------------------------------------------


class Lens:
    def __init__(self, lpi: float, height_mm: float, ri: float, ppi: float = 1440.0):
        n = max(1.0001, ri)
        h = max(1e-6, height_mm)
        self.lpi, self.n, self.H, self.ppi = lpi, n, h, ppi
        self.pitch = 25.4 / lpi
        self.pitch_px = ppi / lpi
        half = self.pitch / 2
        self.min_height = n * self.pitch / (2 * (n - 1))
        disc = h * h * (n - 1) ** 2 - n * n * half * half
        self.feasible = disc >= 0
        self.sag = (h * (n - 1) - math.sqrt(disc)) / n if self.feasible else half
        self.radius = (self.sag**2 + half**2) / (2 * self.sag)
        self.focus = n * self.radius / (n - 1)
        self.base = max(0.0, h - self.sag)
        self.total = self.base + self.sag
        sin_in = half / math.hypot(half, self.focus)
        self.view_angle = 2 * math.degrees(math.asin(min(1.0, n * sin_in)))

    def profile(self, d):
        """Surface height above the substrate, at offset d from the lens axis."""
        d = np.asarray(d, dtype=float)
        inside = np.abs(d) <= self.pitch / 2
        arc = np.sqrt(np.maximum(0.0, self.radius**2 - d**2)) - (self.radius - self.sag)
        return np.where(inside, self.base + np.maximum(0.0, arc), self.base)


DEFAULT = Lens(lpi=45, height_mm=0.9, ri=1.5)


def save(fig, name: str):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    fig.savefig(path, dpi=170, bbox_inches="tight", pad_inches=0.18)
    plt.close(fig)
    print(f"  {name}")


def box(ax, x, y, w, h, label, *, fc="white", ec=INK, fs=9.5, lw=1.2, weight="normal"):
    ax.add_patch(
        Rectangle((x, y), w, h, facecolor=fc, edgecolor=ec, linewidth=lw, zorder=2, joinstyle="round")
    )
    ax.text(
        x + w / 2, y + h / 2, label, ha="center", va="center", fontsize=fs, zorder=3, weight=weight
    )


def arrow(ax, a, b, *, color=INK, lw=1.3, style="-|>", ms=9):
    ax.add_patch(
        FancyArrowPatch(
            a, b, arrowstyle=style, mutation_scale=ms, color=color, linewidth=lw, zorder=2
        )
    )


def clean(ax):
    ax.set_xticks([])
    ax.set_yticks([])
    for side in ax.spines.values():
        side.set_visible(False)


# ---------------------------------------------------------------------------
# 1 — what the pipeline does
# ---------------------------------------------------------------------------


def fig_overview():
    fig, ax = plt.subplots(figsize=(11.0, 4.4))
    clean(ax)
    ax.set_xlim(0, 103)
    ax.set_ylim(0, 42)

    box(ax, 3, 26, 25, 8, "your N views", fc=ART_FILL, ec=ART, fs=11)
    box(ax, 36, 26, 28, 8, "interlaced artwork\nsmall raster · flat ink", fc=ART_FILL, ec=ART, fs=9.5)
    box(ax, 3, 8, 25, 8, "print settings\nwidth · PPI · LPI\nH · n · angle · phase", fs=8.8)
    box(ax, 36, 8, 28, 8, "solve the lens\nradius, sag, base", fs=10, weight="bold")
    box(ax, 72, 8, 28, 8, "relief height map\nprinter raster · 16-bit", fc=GLOSS_FILL, ec=GLOSS, fs=9.5)
    box(ax, 72, 24, 28, 12, "the print\ncolour ink, then\nclear ink on top", fs=10.5, weight="bold")

    arrow(ax, (28, 30), (35.4, 30), color=ART)
    arrow(ax, (28, 12), (35.4, 12))
    arrow(ax, (64, 12), (71.4, 12), color=GLOSS)
    arrow(ax, (86, 16), (86, 23.4), color=GLOSS)
    arrow(ax, (64, 30), (71.4, 30), color=ART)
    ax.add_patch(
        FancyArrowPatch(
            (50, 16), (50, 25.4), arrowstyle="-|>", mutation_scale=9,
            color=SUB, lw=1.1, linestyle=(0, (3, 3)), zorder=2,
        )
    )
    ax.text(51.5, 20.7, "same pitch\nand phase", fontsize=8.2, color=SUB, va="center")

    ax.text(
        51, 2.4,
        "Both halves come out of the same machine in the same job, so they line up by construction.",
        ha="center", fontsize=9.3, color=SUB, style="italic",
    )
    save(fig, "01-overview.png")


# ---------------------------------------------------------------------------
# 2 — cross-section of the finished print, at true scale
# ---------------------------------------------------------------------------


def fig_cross_section():
    L = DEFAULT
    lenses = 4
    w = L.pitch * lenses
    fig, ax = plt.subplots(figsize=(10, 4.4))
    ax.set_xlim(-0.78, w + 0.62)
    ax.set_ylim(-0.30, L.H + 0.20)
    ax.set_aspect("equal")
    clean(ax)

    x = np.linspace(0, w, 3000)
    d = ((x + L.pitch / 2) % L.pitch) - L.pitch / 2
    z = L.profile(d)

    ax.fill_between(x, 0, z, color=GLOSS_FILL, zorder=1)
    ax.plot(x, z, color=GLOSS, lw=1.8, zorder=3)
    ax.plot([0, w], [L.base, L.base], color=GLOSS, lw=0.9, ls=(0, (5, 3)), zorder=3)

    ax.add_patch(Rectangle((0, -0.055), w, 0.055, facecolor=ART, edgecolor="none", zorder=2))
    for i in range(lenses * 4):
        ax.plot([w * i / (lenses * 4)] * 2, [-0.055, 0], color="white", lw=0.7, zorder=3)
    ax.add_patch(Rectangle((0, -0.24), w, 0.185, facecolor="#eef1f4", edgecolor=SUB, lw=0.9))
    ax.text(w / 2, -0.148, "substrate", ha="center", va="center", fontsize=9, color=SUB)
    ax.annotate(
        "interlaced artwork",
        xy=(w * 0.30, -0.028), xytext=(-0.10, -0.14), fontsize=9, color=ART, ha="right",
        arrowprops=dict(arrowstyle="->", color=ART, lw=1.0),
    )

    xa = w + 0.13
    ax.annotate(
        "",
        xy=(xa, L.H),
        xytext=(xa, L.base),
        arrowprops=dict(arrowstyle="<->", color=INK, lw=1.1),
    )
    ax.text(xa + 0.05, (L.H + L.base) / 2, f"sag\n{L.sag:.3f} mm", va="center", fontsize=9)
    ax.annotate(
        "", xy=(xa, L.base), xytext=(xa, 0), arrowprops=dict(arrowstyle="<->", color=INK, lw=1.1)
    )
    ax.text(xa + 0.05, L.base / 2, f"flat base\n{L.base:.3f} mm", va="center", fontsize=9)

    xb = w + 0.52
    ax.annotate(
        "", xy=(xb, L.H), xytext=(xb, 0), arrowprops=dict(arrowstyle="<->", color=GLOSS, lw=1.4)
    )
    ax.text(
        xb + 0.05,
        L.H / 2,
        f"H = {L.H} mm",
        va="center",
        fontsize=9.5,
        color=GLOSS,
        weight="bold",
        rotation=90,
        ha="center",
    )

    ax.annotate(
        "",
        xy=(0, L.H + 0.09),
        xytext=(L.pitch, L.H + 0.09),
        arrowprops=dict(arrowstyle="<->", color=INK, lw=1.1),
    )
    ax.text(
        L.pitch / 2, L.H + 0.125, f"pitch p = {L.pitch:.3f} mm", ha="center", fontsize=9.5
    )

    ax.text(
        w / 2,
        -0.30,
        f"True scale. 45 LPI, H = 0.9 mm, n = 1.5. The clear ink is the only thing between "
        f"the lens and the image.",
        ha="center",
        fontsize=9,
        color=SUB,
        style="italic",
    )
    save(fig, "02-cross-section.png")


# ---------------------------------------------------------------------------
# 3 — the focus condition
# ---------------------------------------------------------------------------


def fig_focus():
    L = DEFAULT
    half = L.pitch / 2
    fig, ax = plt.subplots(figsize=(7.6, 6.4))
    ax.set_xlim(-0.62, 0.62)
    ax.set_ylim(-0.12, L.H + 0.34)
    ax.set_aspect("equal")
    clean(ax)

    top = L.H
    xs = np.linspace(-half, half, 400)
    surf = top - (L.sag - (np.sqrt(L.radius**2 - xs**2) - (L.radius - L.sag)))
    ax.fill_between(xs, 0, surf, color=GLOSS_FILL, zorder=1)
    ax.plot(xs, surf, color=GLOSS, lw=2, zorder=3)
    ax.plot([-half, -0.6], [top - L.sag, top - L.sag], color=GLOSS, lw=1.2, zorder=3)
    ax.plot([half, 0.6], [top - L.sag, top - L.sag], color=GLOSS, lw=1.2, zorder=3)
    ax.fill_between([-0.6, -half], 0, top - L.sag, color=GLOSS_FILL, zorder=1)
    ax.fill_between([half, 0.6], 0, top - L.sag, color=GLOSS_FILL, zorder=1)

    ax.add_patch(Rectangle((-0.6, -0.05), 1.2, 0.05, facecolor=ART, edgecolor="none", zorder=2))
    ax.text(0, -0.093, "artwork, at the base of the stack", ha="center", fontsize=9, color=ART)

    for xr in np.linspace(-half * 0.92, half * 0.92, 9):
        y_top = top + 0.30
        y_hit = top - (L.sag - (math.sqrt(L.radius**2 - xr**2) - (L.radius - L.sag)))
        ax.plot([xr, xr], [y_top, y_hit], color=RAY, lw=1.1, zorder=4)
        ax.plot([xr, 0], [y_hit, 0], color=RAY, lw=1.1, zorder=4)
    ax.text(0, top + 0.335, "light from far away", ha="center", fontsize=9.5, color=RAY)

    ax.plot([0], [0], marker="o", ms=8, color=RAY, zorder=6)
    ax.annotate(
        "every ray meets here",
        xy=(0, 0),
        xytext=(0.30, 0.30),
        fontsize=9.5,
        color=RAY,
        arrowprops=dict(arrowstyle="->", color=RAY, lw=1.1),
    )

    ax.annotate(
        "", xy=(-0.52, top), xytext=(-0.52, 0), arrowprops=dict(arrowstyle="<->", color=INK, lw=1.2)
    )
    ax.text(
        -0.545,
        top / 2,
        "focus distance  n·R/(n−1)\nmust equal H",
        rotation=90,
        ha="center",
        va="center",
        fontsize=9.5,
    )

    ax.text(
        -0.30,
        0.30,
        "R = H(n−1)/n",
        ha="center",
        fontsize=13,
        weight="bold",
        bbox=dict(boxstyle="round,pad=0.35", fc="white", ec=GLOSS, lw=1.3),
    )
    save(fig, "03-focus.png")


# ---------------------------------------------------------------------------
# 4 — sag, chord and radius
# ---------------------------------------------------------------------------


def fig_chord():
    L = DEFAULT
    half = L.pitch / 2
    fig, ax = plt.subplots(figsize=(7.4, 6.0))
    ax.set_aspect("equal")
    clean(ax)

    cy = -(L.radius - L.sag)
    xs = np.linspace(-half, half, 400)
    ys = np.sqrt(L.radius**2 - xs**2) + cy

    circ = Circle((0, cy), L.radius, fill=False, ec=FAINT, lw=1.1, ls=(0, (4, 4)))
    ax.add_patch(circ)
    ax.plot(xs, ys, color=GLOSS, lw=2.6, zorder=4)
    ax.plot([-half, half], [0, 0], color=INK, lw=1.4, zorder=3)
    ax.plot([0, 0], [cy, L.sag], color=SUB, lw=1.0, ls=(0, (3, 3)))
    ax.plot([0, half], [cy, 0], color=SUB, lw=1.0, ls=(0, (3, 3)))
    ax.plot([0], [cy], marker="o", ms=5, color=SUB)

    ax.annotate(
        "", xy=(-half, -0.075), xytext=(half, -0.075), arrowprops=dict(arrowstyle="<->", color=INK)
    )
    ax.text(0, -0.115, "chord = pitch p", ha="center", fontsize=10)
    ax.annotate(
        "", xy=(half + 0.06, 0), xytext=(half + 0.06, L.sag), arrowprops=dict(arrowstyle="<->", color=INK)
    )
    ax.text(half + 0.085, L.sag / 2, "sag s", va="center", fontsize=10)
    ax.text(0.055, cy + L.radius * 0.42, "R", fontsize=11, color=SUB)
    ax.text(0.11, cy * 0.55, "R", fontsize=11, color=SUB)
    ax.text(0, cy - 0.055, "centre of curvature", ha="center", fontsize=9, color=SUB)

    ax.text(
        0,
        L.sag + 0.13,
        "R = (s² + (p/2)²) / 2s",
        ha="center",
        fontsize=12.5,
        weight="bold",
        bbox=dict(boxstyle="round,pad=0.3", fc="white", ec=GLOSS, lw=1.2),
    )
    ax.set_xlim(-0.42, 0.42)
    ax.set_ylim(cy - 0.11, L.sag + 0.22)
    ax.text(
        0,
        cy - 0.10,
        "The lens is a slice of a circle. Two ways of writing R, one unknown left: the sag.",
        ha="center",
        fontsize=9,
        color=SUB,
        style="italic",
    )
    save(fig, "04-chord.png")


# ---------------------------------------------------------------------------
# 5 — the feasibility floor
# ---------------------------------------------------------------------------


def fig_feasibility():
    fig, ax = plt.subplots(figsize=(9.2, 5.4))
    lpi = np.linspace(15, 120, 400)

    for n, style in ((1.4, (0, (2, 2))), (1.5, "-"), (1.6, (0, (5, 2)))):
        h_min = n * (25.4 / lpi) / (2 * (n - 1))
        ax.plot(
            lpi, h_min, color=INK if n == 1.5 else SUB, ls=style,
            lw=2 if n == 1.5 else 1.3, label=f"n = {n}",
        )

    ax.fill_between(lpi, 1.5 * (25.4 / lpi) / 1.0, 3.2, color="#eaf5ef", zorder=0)
    ax.fill_between(lpi, 0, 1.5 * (25.4 / lpi) / 1.0, color="#fdeeea", zorder=0)
    ax.text(90, 2.2, "focuses — two roots,\ntake the shallow one", fontsize=10, color="#1f7a55")
    ax.text(30, 0.22, "cannot focus at any profile\n(shading drawn for n = 1.5)", fontsize=10, color=WARN)

    ax.axhline(0.9, color=GLOSS, lw=1.6, ls=(0, (6, 3)))
    ax.text(112, 0.97, "0.9 mm of ink", fontsize=9.5, color=GLOSS, weight="bold", ha="right")

    # 40 LPI is deliberately left unlabelled: it sits almost on top of 45, and
    # 45 is the one worth naming because it is the tool's default.
    offsets = {20: (3, 0.16), 30: (3, 0.18), 45: (5, -0.40), 60: (4, 0.16), 100: (-19, 0.20)}
    for lpi_v, (dx, dy) in offsets.items():
        L = Lens(lpi_v, 0.9, 1.5)
        ok = L.feasible
        ax.plot([lpi_v], [L.min_height], marker="o", ms=7, color="#1f7a55" if ok else WARN, zorder=5)
        ax.annotate(
            f"{lpi_v} LPI\n{L.min_height:.3f} mm",
            xy=(lpi_v, L.min_height),
            xytext=(lpi_v + dx, L.min_height + dy),
            fontsize=8.5,
            color="#1f7a55" if ok else WARN,
            arrowprops=dict(arrowstyle="-", color="#1f7a55" if ok else WARN, lw=0.7, alpha=0.6),
        )

    ax.set_xlabel("lens density (LPI)")
    ax.set_ylabel("minimum clear-ink height (mm)")
    ax.set_xlim(15, 128)
    ax.set_ylim(0, 3.0)
    ax.set_title("Coarse lenses need thick ink", fontsize=12, weight="bold", loc="left", pad=12)
    ax.legend(loc="upper right", frameon=True, framealpha=0.95, edgecolor=FAINT, fontsize=9.5)
    ax.grid(color=FAINT, lw=0.6)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    save(fig, "05-feasibility.png")


# ---------------------------------------------------------------------------
# 6 — the viewing cone
# ---------------------------------------------------------------------------


def fig_cone():
    L = DEFAULT
    half = L.pitch / 2
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(11.2, 5.0), gridspec_kw={"width_ratios": [1, 1.15]})

    ax.set_aspect("equal")
    clean(ax)
    top = L.H
    xs = np.linspace(-half, half, 300)
    surf = top - (L.sag - (np.sqrt(L.radius**2 - xs**2) - (L.radius - L.sag)))
    ax.fill_between(xs, 0, surf, color=GLOSS_FILL)
    ax.plot(xs, surf, color=GLOSS, lw=2)
    ax.add_patch(Rectangle((-half, -0.05), L.pitch, 0.05, facecolor=ART, edgecolor="none"))

    inside = math.degrees(math.atan(half / L.focus))
    out = L.view_angle / 2
    for sgn in (-1, 1):
        ax.plot([0, sgn * half], [0, top - L.sag], color=RAY, lw=1.4)
        tip_x = sgn * half + sgn * 0.42 * math.sin(math.radians(out))
        tip_y = (top - L.sag) + 0.42 * math.cos(math.radians(out))
        ax.plot([sgn * half, tip_x], [top - L.sag, tip_y], color=RAY, lw=1.4)
    ax.add_patch(
        Wedge((0, 0), 0.30, 90 - inside, 90 + inside, facecolor=RAY, alpha=0.13, edgecolor="none")
    )
    ax.text(0, 0.34, f"{2 * inside:.0f}°\ninside", ha="center", fontsize=9, color=RAY)
    ax.text(
        0,
        top + 0.30,
        f"{L.view_angle:.1f}° in air",
        ha="center",
        fontsize=12,
        weight="bold",
        color=RAY,
    )
    ax.set_xlim(-0.62, 0.62)
    ax.set_ylim(-0.14, top + 0.52)
    ax.set_title("refraction widens the cone", fontsize=10.5, color=SUB, loc="left")

    ratios = np.linspace(0.05, 1.2, 300)
    for n, col in ((1.4, SUB), (1.5, INK), (1.6, SUB)):
        sin_in = ratios / np.sqrt(ratios**2 + 1)
        ang = 2 * np.degrees(np.arcsin(np.clip(n * sin_in, 0, 1)))
        cap = 2 * math.degrees(math.asin(min(1.0, n * (0.5 / math.hypot(0.5, n / (2 * (n - 1)))))))
        ang = np.minimum(ang, cap)
        bx.plot(ratios, ang, color=col, lw=2 if n == 1.5 else 1.2, ls="-" if n == 1.5 else (0, (4, 3)))
        bx.text(1.21, cap, f"n = {n}  (max {cap:.0f}°)", fontsize=9, va="center", color=col)
    r_def = (L.pitch / 2) / L.H
    bx.plot([r_def], [L.view_angle], marker="o", ms=8, color=GLOSS, zorder=5)
    bx.annotate(
        f"the defaults\n{L.view_angle:.1f}°",
        xy=(r_def, L.view_angle),
        xytext=(r_def + 0.12, L.view_angle - 14),
        fontsize=9.5,
        color=GLOSS,
        arrowprops=dict(arrowstyle="->", color=GLOSS),
    )
    bx.set_xlabel("(p/2) / H     — a ratio, so pitch and height only matter together")
    bx.set_ylabel("full viewing cone (°)")
    bx.set_xlim(0, 1.55)
    bx.set_ylim(0, 90)
    bx.grid(color=FAINT, lw=0.6)
    bx.set_axisbelow(True)
    for s in ("top", "right"):
        bx.spines[s].set_visible(False)
    bx.set_title("and the index sets the ceiling", fontsize=10.5, color=SUB, loc="left")
    save(fig, "06-viewing-cone.png")


# ---------------------------------------------------------------------------
# 7 — how one lens is divided
# ---------------------------------------------------------------------------


def fig_interlace():
    L = DEFAULT
    N = 4
    fig, ax = plt.subplots(figsize=(9.6, 5.0))
    clean(ax)
    ax.set_xlim(-0.16, 1.16)
    ax.set_ylim(-0.42, 1.06)

    xs = np.linspace(0, 1, 300)
    lens_y = 0.62 + 0.24 * np.sqrt(np.maximum(0, 1 - (2 * xs - 1) ** 2))
    ax.fill_between(xs, 0.62, lens_y, color=GLOSS_FILL)
    ax.plot(xs, lens_y, color=GLOSS, lw=2)
    ax.plot([0, 1], [0.62, 0.62], color=GLOSS, lw=1.2, ls=(0, (5, 3)))

    cols = ["#dce8fb", "#bcd4f6", "#9cc0f1", "#7cadec"]
    for k in range(N):
        x0 = k / N
        ax.add_patch(
            Rectangle((x0, 0.18), 1 / N, 0.30, facecolor=cols[k], edgecolor=ART, lw=1.1, zorder=2)
        )
        ax.text(x0 + 0.5 / N, 0.33, f"view {k + 1}", ha="center", va="center", fontsize=10, zorder=3)
        ax.text(x0 + 0.5 / N, 0.115, f"t = {k / N:.2f}…{(k + 1) / N:.2f}", ha="center", fontsize=8.2, color=SUB)

    ax.annotate("", xy=(0, 0.05), xytext=(1, 0.05), arrowprops=dict(arrowstyle="<->", color=INK))
    ax.text(0.5, -0.005, "one lens, pitch p", ha="center", va="top", fontsize=10)

    ax.plot([0.5, 0.5], [0.18, 0.92], color=WARN, lw=1.5, ls=(0, (4, 3)), zorder=4)
    ax.plot([0.5], [0.18], marker="v", ms=9, color=WARN, zorder=5)
    ax.text(
        0.52,
        0.95,
        "all four tiles sample their own view HERE, at the lens centre",
        fontsize=9.8,
        color=WARN,
        va="center",
    )

    ax.text(
        0.5,
        -0.30,
        "The eye sees one tile at a time. Which tile depends on where the eye is.",
        ha="center",
        fontsize=9.5,
        color=SUB,
        style="italic",
    )
    save(fig, "07-interlace.png")


# ---------------------------------------------------------------------------
# 8 — why sampling at the lens centre matters (computed, not drawn)
# ---------------------------------------------------------------------------


def fig_sampling():
    """Compare the two sampling rules the only way that shows the difference:
    ask each view, at the same lens, which point of the source it is showing."""
    L = DEFAULT
    N, lenses = 4, 6
    j = np.arange(lenses)
    cols = ["#2f6fd0", "#c98a10", "#1f9e6f", "#c2410c"]

    fig, (ax, bx) = plt.subplots(1, 2, figsize=(11.0, 5.0), sharey=True)

    for view, col in zip(range(N), cols):
        # Rule A — every tile of a lens samples that lens's centre.
        # Nested rings: four series exactly on top of each other, drawn at
        # increasing radius so you can see that all four are really there.
        ax.plot(j, (j + 0.5) * L.pitch, "o", ms=7 + view * 5, mfc="none", mew=1.9, color=col,
                label=f"view {view + 1}")
        # Rule B — each tile samples wherever it happens to sit.
        bx.plot(j, (j + (view + 0.5) / N) * L.pitch, "o", ms=9, color=col, label=f"view {view + 1}")

    for a in (ax, bx):
        a.set_xlabel("lens number, across the sheet")
        a.set_xticks(j)
        a.grid(color=FAINT, lw=0.6)
        a.set_axisbelow(True)
        for s in ("top", "right"):
            a.spines[s].set_visible(False)
    ax.set_ylabel("the point of the source that this view shows (mm)")

    ax.set_title("Sampling at the lens centre", fontsize=12, weight="bold", loc="left", color=RAY)
    ax.text(
        0.02, 0.93,
        "All four views land on the same point.\nOne lens = one pixel of the picture,\nseen four ways.",
        transform=ax.transAxes, fontsize=9.8, va="top", color=RAY,
    )
    bx.set_title("Sampling where the pixel sits", fontsize=12, weight="bold", loc="left", color=WARN)
    bx.text(
        0.02, 0.93,
        "The views are staggered. Each one shows\na slightly different part of the source.",
        transform=bx.transAxes, fontsize=9.8, va="top", color=WARN,
    )

    span = 1
    bx.annotate(
        "",
        xy=(span, span * L.pitch + 0.5 / N * L.pitch),
        xytext=(span, span * L.pitch + 3.5 / N * L.pitch),
        arrowprops=dict(arrowstyle="<->", color=WARN, lw=1.6),
    )
    bx.text(
        span + 0.30,
        span * L.pitch + 2.0 / N * L.pitch,
        f"{(N - 1) / N * L.pitch * 1000:.0f} µm of drift\nbetween views —\nthe image crawls\nsideways as it flips",
        fontsize=9.5,
        color=WARN,
        va="center",
    )
    ax.legend(frameon=False, fontsize=9, loc="lower right", ncol=2)
    save(fig, "08-lens-centre-sampling.png")


# ---------------------------------------------------------------------------
# 9 — two rasters, two jobs
# ---------------------------------------------------------------------------


def fig_dual_raster():
    fig, ax = plt.subplots(figsize=(9.6, 4.6))
    clean(ax)
    ax.set_xlim(0, 100)
    ax.set_ylim(-8, 62)
    ax.set_aspect("equal")

    scale = 52 / 5669
    ax.add_patch(
        Rectangle((4, 4), 5669 * scale, 4252 * scale, facecolor=GLOSS_FILL, edgecolor=GLOSS, lw=1.6)
    )
    ax.add_patch(
        Rectangle((64, 4), 1063 * scale, 797 * scale, facecolor=ART_FILL, edgecolor=ART, lw=1.6)
    )

    ax.text(4 + 5669 * scale / 2, 4 + 4252 * scale / 2 + 4, "relief height map", ha="center", fontsize=11, weight="bold")
    ax.text(4 + 5669 * scale / 2, 4 + 4252 * scale / 2 - 2, "5669 × 4252 px", ha="center", fontsize=10, color=SUB)
    ax.text(4 + 5669 * scale / 2, 4 + 4252 * scale / 2 - 7, "24.1 megapixels", ha="center", fontsize=10, color=SUB)
    ax.text(
        4 + 5669 * scale / 2,
        -4,
        "It IS the lens — its resolution is how smooth\nthe printed surface can be. Printer raster.",
        ha="center",
        fontsize=9.3,
        color=GLOSS,
    )

    ax.text(64 + 1063 * scale / 2, 4 + 797 * scale + 4, "interlaced artwork", ha="center", fontsize=11, weight="bold")
    ax.text(64 + 1063 * scale / 2, 4 + 797 * scale / 2 + 1, "1063 × 797 px", ha="center", fontsize=9.5, color=SUB)
    ax.text(64 + 1063 * scale / 2, 4 + 797 * scale / 2 - 3.5, "0.85 MP", ha="center", fontsize=9.5, color=SUB)
    ax.text(
        64 + 1063 * scale / 2,
        -4,
        "Flat ink. The RIP scales it.\n1/28 of the pixels, same result.",
        ha="center",
        fontsize=9.3,
        color=ART,
    )
    ax.text(50, 58, "Same physical sheet. Very different jobs.", ha="center", fontsize=11.5, weight="bold")
    save(fig, "09-dual-raster.png")


# ---------------------------------------------------------------------------
# 10 — why 16 bits
# ---------------------------------------------------------------------------


def fig_quantisation():
    L = DEFAULT
    d = np.linspace(-L.pitch / 2, L.pitch / 2, 2000)
    z = L.profile(d)
    fig, ax = plt.subplots(figsize=(9.4, 5.2))

    q8 = np.round(z / L.H * 255) / 255 * L.H
    ax.plot(d * 1000, z * 1000, color=RAY, lw=2.4, label="the lens you asked for (16-bit is this, to 0.014 µm)")
    ax.step(d * 1000, q8 * 1000, where="mid", color=WARN, lw=1.5, label="what 8 bits gives you (3.53 µm steps)")

    ax.set_xlabel("across the lens (µm)")
    ax.set_ylabel("height above the substrate (µm)")
    ax.legend(loc="upper left", frameon=False, fontsize=9.5)
    ax.grid(color=FAINT, lw=0.6)
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)

    # Tucked under the arc, where the plot is empty.
    inset = ax.inset_axes([0.33, 0.06, 0.34, 0.31])
    m = np.abs(d) < L.pitch * 0.10
    inset.plot(d[m] * 1000, z[m] * 1000, color=RAY, lw=2)
    inset.step(d[m] * 1000, q8[m] * 1000, where="mid", color=WARN, lw=1.4)
    inset.set_title("near the apex", fontsize=8.5, color=SUB)
    inset.tick_params(labelsize=7)
    inset.grid(color=FAINT, lw=0.5)

    ax.set_title(
        f"The whole arc is only {L.sag * 1000:.0f} µm tall — 8 bits spends just "
        f"{L.sag / L.H * 256:.0f} of its 256 levels on it",
        fontsize=11,
        weight="bold",
        loc="left",
        pad=12,
    )
    save(fig, "10-quantisation.png")


# ---------------------------------------------------------------------------
# 11 — the 2D grid in plan
# ---------------------------------------------------------------------------


def fig_grid_plan():
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(11.0, 5.2))
    for a in (ax, bx):
        a.set_aspect("equal")
        clean(a)

    n = 3
    for r in range(n):
        for c in range(n):
            ax.add_patch(Rectangle((c, n - 1 - r), 1, 1, facecolor=GLOSS_FILL, edgecolor=SUB, lw=0.9))
            ax.add_patch(Circle((c + 0.5, n - 1 - r + 0.5), 0.5, facecolor="white", edgecolor=GLOSS, lw=1.8))
    for r in range(n):
        for c in range(n):
            for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
                ax.plot([c + dx], [n - 1 - r + dy], marker="s", ms=3.4, color=GLOSS, alpha=0.55)
    ax.set_xlim(-0.25, n + 0.25)
    ax.set_ylim(-0.55, n + 0.35)
    ax.set_title("lenslets, one per cell", fontsize=11, weight="bold", loc="left")
    ax.text(
        n / 2,
        -0.42,
        "The cap is one pitch wide, so in a square array the corners\n(21.5% of the area) stay flat and do not focus.",
        ha="center",
        fontsize=9.2,
        color=SUB,
    )

    g = 3
    for r in range(g):
        for c in range(g):
            shade = "#dce8fb" if (r + c) % 2 == 0 else "#bcd4f6"
            bx.add_patch(Rectangle((c, g - 1 - r), 1, 1, facecolor=shade, edgecolor=ART, lw=1.0))
            bx.text(c + 0.5, g - 1 - r + 0.5, f"{c + 1},{r + 1}", ha="center", va="center", fontsize=11)
    bx.add_patch(Circle((g / 2, g / 2), g / 2, fill=False, ec=GLOSS, lw=2.4, ls=(0, (5, 3))))
    bx.set_xlim(-0.25, g + 0.25)
    bx.set_ylim(-0.55, g + 0.35)
    bx.set_title("one cell, magnified: 3 × 3 = 9 tiles beneath it", fontsize=11, weight="bold", loc="left")
    bx.text(
        g / 2,
        -0.42,
        "Each tile holds one view. The cap above picks exactly one,\naccording to where your eye is.",
        ha="center",
        fontsize=9.2,
        color=SUB,
    )
    save(fig, "11-grid-plan.png")


# ---------------------------------------------------------------------------
# 12 — cap profile through the axis and the diagonal
# ---------------------------------------------------------------------------


def fig_grid_profile():
    L = DEFAULT
    fig, ax = plt.subplots(figsize=(9.4, 4.4))
    half = L.pitch / 2
    diag = half * math.sqrt(2)

    d = np.linspace(-diag, diag, 1500)
    z = L.profile(d)
    ax.fill_between(d * 1000, 0, z * 1000, color=GLOSS_FILL)
    ax.plot(d * 1000, z * 1000, color=GLOSS, lw=2.2)
    ax.axhline(L.base * 1000, color=GLOSS, lw=1.0, ls=(0, (5, 3)))

    for sgn in (-1, 1):
        ax.axvline(sgn * half * 1000, color=SUB, lw=1.0, ls=(0, (3, 3)))
        ax.axvline(sgn * diag * 1000, color=FAINT, lw=1.0)
    ax.axvspan(half * 1000, diag * 1000, color="#f4f6f8", zorder=0)
    ax.axvspan(-diag * 1000, -half * 1000, color="#f4f6f8", zorder=0)

    ax.text(0, (L.base + L.sag * 0.55) * 1000, "cap", ha="center", fontsize=11, weight="bold")
    ax.text((half + diag) / 2 * 1000, L.base * 1000 * 1.03, "flat corner", ha="center", fontsize=9.5, color=SUB)
    ax.text(-(half + diag) / 2 * 1000, L.base * 1000 * 1.03, "flat corner", ha="center", fontsize=9.5, color=SUB)
    ax.text(half * 1000 + 6, L.base * 1000 * 0.55, "cell edge\n(p/2)", fontsize=8.5, color=SUB)
    ax.text(diag * 1000 - 46, L.base * 1000 * 0.55, "cell corner\n(p/√2)", fontsize=8.5, color=SUB)

    ax.set_xlabel("distance from the cell centre (µm)")
    ax.set_ylabel("height (µm)")
    ax.set_ylim(0, L.H * 1000 * 1.06)
    ax.grid(color=FAINT, lw=0.5, axis="y")
    ax.set_axisbelow(True)
    for s in ("top", "right"):
        ax.spines[s].set_visible(False)
    ax.set_title(
        "A slice through the diagonal of a cell: the cap runs out before the corner does",
        fontsize=11,
        weight="bold",
        loc="left",
        pad=10,
    )
    save(fig, "12-grid-profile.png")


# ---------------------------------------------------------------------------
# 12b — square against hexagonal packing of the same caps
# ---------------------------------------------------------------------------


def fig_packing():
    """The two lenslet arrangements, drawn with caps of the same one-pitch width.

    Amber is sheet left flat at base height; white discs are the caps. The fill
    fractions quoted are exact: pi/4 for the square array, pi/(2*sqrt(3)) for
    the hexagonal one, which is the densest packing of equal circles there is.
    """
    row = math.sqrt(3) / 2
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(11.0, 4.8))
    # Both panels are a window onto an array that carries on past the edges;
    # everything is drawn generously and clipped to the same 4p × 3.5p patch.
    for a in (ax, bx):
        a.set_aspect("equal")
        clean(a)
        a.set_xlim(0, 4)
        a.set_ylim(0, 3.5)
        # The flat sheet the caps stand on, so whatever they miss reads as amber.
        a.add_patch(Rectangle((0, 0), 4, 3.5, facecolor=GLOSS_FILL, edgecolor="none", zorder=0))

    # Square: rows and columns a full pitch apart, each cap touching four others.
    for r in range(-1, 5):
        for c in range(-1, 5):
            ax.add_patch(Rectangle((c, r), 1, 1, facecolor="none", edgecolor=SUB, lw=0.8, zorder=1))
            ax.add_patch(
                Circle((c + 0.5, r + 0.5), 0.5, facecolor="white", edgecolor=GLOSS, lw=1.7, zorder=2)
            )
    arrow(ax, (1.5, 1.5), (2.5, 1.5), style="<|-|>", ms=7)
    ax.text(2.0, 1.62, "p", ha="center", fontsize=10.5, style="italic", zorder=4)
    ax.set_title("square grid — 4 neighbours", fontsize=11, weight="bold", loc="left")
    ax.set_xlabel(
        "Caps fill π/4 = 78.5% of the sheet.\nThe four corners of every cell, 21.5%, stay flat.",
        fontsize=9.2,
        color=SUB,
        labelpad=10,
    )

    # Hex: odd rows offset half a pitch, so rows sit p·√3/2 apart and each cap
    # touches six others. One Voronoi cell is outlined to show the footprint.
    for r in range(-1, 6):
        for c in range(-1, 6):
            x = c + (0.5 if r % 2 else 0.0)
            bx.add_patch(Circle((x, r * row), 0.5, facecolor="white", edgecolor=GLOSS, lw=1.7, zorder=2))
    hexagon = [
        (1.0 + (0.5 / row) * math.cos(math.radians(a)), 2 * row + (0.5 / row) * math.sin(math.radians(a)))
        for a in range(30, 360, 60)
    ]
    bx.add_patch(Polygon(hexagon, closed=True, fill=False, ec=ART, lw=1.9, ls=(0, (4, 2.5)), zorder=3))
    arrow(bx, (2.5, row), (3.5, row), style="<|-|>", ms=7)
    bx.text(3.0, row + 0.12, "p", ha="center", fontsize=10.5, style="italic", zorder=4)
    arrow(bx, (3.5, 2 * row), (3.5, 3 * row), style="<|-|>", ms=7)
    bx.text(3.42, 2.5 * row, "p·√3/2", ha="right", va="center", fontsize=9.5, style="italic", zorder=4)
    bx.set_title("hexagonal — 6 neighbours, rows 13% closer", fontsize=11, weight="bold", loc="left")
    bx.set_xlabel(
        "The same caps fill π/2√3 = 90.7%. Offsetting every other row drops it\n"
        "into the hollows, so ~15% more lenslets fit and 9.3% is left flat.",
        fontsize=9.2,
        color=SUB,
        labelpad=10,
    )
    save(fig, "12b-packing.png")


# ---------------------------------------------------------------------------
# 13 — what the nine inputs are called
# ---------------------------------------------------------------------------


def fig_naming():
    names = [
        ["Left · Up", "Up", "Right · Up"],
        ["Left", "Centre\n(neutral)", "Right"],
        ["Left · Down", "Down", "Right · Down"],
    ]
    fig, ax = plt.subplots(figsize=(7.6, 5.8))
    clean(ax)
    ax.set_aspect("equal")
    for r in range(3):
        for c in range(3):
            mid = r == 1 and c == 1
            ax.add_patch(
                Rectangle(
                    (c, 2 - r),
                    1,
                    1,
                    facecolor="#eef4fd" if mid else "white",
                    edgecolor=ART if mid else SUB,
                    lw=2.0 if mid else 1.1,
                )
            )
            ax.text(
                c + 0.5,
                2 - r + 0.5,
                names[r][c],
                ha="center",
                va="center",
                fontsize=10.5,
                weight="bold" if mid else "normal",
            )
    for c, lbl in enumerate(("eye to the left", "head on", "eye to the right")):
        ax.text(c + 0.5, 3.12, lbl, ha="center", fontsize=9, color=SUB, style="italic")
    for r, lbl in enumerate(("above", "level", "below")):
        ax.text(-0.08, 2 - r + 0.5, lbl, ha="right", va="center", fontsize=9, color=SUB, style="italic")
    ax.set_xlim(-1.0, 3.2)
    ax.set_ylim(-0.5, 3.4)
    ax.text(
        1.5,
        -0.3,
        "Each input is named for where you stand to see it.",
        ha="center",
        fontsize=10,
        color=INK,
    )
    save(fig, "13-view-names.png")


# ---------------------------------------------------------------------------
# 14 — the lens flips things over
# ---------------------------------------------------------------------------


def fig_mirroring():
    fig, ax = plt.subplots(figsize=(9.0, 5.2))
    clean(ax)
    ax.set_xlim(-1.5, 1.9)
    ax.set_ylim(-0.75, 1.55)
    ax.set_aspect("equal")

    xs = np.linspace(-0.5, 0.5, 200)
    lens = 0.72 + 0.22 * np.sqrt(np.maximum(0, 1 - (2 * xs) ** 2))
    ax.fill_between(xs, 0.72, lens, color=GLOSS_FILL)
    ax.plot(xs, lens, color=GLOSS, lw=2.2)
    ax.plot([-0.5, 0.5], [0.72, 0.72], color=GLOSS, lw=1.2, ls=(0, (5, 3)))

    ax.add_patch(Rectangle((-0.5, -0.02), 0.5, 0.14, facecolor="#bcd4f6", edgecolor=ART, lw=1.2))
    ax.add_patch(Rectangle((0.0, -0.02), 0.5, 0.14, facecolor="#dce8fb", edgecolor=ART, lw=1.2))
    ax.text(-0.25, 0.05, "left tile", ha="center", va="center", fontsize=9.5)
    ax.text(0.25, 0.05, "right tile", ha="center", va="center", fontsize=9.5)

    ax.plot([1.5, 0.16], [1.45, 0.90], color=RAY, lw=1.6)
    ax.plot([0.16, -0.25], [0.90, 0.12], color=RAY, lw=1.6)
    ax.plot([1.5], [1.45], marker="o", ms=11, color=RAY)
    ax.text(1.55, 1.45, "  your eye,\n  to the right", fontsize=10, color=RAY, va="center")
    ax.annotate(
        "the ray crosses over",
        xy=(0.16, 0.90),
        xytext=(0.52, 0.52),
        fontsize=9.2,
        color=RAY,
        arrowprops=dict(arrowstyle="->", color=RAY),
    )
    ax.plot([-0.25], [0.12], marker="^", ms=11, color=RAY)

    ax.text(
        0.2,
        -0.42,
        "So the view named “Right” has to be printed on the LEFT tile.\n"
        "Skip this and the print is pseudoscopic: parallax runs backwards.",
        ha="center",
        fontsize=10.2,
        color=WARN,
        weight="bold",
    )
    save(fig, "14-mirroring.png")


# ---------------------------------------------------------------------------
# 14b — where the depth budget comes from, and what it costs
# ---------------------------------------------------------------------------


def fig_model_depth():
    """Parallax on the sheet, and the depth that buys at the default lens.

    Left: why the sheet plane is common to every view and depth is not. Right:
    the printable depth from p·(N−1)/tan(cone/2) — the closed form the guide
    quotes, which the viewing distance drops out of entirely.
    """
    L = DEFAULT
    cone = L.view_angle
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(11.4, 4.6))

    # ---- left: two eyes, one sheet, one near point --------------------------
    clean(ax)
    D = 3.0
    eyes = [-1.15, 1.15]
    sheet_y = 0.0
    ax.plot([-2.6, 2.6], [sheet_y, sheet_y], color=INK, lw=2.0, zorder=3)
    ax.text(-2.55, -0.22, "the sheet — every view agrees here", fontsize=9, color=INK)
    near_y = 0.62
    ax.add_patch(Circle((0, near_y), 0.075, facecolor=WARN, edgecolor="none", zorder=4))
    ax.text(0.30, near_y - 0.16, "a point in front", fontsize=9, color=WARN)

    hits = []
    for ex, name in zip(eyes, ("left eye", "right eye")):
        ax.add_patch(Circle((ex, D), 0.085, facecolor=ART, edgecolor="none", zorder=4))
        ax.text(ex, D + 0.16, name, fontsize=9, color=ART, ha="center")
        # Ray to the sheet through the near point: X = ex + t(x-ex), t = D/(D-z).
        t = D / (D - near_y)
        hit = ex + t * (0 - ex)
        hits.append(hit)
        ax.plot([ex, hit], [D, sheet_y], color=RAY, lw=1.4, zorder=2)
        # …and the ray to the sheet-plane point straight below the subject.
        ax.plot([ex, 0], [D, sheet_y], color=FAINT, lw=1.0, ls=(0, (4, 3)), zorder=1)
    ax.add_patch(Circle((0, sheet_y), 0.06, facecolor=INK, edgecolor="none", zorder=5))
    for hit in hits:
        ax.plot([hit], [sheet_y], marker="o", ms=6, color=RAY, zorder=5)
    arrow(ax, (hits[0], -0.45), (hits[1], -0.45), style="<|-|>", ms=8, color=RAY)
    ax.text(
        0,
        -0.62,
        "the near point lands here, and here:\nthat gap is the parallax, and it must\nstay inside one lenslet per view step",
        ha="center",
        va="top",
        fontsize=9.2,
        color=SUB,
    )
    ax.set_xlim(-2.7, 2.7)
    ax.set_ylim(-1.45, 3.5)
    ax.set_title(
        "the eye shifts; the sheet plane does not move", fontsize=11, weight="bold", loc="left"
    )

    # ---- right: printable depth against grid size ---------------------------
    grids = [2, 3, 4, 6]
    depths = [L.pitch * (n - 1) / math.tan(math.radians(cone / 2)) for n in grids]
    bx.bar([str(n) + "×" + str(n) for n in grids], depths, color=GLOSS_FILL, edgecolor=GLOSS, lw=1.6)
    for label, d in zip(grids, depths):
        bx.text(str(label) + "×" + str(label), d + 0.08, f"{d:.2f} mm", ha="center", fontsize=9.5)
    bx.set_ylabel("printable subject depth (mm)")
    bx.set_ylim(0, max(depths) * 1.22)
    bx.grid(color=FAINT, lw=0.5, axis="y")
    bx.set_axisbelow(True)
    for s in ("top", "right"):
        bx.spines[s].set_visible(False)
    bx.set_title(
        f"at {L.lpi:.0f} LPI and a {cone:.1f}° cone — depth = p(N−1)/tan(cone/2)",
        fontsize=11,
        weight="bold",
        loc="left",
    )
    bx.set_xlabel(
        "The viewing distance cancels out, and per-view resolution does not change with N:\n"
        "a bigger grid is how you buy depth. Beyond these, features ghost instead of gliding.",
        fontsize=9.2,
        color=SUB,
        labelpad=10,
    )
    save(fig, "14b-model-depth.png")



# ---------------------------------------------------------------------------
# 17 — the blur the lens itself adds, and the ways out of it
#
# Everything here is traced, not sketched: Snell at the real surface, across the
# real aperture, onto the real artwork plane. The numbers quoted in the guide
# come from this function.
# ---------------------------------------------------------------------------


def conic_sag(r, R, K):
    """
    Depth below the apex of a conic of vertex radius `R` and conic constant `K`.

    K = 0 is the circle the tool prints today. K = −1/n² is the ellipse that
    focuses a collimated beam to a point inside a medium of index n — an exact
    result for one refracting surface, and the shape the lenticular patents
    reach for (US6795250B2).
    """
    r2 = np.asarray(r, dtype=float) ** 2
    return r2 / (R * (1 + np.sqrt(np.maximum(1e-12, 1 - (1 + K) * r2 / R**2))))


def trace_bundle(lens, offsets, *, R=None, K=0.0, theta_deg=0.0, plane=None):
    """
    Land a parallel bundle from `theta_deg` on the artwork, one x per ray.

    The same trace the animation runs, with the surface generalised to a conic
    and the artwork plane free, so a design can be judged on where its light
    actually goes rather than on its paraxial focus.
    """
    R = lens.radius if R is None else R
    plane = lens.H if plane is None else plane
    th = math.radians(theta_deg)
    d = (-math.sin(th), -math.cos(th))
    eps, out = 1e-7, []
    for off in offsets:
        s = float(conic_sag(abs(off), R, K))
        slope = (float(conic_sag(abs(off) + eps, R, K)) - s) / eps * (1 if off >= 0 else -1)
        nl = math.hypot(slope, 1.0)
        normal = (slope / nl, 1.0 / nl)
        eta = 1.0 / lens.n
        cos_i = -(d[0] * normal[0] + d[1] * normal[1])
        k = 1 - eta * eta * (1 - cos_i * cos_i)
        if k < 0:
            continue
        f = eta * cos_i - math.sqrt(k)
        ins = (eta * d[0] + f * normal[0], eta * d[1] + f * normal[1])
        if ins[1] >= 0:
            continue
        t = ((lens.H - s) - (lens.H - plane)) / -ins[1]
        out.append((off, lens.H - s, off + t * ins[0]))
    return out


def spot_um(lens, offsets, **kw):
    """Width of the landing patch, in µm — the blur, in the units of a strip."""
    lands = [x for _, _, x in trace_bundle(lens, offsets, **kw)]
    return (max(lands) - min(lands)) * 1000 if lands else float("nan")


def fig_aberration():
    L = DEFAULT
    half = L.pitch / 2
    K_ELL = -1 / L.n**2
    # The vertex radius whose *best* focus, rather than whose paraxial focus,
    # falls on the artwork — found by search, in the sweep below.
    R_BEST = 0.3470
    fine = np.linspace(-half * 0.99, half * 0.99, 401)
    drawn = np.linspace(-half * 0.99, half * 0.99, 17)

    fig = plt.figure(figsize=(11.4, 4.5))
    gs = fig.add_gridspec(1, 3, width_ratios=[1, 1, 1.45], wspace=0.22)
    strip = L.pitch / 12 * 1000

    for col, (K, R, title) in enumerate(
        (
            (0.0, L.radius, f"circle — {spot_um(L, fine):.0f} µm across the artwork"),
            (K_ELL, L.radius, f"ellipse, K = −1/n² — {spot_um(L, fine, K=K_ELL):.1f} µm"),
        )
    ):
        ax = fig.add_subplot(gs[0, col])
        ax.set_aspect("equal")
        clean(ax)
        xs = np.linspace(-half, half, 300)
        surf = L.H - conic_sag(np.abs(xs), R, K)
        ax.fill_between(xs, 0, surf, color=GLOSS_FILL)
        ax.plot(xs, surf, color=GLOSS, lw=2)
        for x0, y0, land in trace_bundle(L, drawn, R=R, K=K):
            ax.plot([x0, x0, land], [L.H + 0.30, y0, 0], color=RAY, lw=0.8, alpha=0.85)
        ax.add_patch(Rectangle((-half, -0.06), L.pitch, 0.06, facecolor=ART, edgecolor="none"))
        for k in range(1, 12):
            ax.plot([-half + k * L.pitch / 12] * 2, [-0.06, 0], color="white", lw=0.5)
        ax.set_xlim(-half * 1.06, half * 1.06)
        ax.set_ylim(-0.1, L.H + 0.32)
        ax.set_title(title, fontsize=10, color=SUB, loc="left")

    # Spot against viewing angle, for the four designs worth knowing about.
    bx = fig.add_subplot(gs[0, 2])
    angles = np.linspace(0, L.view_angle / 2, 28)
    designs = (
        ("circle, focus on the artwork — as printed", dict(R=L.radius, K=0.0), INK, "-"),
        ("circle, radius set for best focus", dict(R=R_BEST, K=0.0), SUB, (0, (4, 3))),
        ("ellipse K = −1/n², same radius", dict(R=L.radius, K=K_ELL), ART, "-"),
        ("ellipse, radius re-optimised", dict(R=0.3460, K=K_ELL), GLOSS, (0, (1, 2))),
    )
    for label, kw, col, ls in designs:
        bx.plot(
            angles,
            [spot_um(L, fine, theta_deg=t, **kw) for t in angles],
            color=col, lw=1.8, ls=ls, label=label,
        )
    bx.axhline(strip, color=WARN, lw=1.2)
    bx.text(L.view_angle / 2 * 0.53, strip * 1.12, "one strip at 12 views — past this is crosstalk",
            fontsize=8.6, color=WARN)
    bx.set_xlabel("viewing angle off head-on (°)")
    bx.set_ylabel("blur at the artwork (µm)")
    bx.set_xlim(0, L.view_angle / 2)
    bx.set_ylim(0, 470)
    bx.grid(color=FAINT, lw=0.6)
    bx.set_axisbelow(True)
    for side in ("top", "right"):
        bx.spines[side].set_visible(False)
    bx.legend(fontsize=8.4, loc="upper left", frameon=False)
    save(fig, "17-aberration.png")

# ---------------------------------------------------------------------------
# 15 — a calibration sheet
# ---------------------------------------------------------------------------


def fig_calibration():
    fig, ax = plt.subplots(figsize=(9.8, 5.0))
    clean(ax)
    ax.set_xlim(0, 100)
    ax.set_ylim(-6, 62)

    bands = 7
    h = 54 / bands
    for i in range(bands):
        y = 4 + i * h
        val = 0.6 + (1.4 - 0.6) * i / (bands - 1)
        shade = 1 - 0.55 * (i / (bands - 1))
        ax.add_patch(Rectangle((4, y + 0.9), 44, h - 1.8, facecolor=str(shade), edgecolor=SUB, lw=0.8))
        ax.text(2.5, y + h / 2, f"{val:.2f} mm", ha="right", va="center", fontsize=9)
        good = i == 4
        if good:
            ax.add_patch(
                Rectangle((3.2, y + 0.3), 45.6, h - 0.6, fill=False, edgecolor=RAY, lw=2.4)
            )
            ax.text(26, y + h / 2, "this one flips cleanly", fontsize=10, color=RAY,
                    va="center", ha="center", weight="bold",
                    bbox=dict(boxstyle="round,pad=0.25", fc="white", ec=RAY, lw=1.2))

    ax.text(26, 60, "the relief map, swept", ha="center", fontsize=11.5, weight="bold")
    ax.text(
        26,
        -2.5,
        "Bands run along the lenses, so each keeps whole lenses.\nBlank gutters stop neighbours bleeding together.",
        ha="center",
        fontsize=9.2,
        color=SUB,
    )

    ax.add_patch(Rectangle((72, 4), 24, 54, facecolor="white", edgecolor=SUB, lw=1.0))
    for i in range(bands):
        y = 4 + i * h
        col = "black" if i % 2 == 0 else "white"
        ax.add_patch(Rectangle((72, y + 0.9), 24, h - 1.8, facecolor=col, edgecolor=SUB, lw=0.6))
    ax.text(84, 60, "the switch target", ha="center", fontsize=11.5, weight="bold")
    ax.text(
        84,
        -2.5,
        "The same sheet with the artwork replaced by\nflat white and black. This is the one you read.",
        ha="center",
        fontsize=9.2,
        color=SUB,
    )
    save(fig, "15-calibration.png")


if __name__ == "__main__":
    print("writing figures to docs/images/")
    fig_overview()
    fig_cross_section()
    fig_focus()
    fig_chord()
    fig_feasibility()
    fig_cone()
    fig_interlace()
    fig_sampling()
    fig_dual_raster()
    fig_quantisation()
    fig_grid_plan()
    fig_grid_profile()
    fig_packing()
    fig_naming()
    fig_mirroring()
    fig_model_depth()
    fig_calibration()
    fig_aberration()
    L = DEFAULT
    print(
        f"\ndefaults check: pitch {L.pitch:.4f} mm, sag {L.sag:.4f}, base {L.base:.4f}, "
        f"R {L.radius:.4f}, focus {L.focus:.4f}, cone {L.view_angle:.2f}°, H_min {L.min_height:.4f}"
    )
