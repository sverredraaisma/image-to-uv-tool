"""Animate the view sweep of a lenticular print: one frame per degree.

    pip install matplotlib numpy pillow
    python docs/animation.py            # writes docs/images/anim/*.png + the GIF

Nothing in the app depends on this. It is the moving version of the still
figures in figures.py, whose `Lens` solve — itself a port of `lensGeometry()`
in src/lib/lenticular.ts — is imported rather than copied, so the geometry
here is the geometry the tool prints.

One picture per frame: a cross-section through three lenticules, with the eye
at that angle and the light traced through to the artwork. Real rays — a
parallel bundle (the eye is 400 mm away, so it is parallel to within a
thousandth of a degree across one 0.56 mm lenticule), refracted by Snell's law
at the lenticule's actual surface, down to the artwork plane at the focus. The
strip the axial ray lands on is outlined; every other ray is drawn green if it
lands in that strip too and amber if it does not, so the print's crosstalk is
in the picture rather than in a footnote.

That surface is the ellipse the tool prints, `K = −1/n²`, and it is worth
running `--surface circle` once to see what the shape is worth: the ellipse
brings its whole aperture to a point in the lit strip, while the circle sprays
a third of its light into the neighbours at every angle. What is left of the
ellipse is coma, which shows up as a few amber rays out at the edge of the
cone and as none at all head-on. Figure 17 and "The blur the lens itself adds"
in the guide have the measurements.

The direction is the point of it. The eye walks left to right, because that is
what a viewer does, and the bundle therefore lands the other way:

    eye moves right  →  the bundle lands left of the lens axis
                     →  so it reads a strip nearer the left of the lenticule
                     →  which is a low printed-strip number
                     →  which carries a HIGH capture number, because the tool
                        prints the run reversed (`mirrorViews`)
                     →  so the view you see is the one captured from the right,
                        i.e. from where you are standing.

The strips are coloured by where their view was captured — blue for the left of
the cone, orange for the right — so that chain can be watched rather than taken
on trust: the lit strip's colour always matches the side the eye is on. A print
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
from matplotlib.patches import Circle, Rectangle, Wedge

from figures import DEFAULT, FAINT, GLOSS, GLOSS_FILL, INK, Lens, RAY, SUB, WARN, clean, conic_sag

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


def view_colour(i: int, n: int):
    """Colour of capture view `i` of `n`, across the cone."""
    r, g, b, _ = VIEW_CMAP(i / max(1, n - 1))
    return (r, g, b)


def surface_y(lens, x):
    """
    Height of the lens surface above the artwork, for a sheet of lenticules.

    Whichever surface the lens was solved for: a circle at K = 0, the ellipse
    the tool prints at K = −1/n². `conic_sag` is figures.py's, which is the port
    of the tool's own.
    """
    d = (np.asarray(x, float) + lens.pitch / 2) % lens.pitch - lens.pitch / 2
    arc = lens.sag - conic_sag(np.abs(d), lens.radius, lens.K)
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


#: Fraction of the half-pitch the drawn bundle spans. Not quite 1: the last
#: hundredth is the seam where two lenticules meet, and no press lays that edge
#: down as geometry anyway.
#:
#: The whole aperture is drawn because the whole aperture is what a print has,
#: and because whether a surface can focus all of it is the entire question. The
#: ellipse can, exactly, on axis. A circle cannot: its outer rays cross above its
#: middle ones — spherical aberration, a real property of the shape rather than a
#: fault in the trace — and head-on its bundle lands over 269 µm, which at eight
#: views is 3.8 strips of crosstalk. Run `--surface circle` to watch it happen.
APERTURE = 0.99


def trace(lens, theta_deg: float, cell: float = 0.0, rays: int = 9, aperture: float = APERTURE):
    """
    Trace a parallel bundle from an eye `theta_deg` to the right of head-on,
    through the lenticule centred at `cell`, down to the artwork plane.

    The eye is at (D sin θ, D cos θ), so the ray that reaches it travels in
    direction (−sin θ, −cos θ): an eye on the right is fed by light heading
    down and to the *left*, which is the whole of the inversion.

    `aperture` is the fraction of the half-pitch the bundle spans — see
    APERTURE above for why it is not all of it.
    """
    th = math.radians(theta_deg)
    d = (-math.sin(th), -math.cos(th))
    half = lens.pitch / 2
    offsets = np.linspace(-half * aperture, half * aperture, rays)
    out = []
    eps = 1e-7
    for off in offsets:
        sx = cell + off
        sy = float(surface_y(lens, sx))
        # Outward normal of the surface, from the slope of its own sag — which
        # works for any conic, where "one radius below the apex" only works for
        # a circle.
        slope = float(
            conic_sag(abs(off) + eps, lens.radius, lens.K) - conic_sag(abs(off), lens.radius, lens.K)
        ) / eps
        if off < 0:
            slope = -slope
        nl = math.hypot(slope, 1.0)
        normal = (slope / nl, 1.0 / nl)
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


def strip_at(lens, x: float, cell: float, n_views: int) -> float:
    """Where a landing point falls, in strips from the left of its lenticule."""
    t = (x - cell + lens.pitch / 2) / lens.pitch
    return (t - math.floor(t)) * n_views


def strip_of(lens, x: float, cell: float, n_views: int) -> int:
    """
    Which printed strip a landing point falls in, counting from the left of its
    own lenticule — the same `floor(frac(u / pitch) · N)` the interlacer uses.
    Can run past the lenticule's own edge, which is what a view outside the cone
    does: it reads the neighbour's strips and the print repeats.
    """
    return int(math.floor(strip_at(lens, x, cell, n_views)))


#: How far outside the lit strip a ray has to land before it is drawn as
#: crosstalk, as a fraction of a strip. Not zero: a lens that focuses properly
#: lands its whole bundle on one point, and head-on that point is exactly a
#: strip boundary — the flip itself — where which side a ray falls is decided by
#: the last bit of the arithmetic rather than by any optics.
SPILL = 0.02


def eye_of(strip: int, n_views: int) -> int:
    """
    The capture view a printed strip carries. The tool prints the run reversed
    (`mirrorViews`), because a lenticule shows its leftmost strip to an eye on
    the right — so printed strip 0 is the view captured from the far right.
    """
    return n_views - 1 - strip


def frame(lens, theta, n_views, path, aperture=APERTURE, rays=15, cells=(-1, 0, 1)):
    """One frame: the cross-section, the bundle at this angle, and nothing else."""
    half = lens.pitch / 2
    span = 1.5 * lens.pitch
    art_h = 0.085
    # Room above for the eye on its arc, and its label.
    top = lens.H + 0.42 + 0.34
    bottom = -art_h - 0.10

    # The figure is the drawing: equal aspect, sized to the millimetres it
    # covers, so no frame carries a margin of nothing.
    wide = 5.6
    fig, ax = plt.subplots(figsize=(wide, wide * (top - bottom) / (2 * span)))
    fig.subplots_adjust(left=0.005, right=0.995, top=0.995, bottom=0.005)

    xs = np.linspace(-span, span, 900)
    ax.fill_between(xs, 0, surface_y(lens, xs), color=GLOSS_FILL, zorder=1)
    ax.plot(xs, surface_y(lens, xs), color=GLOSS, lw=1.8, zorder=3)
    ax.plot(
        [-span, span], [lens.base, lens.base], color=GLOSS, lw=0.8, ls=(0, (5, 4)), alpha=0.7, zorder=3
    )

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

    # The middle lenticule's bundle decides what is being shown, so trace it
    # first: the ray down the lens axis names the strip, and every other ray is
    # then either in that strip or spilling out of it.
    middle = trace(lens, theta, cell=0.0, rays=rays, aperture=aperture)
    lit = next(r["land"][0] for r in middle if r["axis"])
    strip_here = strip_of(lens, lit, 0.0, n_views)

    # The bundles. The middle lenticule in full, its neighbours faintly — the
    # sheet does the same thing under every lens, which is why it switches as
    # one rather than sweeping across. Amber is a ray landing outside the strip
    # the eye is being shown: the aberration, and the print's crosstalk.
    for c in cells:
        strong = c == 0
        for ray in middle if strong else trace(lens, theta, cell=c * lens.pitch, rays=rays, aperture=aperture):
            at = strip_at(lens, ray["land"][0], c * lens.pitch, n_views)
            on = strip_here - SPILL <= at <= strip_here + 1 + SPILL
            ax.plot(
                [ray["entry"][0], ray["surface"][0], ray["land"][0]],
                [ray["entry"][1], ray["surface"][1], ray["land"][1]],
                color=(RAY if on else WARN) if strong else FAINT,
                lw=1.5 if ray["axis"] and strong else (0.9 if strong else 0.7),
                alpha=(1.0 if on else 0.75) if strong else 0.85,
                zorder=5 if strong else 1,
                solid_capstyle="round",
            )

    # The strip the axial ray reads, outlined where it lies.
    strip = strip_here
    x0 = -half + strip * lens.pitch / n_views + lens.pitch * math.floor((lit + half) / lens.pitch)
    ax.add_patch(
        Rectangle(
            (x0, -art_h),
            lens.pitch / n_views,
            art_h,
            facecolor=view_colour(eye_of(strip, n_views), n_views),
            edgecolor=INK,
            lw=1.8,
            zorder=6,
        )
    )
    ax.plot([lit], [0], marker="o", ms=6, color=INK, zorder=7)

    # The eye itself, on an arc above — schematic, and the only label here.
    r = top - 0.34
    ex, ey = r * math.sin(math.radians(theta)), r * math.cos(math.radians(theta))
    ax.add_patch(
        Wedge(
            (0, 0), r, 90 - lens.view_angle / 2, 90 + lens.view_angle / 2,
            facecolor=RAY, alpha=0.06, edgecolor="none", zorder=0,
        )
    )
    ax.add_patch(Circle((ex, ey), 0.075, facecolor="white", edgecolor=INK, lw=1.4, zorder=8))
    ax.add_patch(Circle((ex, ey), 0.032, facecolor=INK, edgecolor="none", zorder=9))
    ax.text(ex, ey + 0.16, said(theta), ha="center", fontsize=9.5, color=SUB, zorder=9)

    ax.set_xlim(-span, span)
    ax.set_ylim(bottom, top)
    ax.set_aspect("equal")
    clean(ax)
    fig.savefig(path, dpi=96, facecolor="white")
    plt.close(fig)


def main():
    lens = DEFAULT  # replaced below if --surface circle
    # The cone, rounded out to a whole degree, plus one — so the sweep is a
    # degree a frame across everything the lens can show, and the frame at each
    # end is just past the edge, where the print starts repeating. At the
    # defaults that is 53.3° of cone and 57 frames.
    half = math.ceil(lens.view_angle / 2) + 1
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--span", type=float, default=half, help="half-sweep in degrees (default: the cone + 1°)")
    ap.add_argument("--step", type=float, default=1.0, help="degrees per frame")
    ap.add_argument("--views", type=int, default=8, help="views interlaced under each lenticule")
    ap.add_argument(
        "--aperture", type=float, default=APERTURE,
        help="fraction of the half-pitch the drawn bundle spans; 1 is the whole cap, "
             "which is honest but lands over five strips (see APERTURE)",
    )
    ap.add_argument("--out", default=os.path.join(OUT, "anim"))
    ap.add_argument("--gif", default=os.path.join(OUT, "16-viewing-sweep.gif"))
    ap.add_argument("--ms", type=int, default=110, help="milliseconds per frame in the GIF")
    ap.add_argument("--once", action="store_true", help="loop left→right only, instead of walking back")
    ap.add_argument(
        "--surface", choices=("ellipse", "circle"), default="ellipse",
        help="which lens to trace: the ellipse the tool prints, or the circle it used to",
    )
    ap.add_argument(
        "--focus", choices=("axis", "cone"), default="axis",
        help="where the radius puts the focus: on the axis (default), or evenest across the cone",
    )
    args = ap.parse_args()
    # The same solve the tool runs, for whichever surface and focus is asked
    # for — DEFAULT is already ellipse-on-axis, but say it in full so the
    # frames are never quietly something else.
    lens = Lens(45, 0.9, 1.5, profile=args.surface, focus=args.focus)

    os.makedirs(args.out, exist_ok=True)
    angles = np.arange(-args.span, args.span + 1e-9, args.step)
    paths = []
    print(
        f"writing {len(angles)} frames to {args.out}/ — {angles[0]:+.0f}° to {angles[-1]:+.0f}°, "
        f"{args.step:g}° apart, {args.views} views, cone {lens.view_angle:.1f}°"
    )
    for i, theta in enumerate(angles):
        path = os.path.join(args.out, f"sweep-{i:03d}.png")
        # The sweep runs left to right because that is a viewer walking past the
        # print; where the light lands follows from that, and inverts it.
        frame(lens, float(theta), args.views, path, aperture=args.aperture)
        paths.append(path)
        if i % 10 == 0 or i == len(angles) - 1:
            print(f"  {i + 1}/{len(angles)}  {theta:+.0f}°")

    if args.gif:
        from PIL import Image

        # There and back: what a person actually does in front of a print, and
        # it saves the jump a forward-only loop makes at the right-hand edge.
        order = paths if args.once else paths + paths[-2:0:-1]
        first, *rest = [Image.open(p).convert("P", palette=Image.ADAPTIVE, colors=48) for p in order]
        first.save(args.gif, save_all=True, append_images=rest, duration=args.ms, loop=0, optimize=True)
        print(f"\n{args.gif}  ({len(order)} frames, {os.path.getsize(args.gif) / 1e6:.1f} MB)")


if __name__ == "__main__":
    main()
