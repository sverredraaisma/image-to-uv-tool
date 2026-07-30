# Printing your own lenses

**How the Lenticular Print and Lens Grid Print nodes work, and how to do it yourself.**

A UV flatbed printer lays down ink and cures it on the spot, so it can build a stack of clear
varnish — a physical relief — usually up to somewhere between half a millimetre and two, at 600 to
1440 dots per inch. A machine that can build a transparent relief that finely can build **lenses**.
And if it prints the lenses onto the picture it just printed, in the same job, the two line up
perfectly by construction.

That's the whole idea. This guide explains what has to be true for it to work, why the maths comes
out the way it does, and what to do on your own printer.

![Overview of the process](images/01-overview.png)

Everything here is MIT-licensed, like the rest of the repository. There's a note on prior art and
licensing [at the end](#prior-art-and-licence).

---

## Contents

- [What comes out](#what-comes-out)
- [Why printing the lens changes the problem](#why-printing-the-lens-changes-the-problem)
- [Solving the lens](#solving-the-lens)
- [When it can't work](#when-it-cant-work)
- [How wide the view is](#how-wide-the-view-is)
- [Interlacing](#interlacing)
- [Two rasters, two jobs](#two-rasters-two-jobs)
- [Why the relief needs 16 bits](#why-the-relief-needs-16-bits)
- [Angle and phase](#angle-and-phase)
- [The two-dimensional version](#the-two-dimensional-version)
- [Rendering the views from a model](#rendering-the-views-from-a-model)
- [Calibrating](#calibrating)
- [The numbers, at the defaults](#the-numbers-at-the-defaults)
- [Doing it yourself](#doing-it-yourself)
- [When it goes wrong](#when-it-goes-wrong)
- [What this doesn't do](#what-this-doesnt-do)
- [Where the code is](#where-the-code-is)

---

## What comes out

You give the tool N images — the **views** — and some print settings. It gives you two files:

- the **interlaced artwork**, which you print in colour ink;
- the **relief height map**, a 16-bit greyscale image, which you print on top in clear ink.

Here's what that makes, in cross-section. This is drawn at true scale from the real solution at the
tool's defaults, so the proportions are honest — the lens really is that shallow relative to the
stack it sits on.

![Cross-section of the finished print](images/02-cross-section.png)

Three things to notice, because everything else follows from them:

1. The clear ink is the **only** thing between the lens and the picture. There's no substrate in
   between, the way there is when you laminate a lens sheet on top of a print.
2. The lens doesn't fill the whole height. Most of it — 0.702 mm of the 0.9 mm here — is a flat
   base layer, and the actual curve is only the top 0.198 mm.
3. Under each lens the artwork is chopped into strips, one per view.

---

## Why printing the lens changes the problem

With a laminated lenticular sheet you pick a lens and the substrate thickness comes with it: the
manufacturer has already arranged for the focal plane to land on the back face, where you stick your
print. Your job is alignment — matching your interlace to their pitch, which is why the trade has
such elaborate pitch-test rituals.

Printing the lens removes the alignment problem entirely. The pitch is whatever your file says,
because the same machine makes both halves in one pass.

But it introduces a different constraint. The distance from the lens apex down to the image is now
the **ink stack itself**, and the ink stack is limited by what your printer and your varnish can
build. You don't get to choose it to suit the lens; the lens has to suit it.

That single substitution is what makes the rest of this document. It turns "pick a lens sheet" into
a small piece of algebra with a real, binding constraint attached.

---

## Solving the lens

Start with the focus. A curved surface between air and a material of refractive index `n` bends
incoming parallel light to a point. For a single refracting surface of radius `R`, that point sits at
`n·R / (n − 1)` past the surface, measured inside the material. The flat back of the stack is in
contact with the artwork, so it adds no power — the focus stays where the curve put it.

![The focus condition](images/03-focus.png)

We want that focus to land exactly on the artwork, which is `H` below the apex. Setting the focal
distance equal to `H` gives you the radius immediately:

```
R = H (n − 1) / n
```

That's worth pausing on. **The radius depends only on the stack height and the refractive index.**
Not on the pitch, not on how many views you have. Given 0.9 mm of varnish at index 1.5, the surface
is a piece of a sphere of radius 0.3 mm, and that's that.

The pitch decides how much of that sphere you use. A circular arc across a chord of width `p`, rising
to a height `s` in the middle (the **sag**), has radius:

![Sag, chord and radius](images/04-chord.png)

```
R = (s² + (p/2)²) / 2s
```

Two expressions for `R`, one unknown left. Eliminating it gives a quadratic in the sag:

```
n·s² − 2H(n−1)·s + n·p²/4 = 0

        H(n−1) − √( H²(n−1)² − n²p²/4 )
  s  =  ───────────────────────────────
                      n
```

and the flat base underneath is just `b = H − s`.

### Why the minus sign

The quadratic has two roots and both are real solutions — they're the minor and major arc of the
_same_ circle, since both share the radius fixed above. The larger root has a sag bigger than the
radius, which means a surface more than hemispherical: a sphere on a stalk. Not printable, not
useful. Always take the minus root.

---

## When it can't work

Look at the square root. If `H²(n−1)² < n²p²/4` there's no real answer, and rearranging tells you
exactly when:

```
H  ≥  n·p / (2(n − 1))
```

This isn't a numerical quirk, it's physics. As `H` drops toward that bound the sag grows to `p/2` — a
hemisphere, the strongest lens you can make across that chord. Below it, no surface of any shape
spanning that pitch focuses that shallow.

![The feasibility floor](images/05-feasibility.png)

The floor is **linear in the pitch**, so it's inversely proportional to LPI. Read that off the chart
and it says something that surprises people coming from laminated lenticular: **coarse lenses need
thick ink.** A 20 LPI lens needs 1.9 mm of varnish. At a realistic 0.9 mm budget you can't go
coarser than about 42 LPI, and the tool's 45 LPI default sits just 6% above the floor.

If you ask for something impossible, the tool doesn't refuse — it prints the strongest lens it can (a
hemisphere), tells you where that actually focuses, and tells you the height you'd need. A print
that focuses at the wrong depth is blurry, not ruined, and seeing it is more useful than an error.

---

## How wide the view is

The cone you can move through before the image stops flipping is set by the marginal ray: the one
from the focus out through the edge of the lens, refracted back into air.

![The viewing cone](images/06-viewing-cone.png)

```
sin(θ/2) = n · sin( arctan( (p/2) / H ) )
```

Both this and the feasibility floor depend on the pitch and the height **only through their ratio**.
Halve both and nothing changes — same lens shape, same margin, same cone. That has two consequences
worth knowing:

**The refractive index sets a ceiling nobody can beat.** At the feasibility floor the sag is `p/2`
and the cone is as wide as it gets: 45° at n = 1.4, **57° at n = 1.5**, 68° at n = 1.6, 81° at
n = 1.7. No choice of pitch or height gets you past those.

**Any cone you can reach at one pitch, you can reach at every pitch**, by scaling the height in
proportion. That sounds academic; it turns out to matter a lot for [calibration](#calibrating).

---

## Interlacing

Now the artwork. Each lens covers a strip of it, and that strip is divided into N tiles, one per
view. Where your eye is decides which tile the lens shows you.

![How one lens is divided](images/07-interlace.png)

Walking across the sheet at position `u` (measured across the lenses), the arithmetic is:

```
σ = u / p + phase     j = ⌊σ⌋          which lens
                      t = σ − j        where you are inside it, 0…1
                      k = ⌊t · N⌋      which view's tile
```

### The part that's easy to get wrong

Each tile does **not** sample its view at the tile's own position. Every tile of a given lens samples
its view at **that lens's centre**:

```
u_centre = (j + 0.5 − phase) · p
```

It's worth being concrete about why, because the naive version looks perfectly reasonable and
produces a print that's subtly, annoyingly wrong.

![Lens-centre sampling versus per-pixel sampling](images/08-lens-centre-sampling.png)

Sample at the lens centre and all N views agree on which point of the picture that lens represents —
one lens is one pixel of the final image, seen N ways. Sample where each pixel happens to sit and the
views are staggered by `p/N`, so as the print flips, the whole image slides sideways by 423 µm. You'll
see it, and you'll spend a while blaming your printer.

This also tells you the resolution you're going to get. **The number of lenses is the width of each
view.** A 100 mm print at 45 LPI is 177 lenses across, so each view is 177 pixels wide, and no amount
of source resolution changes that. (Vertically, a lenticular keeps everything — a cylinder doesn't
resolve anything along its own length. The [2D version](#the-two-dimensional-version) is not so
generous.)

---

## Two rasters, two jobs

The two output files are deliberately different sizes.

![Two rasters](images/09-dual-raster.png)

The **relief** has to sit on the printer's own raster, because it _is_ a physical surface. The pixels
across one lens — `PPI / LPI`, which is 32 at the defaults — are the steps you have to shape the
curve with. Fewer than about 8 and the lens visibly terraces.

The **artwork** carries no geometry at all. It's flat ink that the RIP will scale onto the sheet, so
it only needs to be big enough that (a) no view tile gets skipped, which means at least 2 pixels per
tile, and (b) you never resample your sharpest source view downward. At the defaults that's 1063
pixels where the relief needs 5669 — about a twenty-eighth of the data for exactly the same print.

### Except when the strips run diagonally

That twenty-eight-fold saving hides an assumption: it holds only while the strips line up **with the
pixel grid**.

Count pixels per strip and orientation looks irrelevant. Pixels are square, so two pixels across a
strip measured along x are two pixels across it at any angle, and no strip is ever skipped. That is a
statement about **sampling density**, and it is true. It says nothing about **placement**.

Turn the array and every boundary between two frames becomes a diagonal. A pixel straddling a diagonal
belongs to two frames and can be printed as only one of them — whichever one its centre happens to
fall in. So the boundary isn't a line, it's a staircase:

```
   want                  coarse raster              printer's raster
   ╲   A ╲   B           ┌───┬───┬───┐              ┌─┬─┬─┬─┬─┬─┬─┬─┐
    ╲     ╲              │ A │ A │ B │              │A│A│A│B│B│B│B│B│
     ╲     ╲             ├───┼───┼───┤   error up   ├─┼─┼─┼─┼─┼─┼─┼─┤   error up to
      ╲     ╲            │ A │ B │ B │   to ½ px    │A│A│B│B│B│B│B│B│   ½ printed dot
```

Half a pixel of misplacement doesn't sound like much until you price it in strips. The minimal raster is
_defined_ as `q` = 2 pixels per strip, so half a pixel is **a quarter of a strip** — a quarter of one
view's slot in the flip, misassigned. On the PPI raster the same half pixel is half a printed dot: 32
pixels span a lens at the defaults, so it is 1/64 of one.

It doesn't average out, either. Every lens down the sheet is misassigned in the same direction, so it
reads as a ragged edge with a long, regular period rather than as noise — and a strip under a lens is a
whole view, so the reading eye gets the wrong one of them along that boundary.

More pixels are the only cure, and there is exactly one sensible amount: **the printer's own raster**.
That is as fine as the staircase can ever be made, because past it the extra pixels never reach the
paper. So a sheet whose strips are diagonal ships its artwork at PPI, the same size as its relief; a
sheet whose strips are axis-aligned keeps the small raster, where the saving is real and free.

| Sheet                                           | Artwork raster                |
| ----------------------------------------------- | ----------------------------- |
| Lenticular at 0° or 90°                         | minimal (1063 px at defaults) |
| Lenticular at any other angle                   | PPI (5669 px)                 |
| 2D grid, square packing, 0° or 90°              | minimal                       |
| 2D grid, square packing, any other angle        | PPI                           |
| 2D grid, [hexagonal packing](#packing-the-caps) | PPI, at any angle             |

Hex is in that last row by construction: staggering every other row is what makes the packing dense,
and it is also what puts the tile edges on diagonals. You don't get one without the other.

Both print nodes say which raster they chose, and why, in their geometry readout.

---

## Why the relief needs 16 bits

A browser canvas is 8-bit, so this repository carries its own small 16-bit PNG writer. Here's why
that was worth the trouble:

![8-bit versus 16-bit quantisation](images/10-quantisation.png)

The whole lens arc is 198 µm tall on a 0.9 mm stack. Eight bits gives you 256 levels over that
0.9 mm, so the arc gets 56 of them — steps of 3.53 µm, on a surface whose job is to focus light.
Sixteen bits gives you steps of 0.0137 µm, which is far below anything the ink can hold.

Two practical notes:

- Ask your RIP what bit depth it reads for the varnish channel, and what height full white
  corresponds to, before you print anything.
- The tool writes the height that 65535 means into the filename, because on a calibration sheet it
  varies.

---

## Angle and phase

**Orientation** rotates the whole array. Because the maths is all done in millimetres in a rotated
frame, this is one parameter with no special cases — set it to 90° and you get a horizontally-ruled
array with vertical parallax, at no extra cost.

**Phase** shifts where view 1 starts inside each lens. On a laminated print this is a survival
mechanism; here, where the lens and the artwork come from the same machine, it's a fine adjustment
for aligning the flip to a preferred head position.

---

## The two-dimensional version

Swap the ruling of cylinders for an array of spherical caps and the print moves in both axes —
left-right _and_ up-down — carrying N² views instead of N.

**The optics don't change.** A sphere and a cylinder refract identically at a surface of radius `R`,
so everything above applies unaltered: same radius, same sag, same base, same feasibility floor, same
cone. Only the footprint is different.

![The 2D lens grid](images/11-grid-plan.png)

Each cap has a diameter of exactly one pitch, so neighbouring caps touch. Whatever the array can't
reach stays flat at base height, where it doesn't focus and contributes a little haze.

![Cap profile through the diagonal](images/12-grid-profile.png)

The alternative would be stretching each cap out to its cell corners so nothing is wasted. It's
tempting, and it's a trap: the sag would then be measured across the diagonal `p√2` instead of the
pitch, which raises the feasibility floor by √2 — from 0.847 mm to 1.20 mm at 45 LPI. For realistic
ink heights that's often the difference between working and not.

### Packing the caps

Circles don't tile a plane, so how you _arrange_ them decides how much of the sheet is left flat.
The **Lenslet packing** setting offers the two arrangements worth having:

| Packing               | Rows                                | Neighbours touched | Under a cap   | Left flat |
| --------------------- | ----------------------------------- | ------------------ | ------------- | --------- |
| Square grid           | square-on, one pitch apart          | 4                  | π/4 = 78.5%   | 21.5%     |
| Hexagonal _(default)_ | offset half a pitch, `p·√3/2` apart | 6                  | π/2√3 = 90.7% | 9.3%      |

![Square against hexagonal packing](images/12b-packing.png)

Hexagonal is the densest packing of equal circles that exists — a fact proved for the plane, not just
the best anyone has found. Shifting every other row by half a pitch lets the next row drop into the
hollows, so rows sit `√3/2 ≈ 0.866` of a pitch apart instead of a full one. Three things follow:

- **Less haze.** Under 10% of the sheet is flat instead of over 20%, so less than half as much light
  passes the array unfocused.
- **~15% more lenslets** in the same area (`1 / 0.866`), all of it in the vertical direction — a
  100 mm × 75 mm sheet at 45 LPI carries 177 × 153 lenslets instead of 177 × 133, so each view
  resolves that much taller.
- **A bigger artwork file.** Staggered rows mean the tile edges no longer run along the pixel grid, so
  the minimal raster can't place them (see [two rasters](#two-rasters-two-jobs)). A hex sheet's
  interlace ships on the printer's own PPI raster instead — 5669 × 4252 at the defaults rather than
  1228 × 921, the same size as the relief, and the diagonals come out at one printed dot instead of one
  view tile.

Nothing else moves: the pitch, sag, radius, base and viewing cone are the same lens either way, and
the caps still touch (in hex they touch six neighbours instead of four). Reach for the square grid
when you're laminating a ready-made square lens array and the print has to line up with it.

Finding which lenslet covers a pixel stops being a floor-divide once the rows are offset, so the
renderer takes the nearest of the three candidate rows' centres — two rows away is more than a pitch
off vertically on its own, so three is always enough. Within a lenslet the view tiles are square in
millimetres on both axes, which keeps a view's angular slice the same horizontally and vertically; a
hex cell reaches slightly past a pitch at its top and bottom tips, and those clamp into the
outermost tiles.

### Naming the views

Every input is named for **where you stand to see it**:

![The nine view names](images/13-view-names.png)

### The bit that will catch you out

A lens inverts. The ray arriving from your eye on the right crosses the axis and lands on the
**left** of the cell. So the view named "Right" has to be printed on the left tile.

![Lens inversion](images/14-mirroring.png)

Get this wrong and the print is _pseudoscopic_: parallax runs backwards, depth turns inside out,
things that should come toward you recede instead. It isn't subtle and it isn't pleasant. The tool
mirrors both axes by default and only lets you switch it off for source material that's already
flipped.

### What the second axis costs

A lenticular quantises one axis and leaves the other alone. A grid quantises both, so each view is
cut down to one sample per lens in each direction:

| Arrangement       | Views | Artwork raster (100 mm, 45 LPI, 4:3) | Each view resolves to |
| ----------------- | ----- | ------------------------------------ | --------------------- |
| 1D, N = 2         | 2     | 709 × 532 px                         | 177 × 532             |
| 1D, N = 3         | 3     | 1063 × 797 px                        | 177 × 797             |
| 2D, 2 × 2, square | 4     | 709 × 532 px                         | 177 × 133             |
| 2D, 3 × 3, square | 9     | 1063 × 797 px                        | 177 × 133             |
| 2D, 2 × 2, hex    | 4     | 5669 × 4252 px (PPI raster)          | 177 × 153             |
| 2D, 3 × 3, hex    | 9     | 5669 × 4252 px (PPI raster)          | 177 × 153             |

That's a 6× loss vertically at a square 3×3 grid — 5× at a hex one, which is what the closer rows buy
you — and it's why detail that survives a lenticular can vanish in a grid. In practice you want a
**higher** LPI for a grid — and conveniently, finer pitch also needs less ink height, so the two
constraints pull the same way for once.

Note what does _not_ change with N: **each view still resolves to one pixel per lenslet whatever the
grid size**, so 177 × 153 is the answer for a 2 × 2 and for a 6 × 6 alike. More views cost you artwork
raster and light per view, not sharpness. Hold on to that — it is what makes the depth budget below
affordable.

---

## Rendering the views from a model

If the subject is a 3D model rather than nine photographs, the views can be rendered — and the
rendering has to be done in a particular way, which is why the tool has its own renderer instead of
leaving you to a 3D package. Two nodes render views, and they share every rule below:

- **Model → Grid Views** fills the N² eye positions of a **lens grid**, with the subject straddling
  the sheet plane — half in front, half behind.
- **Model → Stereo Views** renders a horizontal run of views for a **1D lenticular**, with the
  subject standing entirely _behind_ the sheet. That makes the print a window, which is worth a
  section of its own — see [The window](#the-window-a-subject-behind-the-sheet) below.

### Shift the eye; never rotate it

The obvious approach is to point a camera at the subject from each of the N² positions. Don't. Aiming
the camera ("toe-in") gives every view a different keystone, and it introduces _vertical_ parallax
between views that should differ only horizontally. Under a lens grid that reads as a wobble as your
head moves, and no amount of care in the print will fix it.

Instead keep one view direction for every view and move only the eye position, across a plane
parallel to the sheet. Each view is then a shear of one projection. Concretely, with the eye at
(`eₓ`, `e_y`, `D`) and the sheet at z = 0, the ray to a point (`x`, `y`, `z`) crosses the sheet at

```
t = D / (D − z)
X = eₓ + t(x − eₓ)        Y = e_y + t(y − e_y)
```

![Parallax on the sheet, and the depth it buys](images/14b-model-depth.png)

Set `z = 0` in that and `t` is 1, so `X = x`: **the eye cancels out.** Every view puts a point on the
sheet plane in exactly the same place, which is why that plane is the one that prints sharp no matter
how far you tilt. Off the plane `t ≠ 1`, the eye term survives, and that difference _is_ the parallax
— opposite in sign either side of the sheet, which is the near-things-move-the-other-way you can
verify by holding a finger up against a wall.

`t` earns its keep twice: it is `1/w` for this projection, so it interpolates linearly across a
triangle in screen space and doubles as the z-buffer key.

### The depth budget, which is smaller than you think

Under a lens grid each view is sampled **once per lenslet**. So a feature that moves more than about
one lenslet between adjacent views is never recorded in between: instead of gliding it jumps, and the
lens blur turns the jump into a double image. That gives a hard ceiling on usable depth.

Take it from the projection. The eye step between adjacent views is `s = 2D·tan(cone/2)/(N−1)`, and
∂X/∂eₓ = 1 − t, so a point `z` off the sheet moves `s·z/(D − z)` per step. Set that to one pitch and
solve, and for the usual case of `D ≫ z` the whole thing collapses:

```
usable depth (front to back)  ≈  p · (N − 1) / tan(cone/2)
```

**The viewing distance cancels out.** Depth is set by the pitch, the cone and the grid — nothing else.
At the defaults (45 LPI, 0.9 mm, RI 1.5, so a 53.3° cone) that is:

| Grid  | Printable subject depth |
| ----- | ----------------------- |
| 2 × 2 | 1.1 mm                  |
| 3 × 3 | 2.2 mm                  |
| 4 × 4 | 3.4 mm                  |
| 6 × 6 | 5.6 mm                  |

Two millimetres, for a 100 mm print. That is the single most surprising number in this document, and
it is not a limitation of the implementation — it is what one sample per lenslet per view means. Three
ways to buy more, in order of how much they cost you:

1. **A bigger grid.** Depth grows with `N − 1` and per-view resolution doesn't change at all, so this
   is nearly free — you pay in artwork raster and in light split more ways.
2. **A coarser pitch.** Depth grows with `p`, but coarse lenses need
   [thick ink](#when-it-cant-work) and you lose resolution one-for-one.
3. **A narrower cone.** Fewer degrees to look around in, but every degree carries more depth.

The render node reports the parallax per view step in lenslets and warns past 1.5 of them, with the
depth it suggests instead. Treat that line as the one to satisfy before printing anything.

### Compress the projection, not the model

Fitting a solid to 2 mm of depth by squashing its geometry ruins it: squashed geometry has squashed
_normals_, so a cube flattened to 2 mm shades exactly like the 2 mm slab it has become — three faces
at one flat grey, no solidity at all.

So the renderer fits the model to the sheet with its proportions intact, computes shading from that
true shape, and compresses z **only when projecting**. Shading cues stay at full strength while the
parallax stays printable. This is not a trick invented for lens prints: it is what a bas-relief does,
and sculptors have been doing it since Donatello.

### Where the colour comes from

STL carries shape and nothing else, so an STL prints in one flat material colour. **OBJ** carries two
more things, and the tool reads both:

- **Texture coordinates** (`vt`, referenced from the face lines). The texture image itself arrives on
  a **wire**, not from the file. That is deliberate: a `.mtl` names a third file for the image, and a
  browser handed one uploaded file can fetch neither — while in a node graph the map wants to be a
  wire anyway, so anything that makes an image can feed it.
- **Vertex colours** (`v x y z r g b`). Used when no texture is wired, which is how the
  six-coloured-faces cube in the examples works: each face gets its own four corners, so its colour
  stays flat rather than blending into its neighbours.

Whichever applies replaces the material colour rather than tinting it — a photographic texture must
not be quietly dyed by whatever the colour swatch happens to be set to — and both are interpolated
perspective-correctly, so a texture doesn't swim across a face tilted away from you.

### Nothing needs to be rendered large

One pixel per lenslet per view means 177 × 133 at the defaults. The node renders 512 wide out of the
box, which is already generous, and warns if you go below what the print resolves. A 3D package
rendering nine 4K views for this is wasting nine tenths of the pixels.

### The window: a subject behind the sheet

Everything above lets the subject straddle the sheet plane: half of it in front, half behind. That is
the arrangement that squeezes the most depth out of a given parallax budget, and for a lens grid it
is the right default. For a 1D print there is a better one, and **Model → Stereo Views** builds it:
put the subject **entirely behind the plane**, so the sheet is a window you look into rather than a
surface things float in front of.

That is not a stylistic preference. Three things follow from it, and the third is the one that costs
something.

**Nothing can be cut off while appearing to float in front of the paper.** An object that reads as
nearer than the sheet but is clipped by the sheet's edge asks the eye to believe two contradictory
things at once — the edge is in front of it (it cuts it off) and behind it (it looks nearer). This is
the classic _window violation_, and it is the single most uncomfortable thing a stereo print can do.
A subject that never crosses the plane cannot commit it.

**The frame occludes, exactly as a real window does.** Off-axis, the subject shifts behind a fixed
aperture, so the edges of the sheet cover and uncover it as you move. That is a strong depth cue —
arguably the strongest in the picture — and it costs nothing to have: it is what the paper's own
edges do once the geometry is right.

**Disparity is gentler for the same depth.** Reuse ∂X/∂eₓ = 1 − t with `t = D/(D − z)`. A point in
front of the sheet at `z = +Z` moves `s·Z/(D − Z)` per eye step; a point behind at `z = −Z` moves

```
s·Z / (D + Z)
```

`D − Z` shrinking against `D + Z` growing. At the tool's 400 mm viewing distance a subject 10 mm
deep moves about 5% less per step behind the glass than in front of it, and the gap widens fast as
the subject deepens. Depth behind the plane is simply cheaper than depth in front of it, which is
why a window carries a bigger subject at the same LPI — 6 mm in the stereo example against the 2 mm
the 3×3 grid manages, most of that difference coming from the extra views but some of it from this.

#### What it costs: the subject gets smaller

Perspective does not stop applying because the arrangement is convenient. Seen from the eye, a
subject `Z` behind the window subtends `D/(D + Z)` of what it would at the glass. Fit the model to
the sheet and _then_ push it back, and it no longer fills the frame — the window has a border round
it that nobody asked for.

So the fit is scaled by the reciprocal:

```
scale = (D + Z) / D
```

and `Z` is taken at the **near face** of the subject, not its middle. The near face is the plane that
projects largest, so fitting there is the one choice that guarantees nothing spills past the edge of
the aperture. At the default setback of zero the factor is exactly 1 — the nearest point of the
subject touches the glass and fills the frame, and everything deeper falls away inside it, which is
what a box seen through a window looks like.

#### Ordering the views for the lens

The renderer hands back the run **left eye first**, which is honestly what an eye in each position
sees. That is not what gets printed. A lenticule shows its leftmost strip to an eye on the _right_,
and **Lenticular Print** interlaces frames in the order they arrive — so the node reverses the run
before sending it. Get this backwards and the print is _pseudoscopic_: the parallax runs the wrong
way, near things move like far ones, and the whole picture turns inside out. The switch is under
Advanced (_Order for the lens_) precisely because the only way to be certain which way your own
press ends up is to print one and look at it.

---

## Calibrating

Three things are known imprecisely in real life: your varnish's actual refractive index, the height
your printer really lays down versus what you asked for, and (for a laminated hybrid) the real lens
pitch. Each gets a swept test sheet.

![A calibration sheet](images/15-calibration.png)

Every calibration download gives you three files on the same raster: the interlaced artwork swept
across bands, a **switch target** with the artwork replaced by flat white and black, and the 16-bit
relief. The switch target is the one you actually read — it shows you _where_ the print flips with
none of your artwork's detail in the way.

**Reading it:** print, cure, and look at the switch target from your intended viewing distance while
moving your head across the parallax axis. The right band is the one that flips **cleanly and
uniformly across its whole width** — all black, then all white, with no banding, no gradient
sweeping across, no ghost of the other state.

### The pitch sweep needs a trick

The obvious way to sweep LPI is to hold the height fixed and vary the pitch. That's wrong twice over.
It varies the viewing cone as well as the pitch, so the bands aren't comparable; and the coarse bands
may fall below the feasibility floor and not focus at all, so you'd be judging a broken lens against
working ones.

Because the cone depends only on the ratio `(p/2)/H`, giving each band its own height in proportion
to its pitch fixes both problems at once — every band gets the same cone, and since the floor scales
with pitch identically, every band focuses:

```
H_band = H_reference × LPI_reference / LPI_band
```

| Band   | Pitch    | Height    | Cone   | Focuses? |
| ------ | -------- | --------- | ------ | -------- |
| 40 LPI | 0.635 mm | 1.0125 mm | 53.34° | yes      |
| 45 LPI | 0.564 mm | 0.9000 mm | 53.34° | yes      |
| 50 LPI | 0.508 mm | 0.8100 mm | 53.34° | yes      |

Since the relief is normalised against the tallest stack on the sheet, the finer bands — which need
less ink — simply come out darker. So the sheet also tells you what each candidate pitch will cost
you in height.

---

## The numbers, at the defaults

100 mm wide, 1440 PPI, 45 LPI, 0.9 mm of gloss, index 1.5, no rotation, no phase. Raster sizes assume
a 4:3 source, since the sheet takes its aspect ratio from the first view. Every value here comes out
of the reference implementation.

| Quantity                | Value                                   |
| ----------------------- | --------------------------------------- |
| Lens pitch              | 0.5644 mm (32.00 printer pixels)        |
| Minimum feasible height | 0.8467 mm — so 0.9 clears it by 6.3%    |
| Radius of curvature     | 0.3000 mm                               |
| Lens sag                | 0.1983 mm                               |
| Flat base beneath       | 0.7017 mm                               |
| Focus below apex        | 0.9000 mm (equal to H, by construction) |
| Viewing cone            | 53.34° (ceiling at this index: 56.6°)   |
| Lenses across the sheet | 177                                     |
| Relief raster           | 5669 × 4252 px — 24.1 MP                |
| Artwork raster, 3 views | 1063 × 797 px — 0.85 MP                 |
| 16-bit height step      | 0.0137 µm                               |

A quick consistency check on the two ways of writing the radius: `H(n−1)/n = 0.9 × 0.5 / 1.5 =
0.300000`, and from the solved sag via the chord, `0.300000`. They agree to six decimals, as they
have to.

---

## Doing it yourself

### What you need

- A **UV flatbed** with a clear/varnish channel that can build to at least a millimetre or so, and a
  RIP that takes a greyscale height map for it.
- **Cured clear ink** whose refractive index you can look up or measure. Most UV clears are near 1.5.
  If the datasheet is silent, calibrate for it.
- A flat, dimensionally stable substrate.
- N images that differ only by viewpoint — rendered from a 3D scene, shot on a camera slider, or
  taken as the frames of an animation. For a flip or a loop rather than a depth effect they needn't
  be viewpoints at all; any N frames that read as a sequence will do, and an animated GIF is the
  easiest source of them.

### In this tool

1. Add a **Lenticular Print** node (or **Lens Grid Print** for 2D), plus a source of views: one
   **Image Input** per view, or a single **Animation Input** whose `Frames` output carries a whole
   decoded animation down one wire.
2. Connect them. For the lenticular node connection order is viewing order. For the grid node each
   port is named for the direction it's viewed from — connect by name and let the node handle the
   mirroring.
3. Set width, PPI, LPI, height and RI. On the grid node also pick **Lenslet packing** — leave it
   hexagonal unless you are lining the print up with an existing square array. Watch the **Info**
   output: it reports the solved sag, base, focus and cone, which raster the artwork landed on and
   why, and warns you if the combination can't focus.
4. Press **Run**.
5. Open the node's editor and download the **16-bit gloss depth map**. The `interlaced` output is
   your artwork; the `depth` output is an 8-bit preview only — don't print that one.
6. Before committing to a real print, download the **calibration sheets** and read them as above.

### From scratch

The whole method is about sixty lines of arithmetic. Nothing here needs this repository:

```python
# ---- inputs ---------------------------------------------------------
#   views[]      N source images, in viewing order
#   width_mm     printed width;  PPI, LPI, H (mm), n, phase, q
#   o            orientation in RADIANS
o          = radians(orientation_deg)
height_mm  = width_mm * views[0].height / views[0].width   # sheet aspect
frac       = lambda x: x - floor(x)

# ---- solve the lens -------------------------------------------------
p      = 25.4 / LPI
H_min  = n * p / (2 * (n - 1))
disc   = H*H*(n-1)**2 - n*n*p*p/4
if disc < 0:
    warn(f"cannot focus in {H} mm; need at least {H_min} mm")
    s = p / 2                      # hemisphere, the strongest lens
else:
    s = (H*(n-1) - sqrt(disc)) / n # minor arc — the printable root
R      = (s*s + (p/2)**2) / (2*s)
b      = max(0, H - s)

# ---- interlaced artwork ---------------------------------------------
cells      = width_mm / p
map_w      = round(width_mm / 25.4 * PPI)        # the printer's own raster
diagonal   = abs(orientation_deg % 90) > 0       # strip edges off the pixels?
art_w      = max(ceil(cells * N * q),
                 max(view.width for view in views),
                 map_w if diagonal else 0)       # diagonals need every dot
art_h      = round(art_w * views[0].height / views[0].width)
mm_per_px  = width_mm / art_w

for py in range(art_h):
  for px in range(art_w):
      x, y = (px + 0.5) * mm_per_px, (py + 0.5) * mm_per_px
      u    =  x*cos(o) + y*sin(o)
      v    = -x*sin(o) + y*cos(o)
      sig  = u / p + phase
      j, t = floor(sig), sig - floor(sig)
      k    = min(N - 1, int(t * N))
      u_c  = (j + 0.5 - phase) * p              # sample at the LENS CENTRE
      sx, sy = u_c*cos(o) - v*sin(o), u_c*sin(o) + v*cos(o)
      art[py][px] = bilinear(views[k], sx / width_mm, sy / height_mm)

# ---- relief map (printer raster, 16-bit) ----------------------------
map_h      = round(map_w * views[0].height / views[0].width)
mm_per_px  = width_mm / map_w

for py in range(map_h):
  for px in range(map_w):
      x, y = (px + 0.5) * mm_per_px, (py + 0.5) * mm_per_px
      u    = x*cos(o) + y*sin(o)
      t    = frac(u / p + phase)
      d    = (t - 0.5) * p
      z    = b + max(0, sqrt(max(0, R*R - d*d)) - (R - s))
      depth[py][px] = round(min(1, z / H) * 65535)
```

For the 2D version: compute `v` as well, quantise it the same way to get a row index, use
`d = hypot(d_u, d_v)` with `z = b` wherever `d > p/2`, and mirror both view indices. For hexagonal
packing, divide `v` by `p·√3/2` instead of `p`, offset odd rows by half a pitch, take the nearest of
the three candidate row centres — and treat `diagonal` as true, staggered rows being diagonal by
construction.

This listing isn't decorative — it's pinned. `src/lib/docsPseudocode.test.ts` is a literal port of it,
asserted to produce **byte-identical** output to the real renderers at an awkward configuration: 23°
orientation, phase 0.3, three views, odd pixel dimensions. If the code and this page ever drift
apart, that test fails.

### Printing

1. Print the artwork in colour, scaled to the physical width you specified.
2. Print the relief on top in clear ink, at the same physical width, from the 16-bit map. Check that
   your RIP's white-equals-what-height setting matches what the map was normalised to.
3. Cure it properly. Under-cured ink slumps, and a slumped lens is a longer-focus lens.

---

## When it goes wrong

| What you see                            | Probably                                             | Try                                                                             |
| --------------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------- |
| Soft everywhere, never a clean flip     | Focus isn't landing on the artwork                   | Check the feasibility floor; run the Height calibration                         |
| Clean at one edge, smeared at the other | Pitch mismatch (laminated lens, or RIP scaling)      | Run the LPI calibration                                                         |
| Two views visible at once               | Focus too long, or the ink slumped                   | More height, or cure harder                                                     |
| Depth inverted, motion feels wrong      | Pseudoscopic — views not mirrored                    | Mirror both view indices                                                        |
| Stair-stepping on the lens surface      | 8-bit relief, or too few pixels per lens             | Emit 16-bit; raise PPI or lower LPI to ≥ 8 px per lens                          |
| A view missing from some lenses         | Artwork raster too small, a tile fell between pixels | Raise samples per tile to 2 or more                                             |
| Image slides sideways as it flips       | Sampling per-pixel instead of at the lens centre     | See [interlacing](#interlacing)                                                 |
| Ragged, regularly-stepped view edges    | Diagonal strips on a minimal artwork raster          | Raster the artwork at PPI — see [above](#except-when-the-strips-run-diagonally) |
| Contrast lower than expected (2D only)  | Sheet left flat between the caps: 21.5% square       | Switch to [hex packing](#packing-the-caps) for 9.3%, or raise LPI               |

---

## What this doesn't do

Worth being straight about:

- **The optics are paraxial.** The focus used here is the paraxial focus of a single refracting
  surface. A real spherical cap at these apertures has noticeable spherical aberration — the edge
  rays focus shorter than the middle ones, so the flip is softer at the edge of the cone than in the
  centre. An aspheric profile would fix it, and the profile equation is the only thing that'd change.
- **No chromatic correction.** Index varies with wavelength, so the flip point differs slightly by
  colour.
- **Ink isn't glass.** Cured varnish shrinks and slumps and may not hold the shape you modelled. That
  gap is exactly why the calibration sheets exist.
- **Resolution.** One sample per lens, per view — and in 2D, per lens in both axes. That's intrinsic
  to the technique, not a limitation of this implementation.
- **Your printer is not the author's.** This has been printed: the technique works on a physical UV
  flatbed, and the guide reflects what came off it — the
  [diagonal-raster problem](#except-when-the-strips-run-diagonally) above is the kind of thing that only
  turns up that way. But height, index and slump are properties of _your_ machine and _your_ varnish,
  and the whole reason the calibration sheets exist is that nobody can hand you those three numbers.
  Print them first; treat them as mandatory, not optional.

---

## Where the code is

| Topic                    | Implementation                                                                            |
| ------------------------ | ----------------------------------------------------------------------------------------- |
| The lens solve           | `lensGeometry()`, `heightForViewAngle()` in `src/lib/lenticular.ts`                       |
| Interlacing              | `renderInterlaced()`                                                                      |
| The two rasters          | `interlacedSize()`, `outputSize()`                                                        |
| The relief map           | `renderDepthMap()`                                                                        |
| 16-bit PNG               | `encodeGray16Png()` in `src/lib/png16.ts`                                                 |
| The 2D grid              | `renderGridInterlaced()`, `renderGridDepthMap()`, `gridCellLabel()`                       |
| Square vs hex packing    | `latticeAt()`, `HEX_ROW_SPACING`, `packingFill()`                                         |
| Calibration              | `calibrationValues()`, `withCalibrationValue()`, `switchFrames()`, `gridSwitchViews()`    |
| Rendering from a model   | `src/lib/render3d.ts` — `projectToSheet()`, `eyeOffsetsMm()`, `disparityPerStep()`        |
| The window               | `renderViewSequence()`, `disparityAtDepth()`, `prepareVertices()`'s `fitAtZMm`            |
| Reading a mesh in        | `parseMesh()` in `mesh.ts` → `parseStl()` / `parseObj()`                                  |
| The nodes                | `src/nodes/lenticular.ts`, `lensGrid.ts`, `radialGrid.ts`, `model3d.ts`, `modelStereo.ts` |
| The numbers on this page | `src/lib/lenticular.test.ts`                                                              |
| The figures              | `docs/figures.py` — run `python docs/figures.py` to redraw them                           |

---

## Prior art and licence

Lenticular printing is old. Interlacing images into strips behind a ruled cylindrical sheet goes back
to the early twentieth century, and Lippmann described integral photography — a 2D array of lenslets
over a 2D array of small images — in 1908. None of the interlacing here is new, and this page doesn't
claim otherwise.

What it does set out carefully is the case where the lens is _printed onto_ the image rather than
laminated over it, so that the apex-to-image distance is the ink stack itself. That's what produces
the closed-form solve, the feasibility floor, the scale-invariance of the cone, the angle-matched
pitch sweep, and the two-raster split described above.

All of it is published freely under this repository's MIT licence, as a defensive disclosure: no
patent is sought or asserted on any of it, and it's written out in this much detail specifically so
that it stays available to everyone.
