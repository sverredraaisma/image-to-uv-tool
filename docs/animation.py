"""Animate the view sweep of a lenticular print: one frame per degree.

    pip install matplotlib numpy pillow
    python docs/animation.py            # writes docs/images/anim/*.png + the GIF

Nothing in the app depends on this. It is the moving version of the still
figures in figures.py, whose `Lens` solve — itself a port of `lensGeometry()`
in src/lib/lenticular.ts — is imported rather than copied, so the geometry
here is the geometry the tool prints.

What it shows, and why the direction matters
--------------------------------------------
The eye walks from the left of the print to the right, one degree per frame,
across the lens's own viewing cone. At each angle the script traces real rays:
a parallel bundle (the eye is 400 mm away, so it is parallel to within a
thousandth of a degree across one 0.56 mm lenticule), refracted by Snell's law
at the lenticule's actual arc, down to the artwork plane at the focus.

Everything else follows from where those rays land, and the whole point of the
animation is that they land the *other* way round from the eye:

    eye moves right  →  the bundle lands left of the lens axis
                     →  the strip it reads is nearer the left of the lenticule
                     →  which is a low printed-strip number
                     →  which carries a HIGH capture number, because the tool
                        prints the run reversed (`mirrorViews`)
                     →  so the view you see is the one captured from the right,
                        i.e. from where you are standing.

That last line is the thing to check, and it is why the strips are coloured by
where their view was captured — blue for the left of the cone, orange for the
right. The lit strip's colour always matches the side the eye is on. A print
made the other way round would show the two disagreeing, which is exactly what
a pseudoscopic (inside-out) print looks like.
"""

from __future__ import annotations

import argparse
import math
import os

import matplotlib

matplotlib.use("Agg")

import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import LinearSegmentedColormap
from matplotlib.patches import Circle, FancyArrowPatch, Polygon, Rectangle, Wedge

from figures import ART, DEFAULT, FAINT, GLOSS, GLOSS_FILL, INK, RAY, SUB, WARN, clean

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "images")

# Blue at the left of the cone, orange at the right, pale in the middle — so a
# strip's colour says where its view was captured from, and the lit strip can be
# checked against the side the eye is on at a glance.
VIEW_CMAP = LinearSegmentedColormap.from_list("cone", ["#2f6fd0", "#eef1f5", "#d8722c"])


def said(deg: float) -> str:
    """An angle as a person would say it: head-on, or so many degrees to a side."""
    if abs(deg) < 0.5:
        return "head-on"
    return f"{abs(deg):.0f}° {'right' if deg > 0 else 'left'}"


def view_colour(i: int, n: int, lighten: float = 0.0):
    """Colour of capture view `i` of `n`, optionally washed out towards white."""
    r, g, b, _ = VIEW_CMAP(i / max(1, n - 1))
    return (r + (1 - r) * lighten, g + (1 - g) * lighten, b + (1 - b) * lighten)


def surface_y(lens, x):
    """Height of the lens surface above the artwork, for a sheet of lenticules."""
    d = (np.asarray(x, float) + lens.pitch / 2) % lens.pitch - lens.pitch / 2
    arc = np.sqrt(np.maximum(0.0, lens.radius**2 - d**2)) - (lens.radius - lens.sag)
    return lens.base + np.maximum(0.0, arc)


def refract(d, normal, n_from, n_to):
    """Snell's law as a vector, or None on total internal reflection."""
    eta = n_from / n_to
    cos_i = -(d[0] * normal[0] + d[1] * normal[1])
    k = 1 - eta * eta * (1 - cos_i * cos_i)
    if k < 0:
        return None
    s = eta * cos_i - math.sqrt(k)
    return (eta * d[0] + s * normal[0], eta * d[1] + s * normal[1])


def trace(lens, theta_deg: float, cell: float = 0.0, rays: int = 9):
    """
    Trace a parallel bundle from an eye `theta_deg` to the right of head-on,
    through the lenticule centred at `cell`, down to the artwork plane.

    The eye is at (D sin θ, D cos θ), so the ray that reaches it travels in
    direction (−sin θ, −cos θ): an eye on the right is fed by light heading
    down and to the *left*, which is the whole of the inversion.

    Returns one entry per ray: where it met the surface, where it landed, and
    the path between, plus the landing point of the ray through the axis, which
    is the one that names the strip.
    """
    th = math.radians(theta_deg)
    d = (-math.sin(th), -math.cos(th))
    half = lens.pitch / 2
    # Not quite to the seam: the last thousandth of the arc is where two
    # lenticules meet, and no press lays that edge down as geometry anyway.
    offsets = np.linspace(-half * 0.97, half * 0.97, rays)
    out = []
    for off in offsets:
        sx = cell + off
        sy = float(surface_y(lens, sx))
        # Outward normal of the arc: away from its centre of curvature, which
        # sits one radius below the apex.
        nx, ny = off, sy - (lens.H - lens.radius)
        nl = math.hypot(nx, ny)
        normal = (nx / nl, ny / nl)
        inside = refract(d, normal, 1.0, lens.n)
        if inside is None or inside[1] >= 0:
            continue
        t = sy / -inside[1]
        out.append(
            {
                "surface": (sx, sy),
                "land": (sx + t * inside[0], 0.0),
                "entry": (sx - d[0] * 0.55, sy - d[1] * 0.55),
                "axis": abs(off) < half * 0.01,
            }
        )
    return out


def strip_of(lens, x: float, cell: float, n_views: int) -> int:
    """
    Which printed strip a landing point falls in, counting from the left of its
    own lenticule — the same `floor(frac(u / pitch) · N)` the interlacer uses.
    Can run past the lenticule's own edge, which is what a view outside the cone
    does: it reads the neighbour's strips and the print repeats.
    """
    t = (x - cell + lens.pitch / 2) / lens.pitch
    return int(math.floor((t - math.floor(t)) * n_views))


def eye_of(strip: int, n_views: int) -> int:
    """
    The capture view a printed strip carries. The tool prints the run reversed
    (`mirrorViews`), because a lenticule shows its leftmost strip to an eye on
    the right — so printed strip 0 is the view captured from the far right.
    """
    return n_views - 1 - strip


def capture_angle(view: int, n_views: int, cone: float) -> float:
    """
    Where the camera stood for a given view, degrees right of head-on. The run
    spans the cone, so view 0 is at its left edge — and inside the cone this is
    the number the eye's own angle has to agree with, which is the whole claim
    the animation is making.
    """
    return (view / max(1, n_views - 1) - 0.5) * cone


# ---------------------------------------------------------------------------
# The three panels
# ---------------------------------------------------------------------------


def draw_section(ax, lens, theta, n_views, cells=(-1, 0, 1)):
    """Cross-section through three lenticules, with the bundle at this angle."""
    half = lens.pitch / 2
    span = 1.5 * lens.pitch
    art_h = 0.085

    xs = np.linspace(-span, span, 900)
    ax.fill_between(xs, 0, surface_y(lens, xs), color=GLOSS_FILL, zorder=1)
    ax.plot(xs, surface_y(lens, xs), color=GLOSS, lw=1.8, zorder=3)
    ax.plot([-span, span], [lens.base, lens.base], color=GLOSS, lw=0.8, ls=(0, (5, 4)), alpha=0.7, zorder=3)

    # The artwork: N strips under every lenticule, printed order left to right,
    # coloured by the capture view each one carries.
    for c in cells:
        for k in range(n_views):
            x0 = c * lens.pitch - half + k * lens.pitch / n_views
            ax.add_patch(
                Rectangle(
                    (x0, -art_h),
                    lens.pitch / n_views,
                    art_h,
                    facecolor=view_colour(eye_of(k, n_views), n_views),
                    edgecolor="white",
                    lw=0.4,
                    zorder=2,
                )
            )
    ax.add_patch(Rectangle((-span, -art_h), 2 * span, art_h, fill=False, edgecolor=INK, lw=1.0, zorder=4))

    # The bundles. The middle lenticule in full, its neighbours faintly — the
    # sheet does the same thing under every lens, which is why it switches as
    # one rather than sweeping across.
    lit = None
    for c in cells:
        strong = c == 0
        for ray in trace(lens, theta, cell=c * lens.pitch):
            col = RAY if strong else FAINT
            ax.plot(
                [ray["entry"][0], ray["surface"][0], ray["land"][0]],
                [ray["entry"][1], ray["surface"][1], ray["land"][1]],
                color=col,
                lw=1.5 if ray["axis"] and strong else (0.9 if strong else 0.7),
                alpha=1.0 if strong else 0.85,
                zorder=5 if strong else 1,
                solid_capstyle="round",
            )
            if ray["axis"] and strong:
                lit = ray["land"][0]

    # The strip the axial ray reads, outlined where it lies.
    strip = strip_of(lens, lit, 0.0, n_views)
    view = eye_of(strip, n_views)
    x0 = -half + strip * lens.pitch / n_views + lens.pitch * math.floor(
        (lit + half) / lens.pitch
    )
    ax.add_patch(
        Rectangle(
            (x0, -art_h),
            lens.pitch / n_views,
            art_h,
            facecolor=view_colour(view, n_views),
            edgecolor=INK,
            lw=1.8,
            zorder=6,
        )
    )
    ax.plot([lit], [0], marker="o", ms=6, color=INK, zorder=7)

    # The eye itself, on an arc above — schematic, and labelled as such.
    r = lens.H + 0.42
    ex, ey = r * math.sin(math.radians(theta)), r * math.cos(math.radians(theta))
    ax.add_patch(Wedge((0, 0), r, 90 - lens.view_angle / 2, 90 + lens.view_angle / 2,
                       facecolor=RAY, alpha=0.06, edgecolor="none", zorder=0))
    ax.add_patch(Circle((ex, ey), 0.075, facecolor="white", edgecolor=INK, lw=1.4, zorder=8))
    ax.add_patch(Circle((ex, ey), 0.032, facecolor=INK, edgecolor="none", zorder=9))
    ax.text(ex, ey + 0.16, said(theta), ha="center", fontsize=9.5, color=INK, zorder=9)

    ax.set_xlim(-span, span)
    ax.set_ylim(-art_h - 0.30, r + 0.34)
    ax.set_aspect("equal")
    clean(ax)
    ax.text(
        0, -art_h - 0.10,
        f"lenticule {lens.pitch:.3f} mm · {lens.H:.2f} mm of clear ink · n = {lens.n} · "
        f"cone {lens.view_angle:.1f}°\n"
        f"the eye is drawn close; it is really 400 mm away, so the bundle is parallel",
        fontsize=8.2, color=SUB, va="top", ha="center",
    )
    return strip, view, lit


def draw_seen(ax, lens, theta, n_views, view):
    """What the viewer sees: the one view that strip carries."""
    clean(ax)
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 6.4)
    # Paper pale enough to read against, in a border of the view's own colour —
    # so which side of the cone this came from is legible even for the pale
    # middle of the ramp.
    r, g, b = view_colour(view, n_views)
    ax.add_patch(
        Rectangle((0.35, 0.5), 9.3, 5.1, facecolor=view_colour(view, n_views, 0.55),
                  edgecolor=(r * 0.75, g * 0.75, b * 0.75), lw=4.0)
    )

    # A subject standing behind the sheet, drawn where the *captured* view puts
    # it — not where the eye is. A print holds one view per strip, so the
    # subject jumps from view to view rather than gliding, and drawing it from
    # the capture angle is what shows that.
    #
    # X = X₀ + e·Z/(D + Z) — the projection `disparityAtDepth` reports, for a
    # point Z behind the plane: it slides the same way the eye does, which is
    # what makes the print read as depth rather than as a flip book.
    cap = capture_angle(view, n_views, lens.view_angle)
    D, Z = 400.0, 60.0
    e = D * math.tan(math.radians(cap))
    slide = (e * Z / (D + Z)) / 100.0 * 9.3  # sheet is 100 mm wide, panel is 9.3
    for i in range(7):
        ax.plot([1.0 + i * 1.4 + slide * 0.15] * 2, [1.0, 5.1], color="white", lw=1.0, alpha=0.55)
    ax.add_patch(Circle((5.0 + slide, 3.0), 1.05, facecolor="white", edgecolor=INK, lw=1.2, alpha=0.95))
    ax.text(5.0 + slide, 3.0, f"{view + 1}", ha="center", va="center", fontsize=15, weight="bold")

    # The claim, stated so it can be checked: this view was captured from *that*
    # angle, and inside the cone that angle is where the eye is standing — to
    # within the half-strip the interlace quantises to.
    agrees = abs(cap - theta) <= lens.view_angle / max(1, n_views - 1)
    ax.text(5.0, 5.85, f"you see view {view + 1} of {n_views}, captured at {said(cap)}",
            ha="center", fontsize=10.5, weight="bold")
    ax.text(
        5.0, 0.12,
        f"— the view nearest {said(theta)}, where you are standing"
        if agrees
        else f"— not {said(theta)}, where you are standing: this is past the cone",
        ha="center", fontsize=9, color=SUB if agrees else WARN,
        weight="normal" if agrees else "bold",
    )


def draw_map(ax, lens, theta, n_views, strip, view):
    """The two orders side by side: where the eye is, and how the strips run."""
    clean(ax)
    ax.set_xlim(0, 10)
    ax.set_ylim(0, 4.3)

    # Capture positions across the cone, left to right, and the eye on them.
    ax.text(0.1, 3.95, "captured left → right", fontsize=9, color=SUB)
    for i in range(n_views):
        x = 0.35 + i * (9.3 / (n_views - 1))
        ax.add_patch(Circle((x, 3.15), 0.24, facecolor=view_colour(i, n_views),
                            edgecolor=INK if i == view else "white", lw=1.6 if i == view else 0.6))
        if i == view:
            ax.text(x, 3.15, f"{i + 1}", ha="center", va="center", fontsize=8.5, weight="bold")
    frac = 0.5 + math.tan(math.radians(theta)) / (2 * math.tan(math.radians(lens.view_angle / 2)))
    ax.add_patch(
        FancyArrowPatch((0.35 + frac * 9.3, 2.35), (0.35 + frac * 9.3, 2.82),
                        arrowstyle="-|>", mutation_scale=11, color=INK, lw=1.5)
    )
    ax.text(0.35 + frac * 9.3, 2.05, "you", ha="center", fontsize=9)

    # …and the printed strips under one lenticule, which run the other way.
    ax.text(0.1, 1.55, "printed strips, left → right (reversed: the lens inverts)", fontsize=9, color=SUB)
    w = 9.3 / n_views
    for k in range(n_views):
        x = 0.35 + k * w
        ax.add_patch(Rectangle((x, 0.6), w, 0.8, facecolor=view_colour(eye_of(k, n_views), n_views),
                               edgecolor=INK if k == strip else "white",
                               lw=1.8 if k == strip else 0.6, zorder=2 if k == strip else 1))
    ax.text(0.35 + (strip + 0.5) * w, 0.44, "↑ lit", ha="center", fontsize=9, color=INK, va="top")


def frame(lens, theta, n_views, path, span):
    fig = plt.figure(figsize=(11.0, 6.0))
    gs = fig.add_gridspec(2, 2, width_ratios=[1.5, 1], height_ratios=[1.25, 1],
                          wspace=0.12, hspace=0.22, left=0.02, right=0.98, top=0.89, bottom=0.03)
    ax_main = fig.add_subplot(gs[:, 0])
    ax_seen = fig.add_subplot(gs[0, 1])
    ax_map = fig.add_subplot(gs[1, 1])

    strip, view, lit = draw_section(ax_main, lens, theta, n_views)
    draw_seen(ax_seen, lens, theta, n_views, view)
    draw_map(ax_map, lens, theta, n_views, strip, view)

    outside = abs(theta) > lens.view_angle / 2
    lands = "on the axis" if abs(lit) < 1e-3 else f"{abs(lit) * 1000:.0f} µm {'left' if lit < 0 else 'right'}"
    fig.text(
        0.5, 0.965,
        f"eye {said(theta)}  →  the bundle lands {lands}  →  strip {strip + 1} of {n_views}  →  "
        f"view {view + 1}",
        ha="center", fontsize=12, weight="bold", color=INK,
    )
    fig.text(
        0.5, 0.925,
        "past the cone: the bundle has walked onto the next lenticule’s strips, and the print repeats"
        if outside
        else "the strip a lens shows an eye on the right sits on its left — which is why the run is printed reversed",
        ha="center", fontsize=9.2, color=WARN if outside else SUB,
        weight="bold" if outside else "normal",
    )
    fig.savefig(path, dpi=92, facecolor="white")
    plt.close(fig)


def main():
    lens = DEFAULT
    # The cone, rounded out to a whole degree, plus one — so the sweep is a
    # degree a frame across everything the lens can show, and the frame at each
    # end is just past the edge, where the print starts repeating. At the
    # defaults that is 53.3° of cone and 57 frames.
    half = math.ceil(lens.view_angle / 2) + 1
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--span", type=float, default=half, help="half-sweep in degrees (default: the cone + 1°)")
    ap.add_argument("--step", type=float, default=1.0, help="degrees per frame")
    ap.add_argument("--views", type=int, default=12, help="views interlaced under each lenticule")
    ap.add_argument("--out", default=os.path.join(OUT, "anim"))
    ap.add_argument("--gif", default=os.path.join(OUT, "16-viewing-sweep.gif"))
    ap.add_argument("--ms", type=int, default=110, help="milliseconds per frame in the GIF")
    ap.add_argument("--once", action="store_true", help="loop left→right only, instead of walking back")
    args = ap.parse_args()

    os.makedirs(args.out, exist_ok=True)
    angles = np.arange(-args.span, args.span + 1e-9, args.step)
    paths = []
    print(f"writing {len(angles)} frames to {args.out}/ — {angles[0]:+.0f}° to {angles[-1]:+.0f}°, "
          f"{args.step:g}° apart, {args.views} views, cone {lens.view_angle:.1f}°")
    for i, theta in enumerate(angles):
        path = os.path.join(args.out, f"sweep-{i:03d}.png")
        # The sweep runs left to right because that is a viewer walking past the
        # print; every correspondence in the frame is keyed to that direction.
        frame(lens, float(theta), args.views, path, args.span)
        paths.append(path)
        if i % 10 == 0 or i == len(angles) - 1:
            print(f"  {i + 1}/{len(angles)}  {theta:+.0f}°")

    if args.gif:
        from PIL import Image

        # There and back: what a person actually does in front of a print, and
        # it saves the jump a forward-only loop makes at the right-hand edge.
        order = paths if args.once else paths + paths[-2:0:-1]
        first, *rest = [Image.open(p).convert("P", palette=Image.ADAPTIVE, colors=64) for p in order]
        first.save(args.gif, save_all=True, append_images=rest, duration=args.ms, loop=0, optimize=True)
        print(f"\n{args.gif}  ({len(order)} frames, {os.path.getsize(args.gif) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
