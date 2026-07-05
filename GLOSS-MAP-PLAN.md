# Gloss / specular map generation — plan

Goal: given an arbitrary input artwork, produce a **spot-gloss (varnish) map** for UV
printing that looks intentional — glossy where a human designer would put it — using
**no generative AI**. Everything below is either classical image processing (pure
`lib/image.ts` ops) or *discriminative* model inference the pipeline already uses
(Depth Anything, BiRefNet, Grounded SAM analyse the artist's pixels; they don't
synthesise new ones).

The heightmap flow already works. Gloss is the same shape of problem — *derive a
greyscale control map from the art, then condition it for the printer* — so most of
this plan reuses the existing node graph, plus a handful of small new local nodes.

---

## 1. What makes a gloss map "look nice" (domain constraints)

A gloss map is not a picture; it's a deposition mask. Print-shop practice for spot
UV gives us concrete quality rules, and each one maps to a processing step:

| Rule | Why | Pipeline consequence |
| --- | --- | --- |
| Gloss should land on *meaningful* features | Random gloss reads as printing error | Derive from signals in §2, not global filters alone |
| Minimum feature size ≈ 0.5–1 mm | Sub-droplet speckles read as dirt and don't jet reliably | Despeckle / remove-small-regions step |
| No pinholes inside gloss shapes | Tiny matte holes look like defects | Morphological close |
| Choke gloss 1–2 px inside colour edges | Registration misalignment otherwise leaves a shiny halo next to the shape | Erode as last step |
| Edges hard, not anti-aliased | Grey edge pixels dither into a fringe of scattered varnish dots | Binarise **last**, at final resolution |
| Total coverage roughly 5–30 % | 90 % coverage is just a gloss coat; contrast with matte is the effect | Coverage % readout in the preview |
| Gloss amplifies relief | Shiny peaks + matte valleys is the classic tactile-print look | Reuse the depth map already in the graph |

Two workflow principles fall out of this:

1. **Stay greyscale until the very end.** Every signal below produces a soft 0–255
   "glossiness" map; shaping (curves/levels), mixing (max/multiply) and smoothing all
   happen in greyscale. Threshold → despeckle → choke is the final, shared tail.
2. **Binarise at print resolution.** Resize *before* the threshold, never after —
   scaling a binary mask re-introduces grey edges.

---

## 2. Signals: where should gloss go? (all non-generative)

No single detector works for all art. The plan is a small set of *composable
signals*, each cheap, each already ~80 % supported by existing nodes. A user picks
one or blends several with `Combine (max)` — exactly how the heightmap graph blends
depth with the original.

### 2.1 Painted-highlight extraction — the flagship signal ⭐

If the artist painted a glint (eyes, metal, wet surfaces, rim light), placing real
varnish exactly there is the single most impressive effect: the printed highlight
then moves under real light, in the spot the artist chose. This respects the artwork
rather than inventing content.

Detection is classical (dichromatic reflection model): painted speculars are
**locally bright** and **desaturated relative to their surroundings**.

- *Locally* bright, not globally: `highlight = max(0, lum − blur(lum, R) − bias)`
  (a positive high-pass / white top-hat). A big radius `R` makes a white sky score
  zero while a small glint on a dark cheek scores high.
- Desaturation weighting: multiply by `(1 − S)^k` (HSV saturation) so vivid flat
  colours don't false-positive.

This is one new pure op (§3.1) built entirely from existing pieces (`boxBlur`,
`luminance`, the HSV math already in `hueSaturation`).

### 2.2 Tone-band gloss (zero new AI, zero new cost)

Gloss the top N % of luminance (bright-tone gloss) or the bottom N % (**dark-luxury
gloss** — spot varnish on deep blacks is a classic premium-print move and works
beautifully on posters). Needs `Levels`/`Curves` (exist) plus an **Auto Threshold**
node (§3.2), because a fixed 0–255 threshold breaks on dark or pale art — the
threshold must be a *percentile* of the actual histogram (or Otsu).

### 2.3 Vivid-colour gloss

Gloss the most saturated regions to make inks pop. Just needs `Extract Channel` to
learn HSV channels (§3.3): `Saturation → Curves → tail`.

### 2.4 Semantic material gloss (discriminative AI, optional)

`Grounded SAM` is already a node. Text-prompt it with material words — `eyes`,
`metal`, `glass`, `water`, `lips`, `jewelry`, `chrome` — and OR the masks together
(`Combine Masks` exists). This is segmentation of what's already in the image, not
generation, so it stays inside the ethical constraint. Pure recipe; no code needed.

### 2.5 Depth reuse — free, because it's already in the graph

The heightmap workflow already runs Depth Anything. `Grey depth → Levels (isolate
the near band) → tail` glosses the foreground subject so it pops off a matte
background. Marginal cost: zero (the prediction is already cached).

Related: **gloss the relief peaks** — feed the *finished heightmap itself* through
`Auto Threshold (top ~20 %)` and the raised areas of the print become the shiny
areas. Strong default for tactile prints; costs nothing.

### 2.6 Linework / type gloss

For flat illustrations and posters: `Edge Detect (exists) → Dilate 1–2 px → tail`
puts gloss on the linework and lettering. Reads as deliberate design even on art
with no painted highlights at all — good fallback when §2.1 finds nothing.

### 2.7 Subject gating and artist override

- Whatever signal is used, `AND` it with the BiRefNet alpha (already in the example
  graph: `Extract Channel (alpha) → Combine Masks (AND)`) so the background stays
  matte.
- `Area Picker` (exists) is the manual escape hatch: click to add or, via
  `Combine Masks (A−B)`, subtract regions. Every automated recipe should end in an
  optional manual override slot.

**Recommended default recipe** (works on most art):
`max(painted highlights §2.1, relief peaks §2.5)` → gated by subject mask → shared
tail (§4) → previewed (§5).

---

## 3. New nodes (all local, auto-run, pure, worker-friendly)

Five small additions. Each follows the existing pattern exactly: pure function in
`lib/image.ts`, registered in the `heavyOps.ts` worker registry where per-pixel
loops are heavy, exposed via `singleImageOp(...)` in `nodes/local.ts`, unit-tested
like their neighbours.

### 3.1 `Highlight Extract` (new op `highlightExtract`)

```ts
highlightExtract(img, { radius, satRejection, gain, bias }): RasterImage
// lum   = luminance(img)
// base  = boxBlur(lum, radius)            // radius default ~24 px: "local" scale
// spec  = max(0, lum − base − bias) * gain
// out   = spec * (1 − saturation)^satRejection   // greyscale, opaque
```

Config: `radius` (px), `satRejection` (0 = off, default 2), `gain`, `bias`.
Category: Mask. Reuses `boxBlur` internals; O(n).

### 3.2 `Auto Threshold` (new op `autoThreshold`)

Modes: **Otsu** (histogram valley) and **percentile** ("brightest N % become
white"). Optional invert (for dark-luxury). One histogram pass + one map pass; can
also emit the chosen threshold for debugging. This is the piece that makes recipes
robust across arbitrary images — every fixed threshold in a shipped template is a
future bug report.

### 3.3 `Extract Channel` — add HSV channels

Extend `Channel = 'r' | 'g' | 'b' | 'a' | 'lum'` with `'sat' | 'val' | 'hue'`
(`src/lib/image.ts:463`). The RGB↔HSV math already exists inside `hueSaturation`;
hoist it into shared helpers. Smallest change in the plan, unlocks §2.1 and §2.3.

### 3.4 `Despeckle` (new op `despeckle`)

Connected-component pass (the flood-fill machinery in `magicWand.ts` is the
starting point): remove white islands below `minArea` px², optionally fill black
holes below `minHoleArea`. Config in px² now; a DPI-aware "mm" field can come later
(§7). Also worth folding **open/close** options into the existing Dilate/Erode node
(they're just the two ops composed) so "close pinholes" is one node, not two.

### 3.5 `Gloss Preview` — the feedback loop that makes everything else work

You cannot judge a varnish mask by staring at black-and-white blobs. This node
*simulates the print*:

- **Inputs:** `art` (image), `gloss` (mask), `heightmap` (optional image).
- **Config:** light azimuth + elevation, shininess exponent, intensity.
- **Compute:** per-pixel normals from the heightmap (the gradient math in
  `normalMap`, `src/lib/image.ts:898`, reused directly; flat normals if no
  heightmap), Blinn-Phong specular `pow(max(N·H, 0), shininess)`, masked by the
  gloss map, screened over the artwork. Optionally darken/flatten non-gloss areas a
  touch to suggest matte.
- **Outputs:** `preview` (image) and `stats` (text): **gloss coverage %** — the
  guardrail from §1 — plus speck count from §3.4 if wired.

Deterministic canvas math, ~80 lines, testable ("gloss=black in ⇒ preview == art";
"coverage of a half-white mask = 50 %"). A later polish step can add a
`customEditor` (the Curves/AreaPicker pattern) to drag the light interactively.

*(Optional, phase G3: a `Saliency` node — spectral-residual saliency is ~50 lines
with no model download — but BiRefNet already covers subject-level saliency, so
this is not on the critical path.)*

---

## 4. The shared print-prep tail

Every recipe ends with the same conditioning chain, built almost entirely from
existing nodes:

```
greyscale gloss signal
  → Curves            (shape response — exists)
  → Box Blur 1–2 px   (pre-smooth so the threshold cuts a clean contour — exists)
  → Auto Threshold    (NEW §3.2 — binarise, percentile/Otsu)
  → Despeckle         (NEW §3.4 — min feature size, fill pinholes)
  → Dilate/Erode: close (extend existing node — seal remaining holes)
  → Erode 1 px        (exists — registration choke)
  = final gloss map (binary, print resolution)
```

For printers that accept **multi-level gloss** (variable varnish density,
matte→satin→high gloss), swap `Auto Threshold` for `Posterize` (exists) to a few
levels and skip the choke on interior level boundaries — worth documenting, not
worth new code.

---

## 5. Recipes to ship as example templates

`src/components/examples.ts` already has the template mechanism, and the README's
node catalog documents workflows. Ship gloss as **recipes first, nodes second** —
the heightmap flow proved the composable-graph approach; gloss should feel the same.

1. **Spot gloss — painted highlights (no AI)**: Image Input → Highlight Extract →
   tail → Gloss Preview. Works offline, no API key, instant. *The flagship demo.*
2. **Spot gloss — relief peaks**: existing heightmap graph + Auto Threshold branch
   off the heightmap → tail → Gloss Preview (heightmap wired in, so the preview
   shows shiny raised areas). One extra branch on the graph users already have.
3. **Spot gloss — linework** (flat illustration): Edge Detect → Dilate → tail.
4. **Spot gloss — materials** (one manual AI step): Grounded SAM ("eyes, metal,
   glass, water") → Combine Masks OR → tail.
5. **Dark luxury**: Greyscale → Invert → Auto Threshold (top 10 %) → tail.

Each template ends in Gloss Preview so the first thing a user sees is a simulated
print, not a mask.

---

## 6. Implementation phases

| Phase | Scope | Size | Risk |
| --- | --- | --- | --- |
| **G0** | §3.3 HSV channels, §3.2 Auto Threshold, §3.1 Highlight Extract, §3.4 Despeckle + open/close; pure ops + worker registry + tests | ~1 day | Low — additive, follows `singleImageOp` pattern |
| **G1** | §3.5 Gloss Preview node with coverage stat | ~½–1 day | Low — pure math; reuses `normalMap` gradients |
| **G2** | Example templates (§5) + README catalog rows + a short "gloss map" docs section with the §1 rules | ~½ day | None |
| **G3** (later) | Interactive light-drag editor for the preview; DPI/mm-aware Despeckle sizing; Saliency node; multi-level gloss guidance | as needed | Low |

Test strategy mirrors the codebase: every new `lib/image.ts` op gets direct Vitest
coverage (synthetic images with known answers — e.g. a single bright pixel on grey
must survive Highlight Extract; a 2-px speck must not survive Despeckle at
`minArea=9`), plus one pipeline test chaining Highlight Extract → Auto Threshold →
Despeckle like the existing end-to-end node pipeline test.

## 7. Explicitly out of scope

- **Generative models** (relight/IC-Light, inpainting, style transfer) — excluded
  by the project's ethical constraint; nothing above needs them.
- **Printer-specific output formats** (spot-channel TIFF/PDF, RIP integration) —
  the tool ends at a clean PNG mask, same contract as the heightmap → STL boundary.
  Per-device DPI/mm sizing is the only printer awareness worth adding (G3).
- **Trained "gloss prediction" networks** — even discriminative ones are overkill;
  the composable-signal approach keeps every decision inspectable and overridable,
  which fits both the node-graph philosophy and the respect-the-artist stance.
