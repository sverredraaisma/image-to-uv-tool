// Lenticular print generation: interlacing N frames under a lens array, and the
// matching gloss (varnish) depth map that *is* that lens array.
//
// Geometry, in one place, because everything else follows from it:
//
//   pitch     p = 25.4 / LPI                  lenticule width, mm
//   sag       s                               how far the lens bulges, mm
//   base      b = H - s                       flat varnish under the lens, mm
//   radius    R = (s² + (p/2)²) / (2s)        circle through the chord + sag
//
// The print is varnish laid straight onto the artwork, so the distance from the
// lens apex down to the image is the whole gloss height H. Rays entering the
// curved surface from air focus, inside the material, at n·R/(n-1) past the
// vertex. Setting that equal to H and solving for s:
//
//   n·s² − 2H(n−1)·s + n·p²/4 = 0
//   s = [ H(n−1) − √( H²(n−1)² − n²p²/4 ) ] / n
//
// Both roots put the focus on the artwork — they are the minor and major arc of
// the *same* circle — so we take the minor one, the only printable lens. The
// discriminant is the design constraint: H must be at least n·p / (2(n−1)) or no
// lens of that pitch can focus that shallow, and the caller gets told so.
//
// Pure: no DOM, no canvas. Directly unit-testable.

import type { RasterImage } from '../types';
import { createImage } from './image';
import type { ChunkProgress } from './chunked';

/**
 * How big a raster either half of a print may be before the tool stops and
 * asks. This is not a hard limit — it is the line between "just render it" and
 * "this will take a while, are you sure?"; past it a render needs the caller's
 * consent (`RenderOptions.allowOversize`) and runs in chunks with progress.
 */
export const MAX_OUTPUT_PIXELS = 80_000_000;

/**
 * …and this one *is* hard. Every pixel of the artwork costs 4 bytes and every
 * pixel of the relief 2, so 500 MP is already a 2 GB buffer, which is about
 * what a browser tab can hold at all. Past this there is nothing to consent to:
 * the allocation itself would fail, and failing early with a number is kinder
 * than a dead tab.
 */
export const MAX_OVERSIZE_PIXELS = 500_000_000;

/**
 * Pixels per chunk of a chunked render. Small enough that the gap between
 * chunks — where the UI paints, the progress bar moves and a cancel is noticed —
 * comes round every fraction of a second, big enough that the per-chunk
 * overhead is nothing against the per-pixel work.
 */
export const CHUNK_PIXELS = 4_000_000;

/** A render that needs the caller's consent before it runs. */
export class OversizeOutputError extends Error {
  constructor(
    /** Which raster: 'Interlaced artwork' or 'Depth map'. */
    readonly what: string,
    readonly width: number,
    readonly height: number,
    /** How to make it smaller instead, if that is what the user would rather. */
    readonly fix: string,
    /** Chunks the render would be split into once allowed. */
    readonly chunks: number,
    message: string,
  ) {
    super(message);
    this.name = 'OversizeOutputError';
  }

  get pixels(): number {
    return this.width * this.height;
  }
}

export type { ChunkProgress };

/** Rows of a `width`-wide raster that fit in one chunk. */
export const chunkRows = (width: number, chunkPixels = CHUNK_PIXELS): number =>
  Math.max(1, Math.floor(Math.max(1, chunkPixels) / Math.max(1, width)));

/** Chunks a `width` × `height` pass will be split into. */
export const chunkCount = (width: number, height: number, chunkPixels = CHUNK_PIXELS): number =>
  Math.max(1, Math.ceil(Math.max(1, height) / chunkRows(width, chunkPixels)));

export interface LenticularSettings {
  /** Printed width in millimetres; height follows the first frame's aspect. */
  widthMm: number;
  /** Printer resolution, pixels per inch. */
  ppi: number;
  /** Lens array density, lenticules per inch. */
  lpi: number;
  /** 0–1: where in the lenticule the first frame's strip starts. */
  phase: number;
  /** Intended max print height of the gloss stack, mm (lens apex to artwork). */
  heightMm: number;
  /** Refractive index of the cured varnish. */
  ri: number;
  /** Orientation of the lenticules, degrees. 0 = they run vertically. */
  orientationDeg: number;
  /**
   * Pixels per frame strip in the interlaced artwork — its whole resolution
   * budget, see {@link interlacedSize}. 1 is the theoretical minimum but drops
   * strips wherever the phase lands badly; 2 is the safe floor.
   */
  stripSamples: number;
}

export interface LensGeometry {
  /** Lenticule width, mm. */
  pitchMm: number;
  /** Lenticule width, printer pixels. */
  pitchPx: number;
  /** Lens bulge above the flat base, mm. */
  sagMm: number;
  /** Flat varnish beneath the lens, mm (H − sag). */
  baseMm: number;
  /** Radius of curvature of the lens surface, mm. */
  radiusMm: number;
  /** Where the lens actually focuses, mm below the apex. */
  focusMm: number;
  /** Total stack height, mm (base + sag; equals H when feasible). */
  totalMm: number;
  /** Can a lens of this pitch focus at this height with this RI? */
  feasible: boolean;
  /** Smallest gloss height that can focus at this pitch/RI, mm. */
  minHeightMm: number;
  /** Full viewing cone in air, degrees. */
  viewAngleDeg: number;
}

/**
 * Solve the lens profile for one set of settings. Never throws: an infeasible
 * combination falls back to the strongest printable lens (a hemisphere) and
 * reports the focus it actually achieves, so the UI can explain the mismatch.
 */
export function lensGeometry(settings: LenticularSettings): LensGeometry {
  const lpi = Math.max(1e-6, settings.lpi);
  const ppi = Math.max(1e-6, settings.ppi);
  const n = Math.max(1.0001, settings.ri);
  const h = Math.max(1e-6, settings.heightMm);
  const pitchMm = 25.4 / lpi;
  const pitchPx = ppi / lpi;
  const halfPitch = pitchMm / 2;

  const minHeightMm = (n * pitchMm) / (2 * (n - 1));
  const disc = h * h * (n - 1) * (n - 1) - n * n * halfPitch * halfPitch;
  const feasible = disc >= 0;
  // Infeasible → hemisphere, the shortest focus this pitch can produce.
  const sagMm = feasible ? (h * (n - 1) - Math.sqrt(disc)) / n : halfPitch;
  const radiusMm = (sagMm * sagMm + halfPitch * halfPitch) / (2 * sagMm);
  const focusMm = (n * radiusMm) / (n - 1);
  const baseMm = Math.max(0, h - sagMm);
  const totalMm = baseMm + sagMm;

  // Marginal ray from the focus to the lens edge, refracted back out to air.
  const sinInside = halfPitch / Math.hypot(halfPitch, focusMm);
  const sinAir = Math.min(1, n * sinInside);
  const viewAngleDeg = 2 * (Math.asin(sinAir) * (180 / Math.PI));

  return {
    pitchMm,
    pitchPx,
    sagMm,
    baseMm,
    radiusMm,
    focusMm,
    totalMm,
    feasible,
    minHeightMm,
    viewAngleDeg,
  };
}

// ---------------------------------------------------------------------------
// Pitch as pixels per lens
// ---------------------------------------------------------------------------
//
// LPI is how lens sheets are sold, so it is what the nodes store. But it is the
// wrong number to *choose* one by here, because this tool prints its own lens:
// the depth map is rastered at PPI, on the same grid as the interlace, and a
// lens is only as repeatable as that grid lets it be.
//
// The number that governs that is PPI / LPI — how many printed pixels one
// lenticule spans. Give it a whole value and every lens on the sheet is
// identical: same pixel columns under each, same sag profile, same phase. Give
// it 28.8 and no two neighbours are alike — the strip boundaries land at a
// different subpixel offset under each lens, drifting a whole pixel every five
// of them, and that drift is a slow bright/dark banding across the print that
// no amount of care with the artwork removes.
//
// Even or odd then decides where the lens axis falls. Even splits the lenticule
// symmetrically, with the axis on a pixel boundary — which is what an even
// number of views wants, half the strips either side. Odd puts one pixel
// centred on the axis, which is the head-on view, and is what an odd view count
// wants so that its middle frame is genuinely the middle.

/** How many printed pixels one lenticule spans. The number to design by. */
export const pixelsPerLens = (settings: Pick<LenticularSettings, 'ppi' | 'lpi'>): number =>
  Math.max(1e-6, settings.ppi) / Math.max(1e-6, settings.lpi);

/** The LPI that gives exactly this many pixels per lens at this PPI. */
export const lpiForPixelsPerLens = (ppi: number, ppl: number): number =>
  Math.max(1e-6, ppi) / Math.max(1e-6, ppl);

/** Whether a pixels-per-lens figure wants an even split, an odd one, or anything. */
export type PplParity = 'any' | 'even' | 'odd';

/**
 * Nearest whole pixels-per-lens of the requested parity, never below 2.
 *
 * Below 2 px a lenticule cannot show two views at all, so there is nothing to
 * interlace; the clamp is what keeps a snap from proposing a lens that could
 * not print a flip.
 */
export function snapPixelsPerLens(ppl: number, parity: PplParity = 'any'): number {
  const target = Math.max(2, ppl);
  if (parity === 'any') return Math.max(2, Math.round(target));
  const step = 2;
  const offset = parity === 'even' ? 0 : 1;
  const snapped = Math.round((target - offset) / step) * step + offset;
  return Math.max(parity === 'odd' ? 3 : 2, snapped);
}

/** What a pixels-per-lens figure means for the consistency of the print. */
export interface PplFit {
  ppl: number;
  /** Whole pixels per lens: every lenticule identical. */
  whole: boolean;
  /** Only meaningful when whole. */
  parity: 'even' | 'odd' | null;
  /**
   * How far the strip pattern drifts across the whole sheet, in pixels — the
   * accumulated error of a fractional pitch over every lens on the print.
   */
  driftPx: number;
  /** Lenses the sheet holds at this pitch. */
  lensCount: number;
  /** Pixels each view gets under one lens, when it divides evenly. */
  pxPerView: number | null;
}

/** Measure a pitch against the raster it has to print on. */
export function pplFit(settings: Pick<LenticularSettings, 'ppi' | 'lpi' | 'widthMm'>, views = 0): PplFit {
  const ppl = pixelsPerLens(settings);
  const fraction = ppl - Math.round(ppl);
  const whole = Math.abs(fraction) < 1e-9;
  const lensCount = (Math.max(0.01, settings.widthMm) * Math.max(1e-6, settings.lpi)) / 25.4;
  const perView = views > 0 ? ppl / views : 0;
  return {
    ppl,
    whole,
    parity: whole ? (Math.round(ppl) % 2 === 0 ? 'even' : 'odd') : null,
    // Each lens is off by `fraction`; the error accumulates along the sheet.
    driftPx: Math.abs(fraction) * lensCount,
    lensCount,
    pxPerView: views > 0 && Math.abs(perView - Math.round(perView)) < 1e-9 ? perView : null,
  };
}

export interface OutputSize {
  width: number;
  height: number;
}

/** Printed pixel dimensions: width from mm × PPI, height from the frame aspect. */
export function outputSize(settings: LenticularSettings, first: RasterImage): OutputSize {
  const pxPerMm = Math.max(1e-6, settings.ppi) / 25.4;
  const width = Math.max(1, Math.round(Math.max(0.01, settings.widthMm) * pxPerMm));
  const height = Math.max(1, Math.round((width * first.height) / first.width));
  return { width, height };
}

/** Bilinear sample of `img` at normalised coordinates (0–1), edge-clamped. */
function sampleNormalized(img: RasterImage, u: number, v: number, out: Uint8ClampedArray, at: number) {
  const fx = Math.min(img.width - 1, Math.max(0, u * img.width - 0.5));
  const fy = Math.min(img.height - 1, Math.max(0, v * img.height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(img.width - 1, x0 + 1);
  const y1 = Math.min(img.height - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  const i00 = (y0 * img.width + x0) * 4;
  const i10 = (y0 * img.width + x1) * 4;
  const i01 = (y1 * img.width + x0) * 4;
  const i11 = (y1 * img.width + x1) * 4;
  for (let c = 0; c < 4; c++) {
    const top = img.data[i00 + c] * (1 - tx) + img.data[i10 + c] * tx;
    const bottom = img.data[i01 + c] * (1 - tx) + img.data[i11 + c] * tx;
    out[at + c] = top * (1 - ty) + bottom * ty;
  }
}

/** Which setting a calibration sheet sweeps. */
export type CalibrationParam = 'height' | 'ri' | 'lpi';

export interface CalibrationSpec {
  param: CalibrationParam;
  min: number;
  max: number;
  /** Number of bands across the sheet. */
  bands: number;
  /**
   * LPI sweeps only: give every band its own gloss height instead of the one
   * from the settings, so all bands share a viewing angle (see
   * {@link heightForViewAngle}). Without it, a coarse-pitch band can fall below
   * the height it needs to focus at all, and compares a broken lens.
   */
  autoHeight?: boolean;
  /**
   * LPI sweeps only: move every band to the nearest pitch that is a whole
   * number of printed pixels wide.
   *
   * Without it a sweep is not measuring only what it claims to. An evenly
   * spaced run of LPI values lands almost entirely on fractional pitches, and a
   * fractional pitch makes every lenticule in that band slightly different from
   * its neighbour — so a band can read badly because the pitch is wrong, or
   * because the pitch does not fit the raster, and the sheet cannot tell you
   * which. Snapping removes the second cause, and what is left is the lens.
   *
   * Bands that snap onto the same pitch collapse into one, so a snapped sweep
   * can have fewer bands than asked for: there are only so many whole pitches
   * between two LPI values, and printing one of them twice measures nothing.
   */
  snapPpl?: boolean;
  /** The raster {@link snapPpl} snaps against. Without it, snapping is a no-op. */
  ppi?: number;
}

/**
 * The value each band of a calibration sheet is printed at.
 *
 * Evenly spaced across the range, except for a snapped LPI sweep — see
 * {@link CalibrationSpec.snapPpl}, which both moves the values and can return
 * fewer of them than `bands` asked for.
 */
export function calibrationValues(spec: CalibrationSpec): number[] {
  const bands = Math.max(2, Math.round(spec.bands));
  const lo = Math.min(spec.min, spec.max);
  const hi = Math.max(spec.min, spec.max);
  const even = Array.from({ length: bands }, (_, i) => lo + ((hi - lo) * i) / (bands - 1));
  if (spec.param !== 'lpi' || !spec.snapPpl || !spec.ppi || spec.ppi <= 0) return even;

  const seen = new Set<number>();
  const out: number[] = [];
  for (const lpi of even) {
    const ppl = snapPixelsPerLens(spec.ppi / Math.max(1e-6, lpi));
    if (seen.has(ppl)) continue;
    seen.add(ppl);
    out.push(lpiForPixelsPerLens(spec.ppi, ppl));
  }
  return out;
}

/**
 * How many printed pixels each band of a sweep gives one lenticule.
 *
 * The number to write down when you have picked a band off the sheet: it is
 * what you set the print back to, and — snapped — it is a whole number you can
 * read off without a calculator. Empty for the sweeps where pitch is not what
 * is changing.
 */
export function calibrationPixelsPerLens(spec: CalibrationSpec): number[] {
  if (spec.param !== 'lpi' || !spec.ppi || spec.ppi <= 0) return [];
  return calibrationValues(spec).map((lpi) => spec.ppi! / Math.max(1e-6, lpi));
}

/**
 * The gloss height that gives a lens of this pitch the requested viewing cone.
 *
 * The cone comes from the marginal ray leaving the focus for the lens edge,
 * refracted out to air, so it depends only on the ratio (p/2) / H and on n:
 *
 *   sin(θ/2) = n · sin(atan( (p/2) / H ))   ⇒   H = (p/2) · √(1/sin²i − 1)
 *
 * Because it is a *ratio*, H scales linearly with pitch — halve the pitch and
 * you halve the height for the same angle. The feasibility floor
 * n·p / (2(n−1)) scales with pitch too, so an angle reachable at one LPI is
 * reachable at every LPI: an LPI sweep can always be made angle-matched.
 */
export function heightForViewAngle(pitchMm: number, ri: number, viewAngleDeg: number): number {
  const n = Math.max(1.0001, ri);
  const half = pitchMm / 2;
  const sinAir = Math.sin((Math.min(179.9, Math.max(0.1, viewAngleDeg)) / 2) * (Math.PI / 180));
  // Clamped away from 0 (which would demand an infinitely thick stack) and from
  // 1 (a ray along the surface, which no lens delivers).
  const sinInside = Math.min(0.999999, Math.max(1e-6, sinAir / n));
  return half * Math.sqrt(1 / (sinInside * sinInside) - 1);
}

/** Apply one calibration band's value on top of the node's live settings. */
export function withCalibrationValue<T extends LenticularSettings>(
  settings: T,
  spec: CalibrationSpec,
  value: number,
): T {
  if (spec.param === 'height') return { ...settings, heightMm: value };
  if (spec.param === 'ri') return { ...settings, ri: value };
  const lpi = { ...settings, lpi: value };
  if (!spec.autoHeight) return lpi;
  // Match the angle the node's own settings produce, so the sweep isolates
  // pitch: every band views the same cone, only its lens count differs.
  const target = lensGeometry(settings).viewAngleDeg;
  return { ...lpi, heightMm: heightForViewAngle(25.4 / Math.max(1e-6, value), settings.ri, target) };
}

/**
 * Solid frames that read as a hard switch: white, black, white, black across
 * the run, so every adjacent pair is a full-contrast flip.
 *
 * Alternating rather than ramped, and the difference is the whole usefulness of
 * the sheet. A ramp from white to black asks the lens to resolve a *gradient*,
 * and a gradient is what a lens that has failed produces anyway — the two look
 * alike, so a band that is blurring and a band that is working read the same at
 * a glance. Alternating asks the opposite question: it puts the fastest switch
 * the view count allows under the lens, and then any crosstalk between
 * neighbouring views is a mid-grey that was never printed. So the band you want
 * is simply the one that stays black and white as you tilt it, and the ones
 * that have given up are visibly grey. Nothing to interpret.
 *
 * With an odd view count two frames of the same colour have to sit next to each
 * other somewhere; that seam is the one place a tilt does not flip, and it
 * falls where the last view wraps back to the first at the edge of the cone.
 *
 * 1×1 because a lenticular render samples frames normalised.
 */
export function switchFrames(count: number): RasterImage[] {
  const n = Math.max(2, Math.round(count));
  return Array.from({ length: n }, (_, i) => {
    const v = i % 2 === 0 ? 255 : 0;
    return createImage(1, 1, [v, v, v, 255]);
  });
}

/**
 * Is the array turned off the pixel axes? A multiple of 90° isn't: the strips
 * still run straight up or straight across the raster.
 */
const turnedOffAxis = (orientationDeg: number): boolean => Math.abs(orientationDeg % 90) > 1e-9;

/**
 * Do this sheet's strip edges fall between pixels rather than on them?
 *
 * Sampling density is orientation-independent — the pixels are square, so a
 * strip wide enough along x is wide enough at any angle — but *placement* is
 * not. Turn the array and every boundary between two frames becomes a diagonal,
 * and a diagonal is the one thing a raster cannot draw exactly: a pixel
 * straddling one belongs to two frames and gets whichever one its centre lands
 * in, so the edge comes out as a staircase — with steps a whole strip wide on
 * the minimal raster, down to one printed dot at the PPI cap. More pixels are
 * the only cure, up to that cap; see {@link interlacedSize} for why they are
 * offered rather than imposed. {@link gridTilesOffPixelGrid} is the 2D case.
 */
export function stripsOffPixelGrid(settings: LenticularSettings): boolean {
  return turnedOffAxis(settings.orientationDeg);
}

/**
 * Smallest raster that still holds everything the interlaced sheet knows.
 *
 * The interlaced artwork carries no lens geometry — it is flat ink that the
 * printing tool scales onto the sheet — so it has no reason to sit on the
 * printer's PPI raster. Two things bound it from below:
 *
 *   • the interlace itself: `stripSamples` pixels for every frame strip of
 *     every lenticule, so no strip can be skipped by an unlucky phase;
 *   • the artwork: never resample the highest-resolution frame downwards.
 *
 * …and the printer's own raster bounds it from above, because a pixel finer
 * than the press can place is resampled away on the way to the paper having
 * cost memory and render time to make. {@link alignedInterlaceWidth} applies
 * that ceiling, and the alignment, in one step — the two decisions interact,
 * since the whole pitch it rounds to has to be one the press can carry.
 *
 * Diagonal strip edges ({@link stripsOffPixelGrid}) are the one thing more
 * pixels would still buy, since the staircase along them is only as fine as the
 * raster: they are placed to within half a pixel whatever the raster, so it is
 * *strip* accuracy at the minimal size and *printed dot* accuracy at the cap.
 * That is a matter of degree, not of correctness, so it is left as a choice —
 * raise Artwork px per strip and the raster climbs towards the cap — rather
 * than a hidden jump to a raster twenty times the size.
 *
 * The aspect ratio is the first frame's, as everywhere else.
 */
/**
 * Round an artwork width so that every lenticule gets the same whole number of
 * pixels — and, where the press allows, the same whole number per strip.
 *
 * This is the difference between a sheet that flips and a sheet that wipes.
 *
 * The frame a pixel belongs to is `floor(frac(u / pitch) · N)`, so what decides
 * where a strip boundary lands inside a lens is the *pixel offset* of that lens
 * — and if a lenticule is 5.08 px wide, that offset is different for every lens
 * on the sheet. Lens 0 starts on a pixel boundary, lens 1 starts 0.08 px late,
 * lens 12 starts a whole pixel late. Each one therefore rounds its boundary to
 * a different place and so flips at a slightly different angle: tilt the print
 * and the change sweeps across it as a band, one part of the picture switching
 * while the rest has not yet. It looks like a wipe, and it is the single most
 * common reason a home-made lenticular reads as broken.
 *
 * Give every lens a whole number of pixels and that vanishes. Every lenticule
 * covers an identical run of pixel columns, so every strip boundary sits at the
 * same offset under every lens, and the whole sheet changes at once — which is
 * what a lenticular is supposed to do, and what the eye reads as one image
 * becoming another rather than as a curtain being drawn.
 *
 * Two grades of it, since only the first is always affordable:
 *
 *   • Whole pixels per *strip* — the pitch rounded up to a multiple of the
 *     frame count. Every strip is then the same width as well, so no view is
 *     quietly given more of the lens than its neighbours.
 *   • Failing that (it would overrun the press), whole pixels per *lens*: the
 *     strips inside a lens come out uneven — 3, 3, 2, 3, 3, 2 across a 16 px
 *     lens with six views — but identically uneven under every lens, so the
 *     sheet still switches as one.
 *
 * The remaining error is the rounding of the total width, which is under half a
 * pixel across the whole sheet however many lenses it holds.
 */
export function alignedInterlaceWidth(
  target: number,
  lenticules: number,
  strips: number,
  capPx: number,
): number {
  const lenses = Math.max(1e-9, lenticules);
  const widthFor = (perLens: number) => Math.max(1, Math.round(lenses * perLens));
  const n = Math.max(1, Math.round(strips));

  // Best case: round the pitch up to the next whole strip. The nudge before the
  // ceiling is not cosmetic — a 25.4 mm sheet at 12 LPI computes 11.999999999999998
  // lenticules, and without it an exact fit rounds up to the next whole strip
  // and asks for half as many pixels again for nothing at all.
  const equal = Math.max(n, Math.ceil(target / lenses / n - 1e-9) * n);
  if (widthFor(equal) <= capPx) return widthFor(equal);

  // The press is the ceiling, so take the widest whole pitch that fits under
  // it. `round` rather than `floor` because the cap is itself a rounded figure:
  // a 100 mm sheet at 1440 PPI is 5669 px, which is 31.998 lenticules' worth of
  // a 32 px pitch, and flooring that would throw the pitch away over a rounding
  // error in the sheet width.
  let perLens = Math.max(1, Math.round(capPx / lenses));
  while (perLens > 1 && widthFor(perLens) > capPx) perLens--;
  // A lenticule the press cannot give a single pixel to is beyond alignment;
  // the caller's own warnings cover that configuration.
  return widthFor(perLens) <= capPx ? widthFor(perLens) : Math.max(1, Math.round(capPx));
}

export function interlacedSize(settings: LenticularSettings, frames: RasterImage[]): OutputSize {
  const first = frames[0];
  const lenticules = (Math.max(0.01, settings.widthMm) * Math.max(1e-6, settings.lpi)) / 25.4;
  const samples = Math.max(1, settings.stripSamples);
  const forStrips = Math.ceil(lenticules * frames.length * samples);
  const forArtwork = Math.max(...frames.map((f) => f.width));
  const width = alignedInterlaceWidth(
    Math.max(forStrips, forArtwork),
    lenticules,
    frames.length,
    outputSize(settings, first).width,
  );
  return { width, height: Math.max(1, Math.round((width * first.height) / first.width)) };
}

export interface LenticularRender {
  /** Interlaced artwork — its own minimal raster, see {@link interlacedSize}. */
  interlaced: RasterImage;
  /** Lens array as a 16-bit height field; 65535 = `depthScaleMm`. */
  depth: Uint16Array;
  /** Height in mm that a depth value of 65535 represents. */
  depthScaleMm: number;
  /** Depth-map raster — the printer's PPI raster, see {@link outputSize}. */
  depthWidth: number;
  depthHeight: number;
  /** Geometry per band (a single entry for a normal, unbanded render). */
  bands: { value?: number; geometry: LensGeometry }[];
}

export interface RenderOptions {
  /** Sweep a setting across the sheet instead of rendering it flat. */
  calibration?: CalibrationSpec;
  /** Blank separator between calibration bands, millimetres. */
  bandGapMm?: number;
  /**
   * Render the artwork at this exact pixel size instead of deriving it. Lets a
   * companion sheet (e.g. {@link switchFrames}) land on the same raster as the
   * artwork it accompanies, whatever resolution its own frames have.
   */
  interlacedSize?: OutputSize;
  /**
   * Go ahead with a raster over {@link MAX_OUTPUT_PIXELS}. The caller is saying
   * the user has been told how big it is and has agreed to wait; the render
   * still runs in chunks, and {@link MAX_OVERSIZE_PIXELS} still applies.
   */
  allowOversize?: boolean;
  /**
   * Pixels per chunk, overriding {@link CHUNK_PIXELS}. Smaller chunks hand the
   * UI back more often at a little more overhead; tests use it to exercise the
   * chunking without rendering megapixels.
   */
  chunkPixels?: number;
}

interface Band {
  value?: number;
  geometry: LensGeometry;
}

/**
 * Everything about the sheet that is independent of how finely it is rastered.
 * Both passes work in millimetres off this, so the artwork and the depth map
 * describe the same physical print at different resolutions.
 */
interface Sheet {
  widthMm: number;
  heightMm: number;
  cos: number;
  sin: number;
  /** Phase wrapped into 0–1. */
  phase: number;
  bands: Band[];
  /** Lens-parallel coordinate of the sheet's leading corner, mm. */
  vMinMm: number;
  /** Width of one calibration band along that coordinate, mm. */
  bandSpanMm: number;
  gapMm: number;
  depthScaleMm: number;
}

function sheet(frames: RasterImage[], settings: LenticularSettings, options: RenderOptions): Sheet {
  const theta = (settings.orientationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const widthMm = Math.max(0.01, settings.widthMm);
  const heightMm = (widthMm * frames[0].height) / frames[0].width;

  // One geometry per calibration band (or a single one for a flat render).
  const values = options.calibration ? calibrationValues(options.calibration) : [];
  const bands: Band[] = options.calibration
    ? values.map((value) => ({
        value,
        geometry: lensGeometry(withCalibrationValue(settings, options.calibration!, value)),
      }))
    : [{ geometry: lensGeometry(settings) }];

  // Bands are stacked along the lenticule direction (v), so each one still
  // carries whole, uncut lenticules at any orientation.
  const corners = [
    [0, 0],
    [widthMm, 0],
    [0, heightMm],
    [widthMm, heightMm],
  ].map(([x, y]) => -x * sin + y * cos);
  const vMinMm = Math.min(...corners);
  const vSpanMm = Math.max(1e-6, Math.max(...corners) - vMinMm);

  return {
    widthMm,
    heightMm,
    cos,
    sin,
    phase: settings.phase - Math.floor(settings.phase),
    bands,
    vMinMm,
    bandSpanMm: vSpanMm / bands.length,
    gapMm: Math.max(0, options.bandGapMm ?? 0),
    // Depth is normalised against the tallest stack on the sheet, so a Height
    // (or auto-height LPI) calibration keeps every band on one comparable
    // scale — a band that needs a shorter stack simply prints darker.
    depthScaleMm: Math.max(1e-6, ...bands.map((b) => b.geometry.totalMm)),
  };
}

/** The band covering a point, or null inside a between-band gutter. */
function bandAt(s: Sheet, xMm: number, yMm: number): Band | null {
  if (s.bands.length < 2) return s.bands[0];
  const v = -xMm * s.sin + yMm * s.cos - s.vMinMm;
  const slot = Math.min(s.bands.length - 1, Math.max(0, Math.floor(v / s.bandSpanMm)));
  if (s.gapMm > 0 && v - slot * s.bandSpanMm < s.gapMm) return null;
  return s.bands[slot];
}

/**
 * Stop before allocating a raster that is bigger than the caller has agreed to.
 *
 * Under {@link MAX_OUTPUT_PIXELS} this does nothing. Over it the caller is
 * asked: without `options.allowOversize` it throws an {@link OversizeOutputError}
 * carrying everything needed to put the question to a user — how big, how many
 * chunks it would take, and what to change instead. With consent it goes ahead,
 * up to {@link MAX_OVERSIZE_PIXELS}, which nothing gets past.
 */
function checkBudget(
  width: number,
  height: number,
  what: string,
  fix: string,
  options: RenderOptions = {},
): void {
  const pixels = width * height;
  if (pixels <= MAX_OUTPUT_PIXELS) return;
  const mp = (pixels / 1e6).toFixed(pixels < 1e8 ? 1 : 0);
  if (pixels > MAX_OVERSIZE_PIXELS) {
    throw new Error(
      `${what} would be ${width}×${height} px (${mp} MP) — past what a browser can hold at all. ` +
        `${fix} — the ceiling is ${MAX_OVERSIZE_PIXELS / 1e6} MP.`,
    );
  }
  if (options.allowOversize) return;
  throw new OversizeOutputError(
    what,
    width,
    height,
    fix,
    chunkCount(width, height),
    `${what} would be ${width}×${height} px (${mp} MP), over the ${MAX_OUTPUT_PIXELS / 1e6} MP ` +
      `this renders without asking. ${fix} — or run it anyway, in ` +
      `${chunkCount(width, height)} chunks.`,
  );
}

/**
 * Run a row-wise pass in chunks, yielding after each one.
 *
 * The pixel loops below are all the same shape — one pass over the rows of one
 * output raster — and all of them can run long enough to freeze a tab. Driving
 * them a band of rows at a time gives the caller somewhere to stand between
 * chunks: paint a progress bar, notice a cancel, let the event loop breathe.
 * {@link drainSync} is the other caller, for everything that just wants the
 * whole raster and doesn't care.
 */
function* byRows(
  width: number,
  height: number,
  what: string,
  options: RenderOptions,
  pass: (fromY: number, toY: number) => void,
): Generator<ChunkProgress, void> {
  const rows = chunkRows(width, options.chunkPixels);
  const total = chunkCount(width, height, options.chunkPixels);
  for (let chunk = 0; chunk < total; chunk++) {
    const fromY = chunk * rows;
    pass(fromY, Math.min(height, fromY + rows));
    yield { done: chunk + 1, total, what };
  }
}

/**
 * Re-emit another chunked render's progress as part of a bigger job: `base`
 * chunks are already done and `total` are expected overall. Returns whatever
 * the inner generator returned.
 */
function* asPartOf<T>(
  gen: Generator<ChunkProgress, T>,
  base: number,
  total: number,
): Generator<ChunkProgress, T> {
  let step = gen.next();
  while (!step.done) {
    yield { done: base + step.value.done, total, what: step.value.what };
    step = gen.next();
  }
  return step.value;
}

/** Run a chunked render straight through, ignoring the progress. */
export function drainSync<T>(gen: Generator<ChunkProgress, T>): T {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * Render the interlaced artwork.
 *
 * Each pixel is placed by its coordinate `u` across the lenticules (rotated by
 * `orientationDeg`). The fraction of the way through the lenticule picks the
 * frame; the sample point is the *lenticule centre*, not the pixel itself, so
 * every strip of a lenticule shows the same spot of the artwork from its own
 * frame — that squeeze to 1/n of the lenticule width is the interlace.
 */
export function renderInterlaced(
  frames: RasterImage[],
  settings: LenticularSettings,
  options: RenderOptions = {},
): RasterImage {
  return drainSync(interlaceChunks(frames, settings, options));
}

/** {@link renderInterlaced}, a band of rows at a time. */
export function* interlaceChunks(
  frames: RasterImage[],
  settings: LenticularSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, RasterImage> {
  if (frames.length < 2) throw new Error('Lenticular print needs at least 2 images');
  const size = options.interlacedSize ?? interlacedSize(settings, frames);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  checkBudget(
    width,
    height,
    'Interlaced artwork',
    'Reduce Width (mm), LPI or the source resolution',
    options,
  );

  const s = sheet(frames, settings, options);
  const frameCount = frames.length;
  const mmPerPx = s.widthMm / width;
  const out = createImage(width, height, [255, 255, 255, 255]);

  yield* byRows(width, height, 'Interlaced artwork', options, (fromY, toY) => {
    for (let y = fromY; y < toY; y++) {
      const yMm = (y + 0.5) * mmPerPx;
      for (let x = 0; x < width; x++) {
        const xMm = (x + 0.5) * mmPerPx;
        const band = bandAt(s, xMm, yMm);
        if (!band) continue; // gutter between calibration bands stays white

        const u = xMm * s.cos + yMm * s.sin;
        const pitchMm = band.geometry.pitchMm;
        const cell = Math.floor(u / pitchMm + s.phase);
        const t = u / pitchMm + s.phase - cell;

        const frame = Math.min(frameCount - 1, Math.floor(t * frameCount));
        const shift = (cell + 0.5 - s.phase) * pitchMm - u;
        sampleNormalized(
          frames[frame],
          (xMm + shift * s.cos) / s.widthMm,
          (yMm + shift * s.sin) / s.heightMm,
          out.data,
          (y * width + x) * 4,
        );
      }
    }
  });
  return out;
}

export interface DepthMapResult {
  depth: Uint16Array;
  width: number;
  height: number;
  /** Height in mm that a depth value of 65535 represents. */
  scaleMm: number;
  bands: Band[];
}

/**
 * Render the lens array as a 16-bit height field, on the printer's own raster:
 * unlike the artwork this *is* geometry, and its resolution is the resolution
 * of the lenses themselves.
 */
export function renderDepthMap(
  frames: RasterImage[],
  settings: LenticularSettings,
  options: RenderOptions = {},
): DepthMapResult {
  return drainSync(depthMapChunks(frames, settings, options));
}

/** {@link renderDepthMap}, a band of rows at a time. */
export function* depthMapChunks(
  frames: RasterImage[],
  settings: LenticularSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, DepthMapResult> {
  if (frames.length < 2) throw new Error('Lenticular print needs at least 2 images');
  const size = outputSize(settings, frames[0]);
  const { width, height } = size;
  checkBudget(width, height, 'Depth map', 'Reduce Width (mm) or PPI', options);

  const s = sheet(frames, settings, options);
  const mmPerPx = s.widthMm / width;
  const depth = new Uint16Array(width * height);

  yield* byRows(width, height, 'Depth map', options, (fromY, toY) => {
    for (let y = fromY; y < toY; y++) {
      const yMm = (y + 0.5) * mmPerPx;
      for (let x = 0; x < width; x++) {
        const xMm = (x + 0.5) * mmPerPx;
        const band = bandAt(s, xMm, yMm);
        if (!band) continue; // gutter between calibration bands prints no gloss

        const { pitchMm, sagMm, baseMm, radiusMm } = band.geometry;
        const u = xMm * s.cos + yMm * s.sin;
        const t = u / pitchMm + s.phase - Math.floor(u / pitchMm + s.phase);

        // Lens profile: circular arc of radius R and sag `sagMm`, on the base.
        const offset = (t - 0.5) * pitchMm;
        const arc = Math.sqrt(Math.max(0, radiusMm * radiusMm - offset * offset)) - (radiusMm - sagMm);
        const mm = baseMm + Math.max(0, arc);
        depth[y * width + x] = Math.round(Math.min(1, mm / s.depthScaleMm) * 65535);
      }
    }
  });
  return { depth, width, height, scaleMm: s.depthScaleMm, bands: s.bands };
}

/**
 * Both halves of a lenticular print. They deliberately sit on *different*
 * rasters: the artwork on the smallest raster that loses nothing, the lens
 * depth map on the printer's PPI raster that decides how good the lenses are.
 */
export function renderLenticular(
  frames: RasterImage[],
  settings: LenticularSettings,
  options: RenderOptions = {},
): LenticularRender {
  return drainSync(lenticularChunks(frames, settings, options));
}

/** {@link renderLenticular}, chunk by chunk across both halves. */
export function* lenticularChunks(
  frames: RasterImage[],
  settings: LenticularSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, LenticularRender> {
  if (frames.length < 2) throw new Error('Lenticular print needs at least 2 images');
  // Budget both halves before rendering either: a sheet too big for the depth
  // map must stop now, not after a multi-megapixel artwork pass.
  const art = options.interlacedSize ?? interlacedSize(settings, frames);
  const map = outputSize(settings, frames[0]);
  checkBudget(
    art.width,
    art.height,
    'Interlaced artwork',
    'Reduce Width (mm), LPI or the source resolution',
    options,
  );
  checkBudget(map.width, map.height, 'Depth map', 'Reduce Width (mm) or PPI', options);

  // One count across both passes, so the progress bar runs 0→1 over the job the
  // user actually asked for rather than resetting halfway.
  const artChunks = chunkCount(art.width, art.height, options.chunkPixels);
  const total = artChunks + chunkCount(map.width, map.height, options.chunkPixels);
  const interlaced = yield* asPartOf(interlaceChunks(frames, settings, options), 0, total);
  const depth = yield* asPartOf(depthMapChunks(frames, settings, options), artChunks, total);
  return {
    interlaced,
    depth: depth.depth,
    depthScaleMm: depth.scaleMm,
    depthWidth: depth.width,
    depthHeight: depth.height,
    bands: depth.bands,
  };
}

/** 8-bit greyscale view of a 16-bit depth map, for on-canvas preview. */
export function depthPreview(render: LenticularRender): RasterImage {
  const img = createImage(render.depthWidth, render.depthHeight, [0, 0, 0, 255]);
  for (let i = 0; i < render.depth.length; i++) {
    const v = render.depth[i] >>> 8;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
  }
  return img;
}

// ---------------------------------------------------------------------------
// 2D lens grid (integral imaging): rows *and* columns of lenslets, so the print
// carries parallax in both axes and a whole grid of views instead of a strip.
//
// The optics are unchanged. A spherical cap and a cylinder obey the same
// refraction at a surface of radius R, so `lensGeometry` solves this array too:
// same sag, same base, same focus, same viewing cone. Only the footprint
// differs — a round cap inscribed in its cell, leaving the cell's corners flat
// at base height — and how those footprints tile the sheet (see LensPacking).
// ---------------------------------------------------------------------------

/**
 * What any array of spherical caps needs, whichever way the artwork under a cap
 * is divided up. The lens itself is the same object in every case — see
 * {@link renderCapDepthMap} — so only the interlace differs between the square
 * grid of views below and the ring of them further down.
 */
export interface CapArraySettings extends LenticularSettings {
  /** How the lenslets tile the sheet. */
  packing: LensPacking;
  /** 0–1 phase down the second axis, the rows of lenslets. */
  phaseY: number;
}

export interface LensGridSettings extends CapArraySettings {
  /** Lenslets per side of one view grid: 2 = 2×2 (4 views), 3 = 3×3 (9). */
  grid: number;
  /**
   * Place each view opposite the direction it is named for. A lens inverts, so
   * the view you see from the left has to sit on the *right* of its cell; with
   * this off the print is pseudoscopic (parallax runs backwards).
   */
  mirrorViews: boolean;
}

export const MIN_GRID = 2;
/**
 * 15×15 — 225 views. Past this the view tile under a lenslet is thinner than a
 * printed dot at any sane PPI (see the warning in {@link describeGridGeometry}),
 * and the artwork raster and the render time have both grown by N² for parallax
 * the lens can no longer resolve.
 */
export const MAX_GRID = 15;
/** 3×3 — nine views, the smallest grid with a true head-on centre. */
export const DEFAULT_GRID = 3;

export const clampGrid = (grid: number): number =>
  Math.min(MAX_GRID, Math.max(MIN_GRID, Math.round(grid) || MIN_GRID));

/**
 * How the round lenslet footprints tile the sheet.
 *
 * - `square`: rows and columns square-on, each cap inscribed in a square cell.
 * - `hex`: every other row offset half a pitch and the rows pulled √3/2 as far
 *   apart, so each cap touches six neighbours instead of four. This is the
 *   densest packing of equal circles there is.
 */
export type LensPacking = 'square' | 'hex';

/** Row spacing of a hex array, as a fraction of the pitch: √3/2 ≈ 0.866. */
export const HEX_ROW_SPACING = Math.sqrt(3) / 2;

/**
 * Fraction of the sheet that sits under a cap rather than flat at base height.
 * Square leaves the cell corners flat (π/4 ≈ 78.5% covered); hex closes them up
 * to three-cornered slivers (π/2√3 ≈ 90.7%), so ~57% less of the sheet is flat.
 */
export const packingFill = (packing: LensPacking): number =>
  packing === 'hex' ? Math.PI / (2 * Math.sqrt(3)) : Math.PI / 4;

/** Config values arrive as unknowns; anything but an explicit `square` is hex. */
export const clampPacking = (packing: unknown): LensPacking => (packing === 'square' ? 'square' : 'hex');

/** Rows per pitch for a packing — the factor that turns `sv` into row indices. */
const rowScaleOf = (packing: LensPacking): number => (packing === 'hex' ? HEX_ROW_SPACING : 1);

/** One lenslet of the array, located from a point in lens coordinates. */
interface LatticeHit {
  /** The lenslet's centre, in the same `su`/`sv` units as the query. */
  cu: number;
  cv: number;
  /** Offset from that centre, in pitch units on *both* axes. */
  du: number;
  dv: number;
}

/**
 * Which lenslet covers a point, and where within it the point falls. `su`
 * counts pitches across the array; `sv` counts rows down it.
 *
 * A square array is the trivial case: cell ⌊su⌋, ⌊sv⌋, centred half a step in.
 * A hex array offsets odd rows half a pitch, so the covering lenslet is simply
 * whichever centre is nearest — and three candidate rows is always enough,
 * since a centre two rows off is more than a pitch away in v alone.
 *
 * Both offsets come back in pitch units (v scaled by the row spacing), which is
 * what every caller wants: isotropic, so one cap radius and one view-tile size
 * serve either packing.
 */
function latticeAt(su: number, sv: number, packing: LensPacking): LatticeHit {
  if (packing === 'square') {
    const cu = Math.floor(su) + 0.5;
    const cv = Math.floor(sv) + 0.5;
    return { cu, cv, du: su - cu, dv: sv - cv };
  }
  const row0 = Math.floor(sv);
  let cu = 0;
  let cv = 0;
  let du = 0;
  let dv = 0;
  let bestD2 = Infinity;
  for (let row = row0 - 1; row <= row0 + 1; row++) {
    const shift = row & 1 ? 0.5 : 0;
    const centreU = Math.round(su - shift - 0.5) + 0.5 + shift;
    const centreV = row + 0.5;
    const offU = su - centreU;
    const offV = (sv - centreV) * HEX_ROW_SPACING;
    const d2 = offU * offU + offV * offV;
    if (d2 < bestD2) {
      bestD2 = d2;
      cu = centreU;
      cv = centreV;
      du = offU;
      dv = offV;
    }
  }
  return { cu, cv, du, dv };
}

/**
 * Where one row/column of the grid sits relative to the neutral, head-on view:
 * `Left`, `Centre`, `Right` for a 3-wide grid, `Far left … Far right` for 4 or
 * 5, numbered beyond that. Even grids have no centre column.
 */
export function gridAxisLabel(index: number, count: number, axis: 'x' | 'y'): string {
  const offset = index - (count - 1) / 2;
  if (offset === 0) return 'Centre';
  const word = axis === 'x' ? (offset < 0 ? 'Left' : 'Right') : offset < 0 ? 'Up' : 'Down';
  const rank = Math.ceil(Math.abs(offset));
  const maxRank = Math.ceil((count - 1) / 2);
  if (maxRank <= 1) return word;
  if (maxRank === 2) return rank === 1 ? word : `Far ${word.toLowerCase()}`;
  return `${word} ${rank}`;
}

/** Human-readable name of one grid cell, e.g. `Left · Up` or `Centre (neutral)`. */
export function gridCellLabel(col: number, row: number, grid: number): string {
  const x = gridAxisLabel(col, grid, 'x');
  const y = gridAxisLabel(row, grid, 'y');
  if (x === 'Centre' && y === 'Centre') return 'Centre (neutral)';
  if (x === 'Centre') return y;
  if (y === 'Centre') return x;
  return `${x} · ${y}`;
}

/** Stable port id for a grid cell — independent of the label wording. */
export const gridCellId = (col: number, row: number): string => `c${col}r${row}`;

/** Cells in port order: row-major from the top-left (`Left · Up`). */
export function gridCells(grid: number): { col: number; row: number; id: string; label: string }[] {
  const n = clampGrid(grid);
  const cells = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      cells.push({ col, row, id: gridCellId(col, row), label: gridCellLabel(col, row, n) });
    }
  }
  return cells;
}

/**
 * Do this sheet's view tiles run off the pixel grid? The 2D case of
 * {@link stripsOffPixelGrid}, with one extra way to get there.
 *
 * A square array at 0° (or any multiple of 90°) tiles the artwork in rectangles
 * whose edges are horizontal and vertical, so the raster of
 * {@link gridInterlacedSize} places every edge exactly, however small it is.
 * Stagger the rows for hex packing, or turn the array off the axes, and the tile
 * edges go diagonal — placed to half a pixel, which is a fraction of a view tile
 * on a small raster and a fraction of a printed dot at the PPI cap. Reported, so
 * the choice of raster is an informed one.
 */
export function gridTilesOffPixelGrid(settings: LensGridSettings): boolean {
  return clampPacking(settings.packing) === 'hex' || stripsOffPixelGrid(settings);
}

/**
 * {@link interlacedSize} for a grid: every cell needs `grid` views across, and
 * the printer's PPI raster is the ceiling here too.
 *
 * A grid reaches that ceiling far sooner than a 1D sheet — `grid` tiles across
 * a cell instead of `frames` strips, and hex packing needs another 1/0.866 on
 * top — so a big grid ships at the cap and a small one does not, which is
 * exactly the intent: pay for pixels the press can print, and no more.
 *
 * Diagonal tile edges ({@link gridTilesOffPixelGrid}) — every hex sheet, and any
 * turned array — are placed to half a pixel whatever the raster, so they are
 * worth spending towards the cap on but are not a reason to jump to it. See
 * {@link interlacedSize}.
 */
export function gridInterlacedSize(settings: LensGridSettings, views: RasterImage[]): OutputSize {
  const first = views[0];
  const cells = (Math.max(0.01, settings.widthMm) * Math.max(1e-6, settings.lpi)) / 25.4;
  const samples = Math.max(1, settings.stripSamples);
  // Hex rows sit √3/2 as far apart, so a raster giving `stripSamples` px across
  // a view tile gives fewer *down* it. Scale up so the floor holds both ways.
  const forViews = Math.ceil(
    (cells * clampGrid(settings.grid) * samples) / rowScaleOf(clampPacking(settings.packing)),
  );
  const forArtwork = Math.max(...views.map((v) => v.width));
  // Whole pixels per cell across, and a whole number per tile column where the
  // press allows — so every cell divides into views at the same offsets and the
  // sheet switches as one. See {@link alignedInterlaceWidth}, and the note on
  // hex rows below.
  const width = alignedInterlaceWidth(
    Math.max(forViews, forArtwork),
    cells,
    clampGrid(settings.grid),
    outputSize(settings, first).width,
  );
  return { width, height: Math.max(1, Math.round((width * first.height) / first.width)) };
}

/**
 * Can this packing put whole pixels between rows as well as between columns?
 *
 * Square can: the row pitch *is* the column pitch, and the raster keeps the
 * sheet's aspect, so aligning across aligns down for free.
 *
 * Hex cannot, and not for want of trying — its rows sit √3/2 of a pitch apart,
 * and √3/2 is irrational, so no whole column pitch has a whole row pitch. A hex
 * sheet is therefore aligned across and drifting down: tilt it left and right
 * and it switches as one, tilt it up and down and the change sweeps through the
 * rows. That is the price of the 15% more lenslets hex buys, it is exact rather
 * than a matter of degree, and Square packing is the way out of it.
 */
export const packingAlignsRows = (packing: LensPacking): boolean => rowScaleOf(packing) === 1;

function requireGridViews(views: RasterImage[], grid: number): number {
  const n = clampGrid(grid);
  if (views.length !== n * n) {
    throw new Error(`A ${n}×${n} lens grid needs ${n * n} images (got ${views.length}).`);
  }
  return n;
}

/**
 * Interlace a grid of views under a 2D lens array. Same idea as the 1D
 * interlace, run on both axes at once: the position within the cell picks a
 * column *and* a row of the view grid, and the sample point is the cell centre
 * so every one of the grid² tiles under a lenslet shows the same spot.
 *
 * Views arrive in {@link gridCells} order (row-major from `Left · Up`).
 */
export function renderGridInterlaced(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): RasterImage {
  return drainSync(gridInterlaceChunks(views, settings, options));
}

/** {@link renderGridInterlaced}, a band of rows at a time. */
export function* gridInterlaceChunks(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, RasterImage> {
  const grid = requireGridViews(views, settings.grid);
  const size = options.interlacedSize ?? gridInterlacedSize(settings, views);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  checkBudget(
    width,
    height,
    'Interlaced artwork',
    'Reduce Width (mm), PPI, LPI, the grid or the source size',
    options,
  );

  const s = sheet(views, settings, options);
  const packing = clampPacking(settings.packing);
  const rowScale = rowScaleOf(packing);
  const phaseY = settings.phaseY - Math.floor(settings.phaseY);
  const mmPerPx = s.widthMm / width;
  const out = createImage(width, height, [255, 255, 255, 255]);

  yield* byRows(width, height, 'Interlaced artwork', options, (fromY, toY) => {
    for (let y = fromY; y < toY; y++) {
      const yMm = (y + 0.5) * mmPerPx;
      for (let x = 0; x < width; x++) {
        const xMm = (x + 0.5) * mmPerPx;
        const band = bandAt(s, xMm, yMm);
        if (!band) continue;

        const pitchMm = band.geometry.pitchMm;
        const u = xMm * s.cos + yMm * s.sin;
        const v = -xMm * s.sin + yMm * s.cos;
        const su = u / pitchMm + s.phase;
        const sv = v / (pitchMm * rowScale) + phaseY;
        const cell = latticeAt(su, sv, packing);

        // Tiles are square in millimetres on both axes, so a view subtends the
        // same angle horizontally and vertically. A hex cell reaches past a
        // pitch at its two tips, which clamp into the outermost tiles.
        const fu = Math.min(0.999999, Math.max(0, cell.du + 0.5));
        const fv = Math.min(0.999999, Math.max(0, cell.dv + 0.5));
        const col = Math.floor(fu * grid);
        const row = Math.floor(fv * grid);

        // The lens inverts: the tile on the left of a cell is what an eye to the
        // *right* sees, so a view named "Left" belongs on the right.
        const viewCol = settings.mirrorViews ? grid - 1 - col : col;
        const viewRow = settings.mirrorViews ? grid - 1 - row : row;

        // Sample at the cell centre, rotated back into sheet coordinates.
        const uc = (cell.cu - s.phase) * pitchMm;
        const vc = (cell.cv - phaseY) * pitchMm * rowScale;
        sampleNormalized(
          views[viewRow * grid + viewCol],
          (uc * s.cos - vc * s.sin) / s.widthMm,
          (uc * s.sin + vc * s.cos) / s.heightMm,
          out.data,
          (y * width + x) * 4,
        );
      }
    }
  });
  return out;
}

/**
 * The lens array as a 16-bit height field: one spherical cap per lenslet, of
 * diameter one pitch, so caps touch and whatever the packing leaves over — the
 * square array's corners, the hex array's slivers — stays flat at base height.
 */
export function renderGridDepthMap(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): DepthMapResult {
  return drainSync(gridDepthMapChunks(views, settings, options));
}

/** {@link renderGridDepthMap}, a band of rows at a time. */
export function* gridDepthMapChunks(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, DepthMapResult> {
  requireGridViews(views, settings.grid);
  return yield* capDepthMapChunks(views, settings, options);
}

/**
 * The cap array itself, independent of how the artwork beneath it is divided.
 * A square grid of view tiles and a ring of wedges print the *same lens*; only
 * their interlaces differ.
 */
export function renderCapDepthMap(
  views: RasterImage[],
  settings: CapArraySettings,
  options: RenderOptions = {},
): DepthMapResult {
  return drainSync(capDepthMapChunks(views, settings, options));
}

/** {@link renderCapDepthMap}, a band of rows at a time. */
export function* capDepthMapChunks(
  views: RasterImage[],
  settings: CapArraySettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, DepthMapResult> {
  const size = outputSize(settings, views[0]);
  const { width, height } = size;
  checkBudget(width, height, 'Depth map', 'Reduce Width (mm) or PPI', options);

  const s = sheet(views, settings, options);
  const packing = clampPacking(settings.packing);
  const rowScale = rowScaleOf(packing);
  const phaseY = settings.phaseY - Math.floor(settings.phaseY);
  const mmPerPx = s.widthMm / width;
  const depth = new Uint16Array(width * height);

  yield* byRows(width, height, 'Depth map', options, (fromY, toY) => {
    for (let y = fromY; y < toY; y++) {
      const yMm = (y + 0.5) * mmPerPx;
      for (let x = 0; x < width; x++) {
        const xMm = (x + 0.5) * mmPerPx;
        const band = bandAt(s, xMm, yMm);
        if (!band) continue;

        const { pitchMm, sagMm, baseMm, radiusMm } = band.geometry;
        const u = xMm * s.cos + yMm * s.sin;
        const v = -xMm * s.sin + yMm * s.cos;
        const su = u / pitchMm + s.phase;
        const sv = v / (pitchMm * rowScale) + phaseY;
        const cell = latticeAt(su, sv, packing);
        const du = cell.du * pitchMm;
        const dv = cell.dv * pitchMm;

        // A cap of diameter one pitch around the nearest centre; outside it,
        // flat base. In a hex array that circle touches all six neighbours.
        const r = Math.hypot(du, dv);
        const arc =
          r <= pitchMm / 2 ? Math.sqrt(Math.max(0, radiusMm * radiusMm - r * r)) - (radiusMm - sagMm) : 0;
        const mm = baseMm + Math.max(0, arc);
        depth[y * width + x] = Math.round(Math.min(1, mm / s.depthScaleMm) * 65535);
      }
    }
  });
  return { depth, width, height, scaleMm: s.depthScaleMm, bands: s.bands };
}

/** Both halves of a 2D lens-grid print. See {@link renderLenticular}. */
export function renderLensGrid(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): LenticularRender {
  return drainSync(lensGridChunks(views, settings, options));
}

/** {@link renderLensGrid}, chunk by chunk across both halves. */
export function* lensGridChunks(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, LenticularRender> {
  const grid = requireGridViews(views, settings.grid);
  const art = options.interlacedSize ?? gridInterlacedSize(settings, views);
  const map = outputSize(settings, views[0]);
  checkBudget(
    art.width,
    art.height,
    'Interlaced artwork',
    'Reduce Width (mm), PPI, LPI, the grid or the source size',
    options,
  );
  checkBudget(map.width, map.height, 'Depth map', 'Reduce Width (mm) or PPI', options);

  const artChunks = chunkCount(art.width, art.height, options.chunkPixels);
  const total = artChunks + chunkCount(map.width, map.height, options.chunkPixels);
  const interlaced = yield* asPartOf(gridInterlaceChunks(views, { ...settings, grid }, options), 0, total);
  const depth = yield* asPartOf(gridDepthMapChunks(views, { ...settings, grid }, options), artChunks, total);
  return {
    interlaced,
    depth: depth.depth,
    depthScaleMm: depth.scaleMm,
    depthWidth: depth.width,
    depthHeight: depth.height,
    bands: depth.bands,
  };
}

/**
 * Switch target for a grid: a checkerboard of views, so a tilt along *either*
 * axis flips the sheet. The neutral centre view is white.
 */
export function gridSwitchViews(grid: number): RasterImage[] {
  return gridCells(grid).map(({ col, row }) => {
    const v = (col + row) % 2 === 0 ? 255 : 0;
    return createImage(1, 1, [v, v, v, 255]);
  });
}

// ---------------------------------------------------------------------------
// Radial array: the same lens, the same caps, but the artwork under each cap is
// cut into angular wedges instead of a square grid of tiles.
//
// The whole behaviour follows from where the wedges meet. Under a cap, the
// position within the cell *is* the direction you are looking from: offset from
// the centre picks the view, and the centre itself is head-on. Cut the cell into
// N wedges and every one of them touches that centre point, so:
//
//   • Head-on, the eye sits on the meeting point of all N wedges and the lens
//     blur averages across them — every view at once, superimposed. The images
//     merge, which is the effect being bought.
//   • Tilt in any direction and the sample slides into one wedge, so the view
//     that owns that azimuth takes over the whole sheet. Turning around the
//     print walks through the views in order.
//   • A wedge runs from the centre to the rim, so a view has no "distance": it
//     is whatever you see at that bearing, at any tilt from a whisker off
//     head-on to the edge of the cone.
//
// A view therefore occupies a *bearing*, not a cell — which is why this exists
// alongside the grid rather than as a setting on it.
// ---------------------------------------------------------------------------

export interface RadialSettings extends CapArraySettings {
  /** How many views are spread around the circle. */
  views: number;
  /**
   * Turn the whole wedge pattern, 0–1 of a full view step. Moves where the
   * seams between views fall without renaming any of them.
   */
  spin: number;
  /**
   * Place each view opposite the bearing it is named for. A lens inverts, so
   * the view you see from the right has to sit on the *left* of its cell; with
   * this off the print runs backwards as you walk around it.
   */
  mirrorViews: boolean;
}

export const MIN_RADIAL_VIEWS = 2;
export const MAX_RADIAL_VIEWS = 12;
/** Six around the circle — every 60°, and still ~1 pixel of wedge to print. */
export const DEFAULT_RADIAL_VIEWS = 6;

export const clampRadialViews = (views: number): number =>
  Math.min(MAX_RADIAL_VIEWS, Math.max(MIN_RADIAL_VIEWS, Math.round(views) || MIN_RADIAL_VIEWS));

/** The eight bearings that have a name; anything else is quoted in degrees. */
const BEARINGS = ['Right', 'Up-right', 'Up', 'Up-left', 'Left', 'Down-left', 'Down', 'Down-right'];

/** The bearing a view is seen from, degrees anticlockwise from "to the right". */
export const radialViewAngleDeg = (index: number, count: number): number =>
  (index * 360) / Math.max(1, clampRadialViews(count));

/**
 * Human name of one view: its bearing in degrees, plus a direction word when it
 * lands exactly on one of the eight compass points. Five views around a circle
 * simply have no word for 72°, and inventing one would misdirect.
 */
export function radialViewLabel(index: number, count: number): string {
  const deg = radialViewAngleDeg(index, count);
  const eighth = deg / 45;
  const rounded = Math.round(deg * 10) / 10;
  return Number.isInteger(eighth) ? `${rounded}° · ${BEARINGS[eighth % 8]}` : `${rounded}°`;
}

/** Stable port id for a view — independent of the label wording. */
export const radialViewId = (index: number): string => `a${index}`;

/** Views in port order: bearing 0° (to the right) and anticlockwise from there. */
export function radialViews(count: number): { index: number; id: string; label: string; angleDeg: number }[] {
  const n = clampRadialViews(count);
  return Array.from({ length: n }, (_, index) => ({
    index,
    id: radialViewId(index),
    label: radialViewLabel(index, n),
    angleDeg: radialViewAngleDeg(index, n),
  }));
}

function requireRadialViews(views: RasterImage[], count: number): number {
  const n = clampRadialViews(count);
  if (views.length !== n) {
    throw new Error(`A ${n}-view radial array needs ${n} images (got ${views.length}).`);
  }
  return n;
}

/**
 * {@link gridInterlacedSize} for a ring of wedges.
 *
 * Sized like the others: enough pixels for the wedges and the sources, capped at
 * the printer's own raster.
 *
 * A wedge boundary is a *radial line*, so unlike a 1D sheet's strips or a
 * square grid's tile edges there is no orientation at which they run along the
 * pixels — every radial sheet is a diagonal one, and every pixel of artwork up
 * to the cap buys a straighter seam. They also converge: near the centre of a
 * cell the wedges are finer than any raster can hold, which is exactly why the
 * views merge there, so it is the rim that the floor below is measured at.
 *
 * That makes the PPI cap worth more here than anywhere else, and reaching for
 * it is one setting away (Artwork px per wedge) — but it is still the caller's
 * call, not a silent twentyfold jump in the size of the file.
 */
export function radialInterlacedSize(settings: RadialSettings, views: RasterImage[]): OutputSize {
  const first = views[0];
  const cells = (Math.max(0.01, settings.widthMm) * Math.max(1e-6, settings.lpi)) / 25.4;
  const samples = Math.max(1, settings.stripSamples);
  // Enough pixels that a wedge is `stripSamples` wide where it is widest — at
  // the rim, where it subtends (π/N) of a cell diameter.
  const forWedges = Math.ceil((cells * clampRadialViews(settings.views) * samples) / Math.PI);
  const forArtwork = Math.max(...views.map((v) => v.width));
  // Whole pixels per cell, so every cap divides into wedges identically and the
  // whole sheet turns at once. No per-wedge divisor, unlike the other two: a
  // wedge is an angle, not a column, so there is no horizontal count that would
  // make them equal — the cell pitch is the only thing to align.
  const width = alignedInterlaceWidth(
    Math.max(forWedges, forArtwork),
    cells,
    1,
    outputSize(settings, first).width,
  );
  return { width, height: Math.max(1, Math.round((width * first.height) / first.width)) };
}

/**
 * Which view owns a point inside a cell: the bearing of its offset from the
 * cell centre, in sheet coordinates, cut into `n` equal wedges.
 *
 * Each wedge is *centred* on the bearing its view is named for, so the view
 * called 0° is the one you see from dead level with the right-hand edge, and
 * the seams fall halfway between two names. Starting the wedge at its own
 * bearing instead would make every label off by half a step.
 *
 * `du`/`dv` are the offset in the array's own axes; the array's orientation is
 * undone here so that a view named 0° is seen from the right of the *print*
 * however the lenslets are turned. Sheet y runs down the raster, so it is
 * negated to make "up" mean up.
 */
export function radialViewAt(
  du: number,
  dv: number,
  n: number,
  settings: { orientationDeg: number; spin: number; mirrorViews: boolean },
): number {
  const theta = (settings.orientationDeg * Math.PI) / 180;
  const dx = du * Math.cos(theta) - dv * Math.sin(theta);
  const dy = du * Math.sin(theta) + dv * Math.cos(theta);
  // Bearing of the *tile*; the eye that sees it is opposite, because the lens
  // inverts — so a mirrored array adds half a turn.
  let turns = Math.atan2(-dy, dx) / (2 * Math.PI);
  if (settings.mirrorViews) turns += 0.5;
  // Half a step, so each wedge straddles its own bearing rather than starting
  // at it; then the spin, which slides every seam together.
  turns += (0.5 + settings.spin) / n;
  turns -= Math.floor(turns);
  return Math.min(n - 1, Math.floor(turns * n));
}

/**
 * Interlace a ring of views under the cap array: the bearing within a cell
 * picks the view, so every view meets every other at the cell centre.
 *
 * Views arrive in {@link radialViews} order — bearing 0° first, anticlockwise.
 */
export function renderRadialInterlaced(
  views: RasterImage[],
  settings: RadialSettings,
  options: RenderOptions = {},
): RasterImage {
  return drainSync(radialInterlaceChunks(views, settings, options));
}

/** {@link renderRadialInterlaced}, a band of rows at a time. */
export function* radialInterlaceChunks(
  views: RasterImage[],
  settings: RadialSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, RasterImage> {
  const n = requireRadialViews(views, settings.views);
  const size = options.interlacedSize ?? radialInterlacedSize(settings, views);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  checkBudget(width, height, 'Interlaced artwork', 'Reduce Width (mm), PPI, LPI or the source size', options);

  const s = sheet(views, settings, options);
  const packing = clampPacking(settings.packing);
  const rowScale = packing === 'hex' ? HEX_ROW_SPACING : 1;
  const phaseY = settings.phaseY - Math.floor(settings.phaseY);
  const mmPerPx = s.widthMm / width;
  const out = createImage(width, height, [255, 255, 255, 255]);

  yield* byRows(width, height, 'Interlaced artwork', options, (fromY, toY) => {
    for (let y = fromY; y < toY; y++) {
      const yMm = (y + 0.5) * mmPerPx;
      for (let x = 0; x < width; x++) {
        const xMm = (x + 0.5) * mmPerPx;
        const band = bandAt(s, xMm, yMm);
        if (!band) continue;

        const pitchMm = band.geometry.pitchMm;
        const u = xMm * s.cos + yMm * s.sin;
        const v = -xMm * s.sin + yMm * s.cos;
        const su = u / pitchMm + s.phase;
        const sv = v / (pitchMm * rowScale) + phaseY;
        const cell = latticeAt(su, sv, packing);
        const view = radialViewAt(cell.du, cell.dv, n, settings);

        // Sample at the cell centre, as the grid does: every wedge of a cell
        // shows the same spot of the picture, from its own view.
        const uc = (cell.cu - s.phase) * pitchMm;
        const vc = (cell.cv - phaseY) * pitchMm * rowScale;
        sampleNormalized(
          views[view],
          (uc * s.cos - vc * s.sin) / s.widthMm,
          (uc * s.sin + vc * s.cos) / s.heightMm,
          out.data,
          (y * width + x) * 4,
        );
      }
    }
  });
  return out;
}

/** The lens array for a radial print — the same caps the grid prints. */
export function renderRadialDepthMap(
  views: RasterImage[],
  settings: RadialSettings,
  options: RenderOptions = {},
): DepthMapResult {
  return drainSync(radialDepthMapChunks(views, settings, options));
}

/** {@link renderRadialDepthMap}, a band of rows at a time. */
export function* radialDepthMapChunks(
  views: RasterImage[],
  settings: RadialSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, DepthMapResult> {
  requireRadialViews(views, settings.views);
  return yield* capDepthMapChunks(views, settings, options);
}

/** Both halves of a radial print. See {@link renderLenticular}. */
export function renderRadial(
  views: RasterImage[],
  settings: RadialSettings,
  options: RenderOptions = {},
): LenticularRender {
  return drainSync(radialChunks(views, settings, options));
}

/** {@link renderRadial}, chunk by chunk across both halves. */
export function* radialChunks(
  views: RasterImage[],
  settings: RadialSettings,
  options: RenderOptions = {},
): Generator<ChunkProgress, LenticularRender> {
  requireRadialViews(views, settings.views);
  const art = options.interlacedSize ?? radialInterlacedSize(settings, views);
  const map = outputSize(settings, views[0]);
  checkBudget(
    art.width,
    art.height,
    'Interlaced artwork',
    'Reduce Width (mm), PPI, LPI or the source size',
    options,
  );
  checkBudget(map.width, map.height, 'Depth map', 'Reduce Width (mm) or PPI', options);

  const artChunks = chunkCount(art.width, art.height, options.chunkPixels);
  const total = artChunks + chunkCount(map.width, map.height, options.chunkPixels);
  const interlaced = yield* asPartOf(radialInterlaceChunks(views, settings, options), 0, total);
  const depth = yield* asPartOf(radialDepthMapChunks(views, settings, options), artChunks, total);
  return {
    interlaced,
    depth: depth.depth,
    depthScaleMm: depth.scaleMm,
    depthWidth: depth.width,
    depthHeight: depth.height,
    bands: depth.bands,
  };
}

/**
 * Switch target for a radial print: the views alternate white and black around
 * the circle, so walking around the sheet flashes it. An odd view count has to
 * put two of one colour next to each other somewhere — that seam is the one
 * place the flip does not happen, and it is where 0° meets the last view.
 */
export function radialSwitchViews(count: number): RasterImage[] {
  const n = clampRadialViews(count);
  return Array.from({ length: n }, (_, i) => {
    const v = i % 2 === 0 ? 255 : 0;
    return createImage(1, 1, [v, v, v, 255]);
  });
}

/** Fewer pixels than this across a lenticule and the lens profile is terraced. */
const MIN_LENS_PX = 8;

/**
 * The line that explains which raster the artwork landed on.
 *
 * The printer's raster is a ceiling rather than a destination, so the question
 * is no longer "minimal or PPI" but "did this reach the cap, and if not, would
 * more pixels still buy anything". Diagonal edges are the only thing that would
 * — hence `diagonal`, which names them and the setting that pays for them.
 */
function describeArtRaster(
  ppi: number,
  artSize: OutputSize,
  ppiSize: OutputSize,
  diagonal: { edges: string; setting: string } | null,
): string {
  if (artSize.width >= ppiSize.width) {
    return (
      `Artwork at the ${ppi} PPI cap: ${artSize.width} px is every dot the press can place` +
      (diagonal ? `, so the diagonal ${diagonal.edges} come out to within one printed dot` : '')
    );
  }
  return (
    `Artwork on the minimal raster: ${artSize.width} px of the ${ppiSize.width} px the press could ` +
    `print — all the interlace and your sources need` +
    (diagonal
      ? `. The ${diagonal.edges} run diagonally, so they are placed to half a pixel *of this raster*; ` +
        `raise ${diagonal.setting} to spend up to the cap if the staircase shows`
      : `, and the edges land on whole pixels`)
  );
}

/** Human-readable geometry report for the node's Info output and its editor. */
export function describeGeometry(
  settings: LenticularSettings,
  geometry: LensGeometry,
  frameCount: number,
  depthSize: OutputSize,
  artSize: OutputSize,
): string {
  const mm = (v: number) => v.toFixed(3);
  const lines = [
    `${frameCount} frames · ${settings.widthMm} mm wide`,
    `Depth map ${depthSize.width}×${depthSize.height} px @ ${settings.ppi} PPI · ` +
      `artwork ${artSize.width}×${artSize.height} px (scale to fit at print time)`,
    describeArtRaster(
      settings.ppi,
      artSize,
      depthSize,
      stripsOffPixelGrid(settings) ? { edges: 'strip edges', setting: 'Artwork px per strip' } : null,
    ),
    `Lenticule pitch ${mm(geometry.pitchMm)} mm — ${geometry.pitchPx.toFixed(2)} px of lens profile, ` +
      `${(artSize.width / ((settings.widthMm * settings.lpi) / 25.4) / frameCount).toFixed(2)} px per frame strip`,
    `Lens sag ${mm(geometry.sagMm)} mm on a ${mm(geometry.baseMm)} mm base = ${mm(geometry.totalMm)} mm total`,
    `Radius ${mm(geometry.radiusMm)} mm · focus ${mm(geometry.focusMm)} mm below apex · viewing angle ${geometry.viewAngleDeg.toFixed(1)}°`,
  ];
  if (!geometry.feasible) {
    lines.push(
      `⚠ At ${settings.lpi} LPI / RI ${settings.ri} the lens cannot focus in ${mm(settings.heightMm)} mm — ` +
        `it focuses ${mm(geometry.focusMm)} mm down. Raise Height to ${mm(geometry.minHeightMm)} mm or raise LPI.`,
    );
  }
  if (geometry.pitchPx < MIN_LENS_PX) {
    lines.push(
      `⚠ Only ${geometry.pitchPx.toFixed(2)} px across a lenticule — the printed lens will be terraced. ` +
        `Raise PPI or lower LPI.`,
    );
  }
  return lines.join('\n');
}

/** Cells across and down the sheet — one lenslet each, one pixel per view. */
export function gridCellCounts(settings: LensGridSettings, first: RasterImage): OutputSize {
  const across = (Math.max(0.01, settings.widthMm) * Math.max(1e-6, settings.lpi)) / 25.4;
  // Hex rows are closer together than the pitch, so a hex sheet fits ~15% more
  // rows of lenslets — the packing gain, spent on vertical resolution.
  const rowScale = rowScaleOf(clampPacking(settings.packing));
  return {
    width: Math.max(1, Math.round(across)),
    height: Math.max(1, Math.round((across * first.height) / (first.width * rowScale))),
  };
}

/** {@link describeGeometry} for the radial node. */
export function describeRadialGeometry(
  settings: RadialSettings,
  geometry: LensGeometry,
  depthSize: OutputSize,
  artSize: OutputSize,
  cells: OutputSize,
): string {
  const mm = (v: number) => v.toFixed(3);
  const n = clampRadialViews(settings.views);
  const packing = clampPacking(settings.packing);
  const stepDeg = 360 / n;
  // Half the cone is as far off-axis as you can get before the next view; the
  // wedge owns a bearing, so what it spans is an angle *around* the print.
  const lines = [
    `${n} views around the circle, one every ${stepDeg.toFixed(1)}° of bearing · ${settings.widthMm} mm wide`,
    `Head-on all ${n} merge: every wedge meets at the centre of its lenslet, so the eye averages the ` +
      `whole set. Tilt in any direction and the view owning that bearing takes the sheet`,
    `${packing === 'hex' ? 'Hexagonal' : 'Square'} lenslet packing — ` +
      `${(packingFill(packing) * 100).toFixed(1)}% of the sheet under a cap` +
      (packingAlignsRows(packing)
        ? '; its rows sit a whole pitch apart, so the artwork lands on whole pixels down the sheet as ' +
          'well as across and the whole print switches at once in both axes'
        : '; its rows sit √3/2 of a pitch apart, and √3/2 is irrational — so no raster can put whole ' +
          'pixels between rows as well as between columns. Tilting left and right switches the sheet ' +
          'as one; tilting up and down sweeps the change through the rows. Square packing is the way ' +
          'out of that, at 15% fewer lenslets'),
    `Depth map ${depthSize.width}×${depthSize.height} px @ ${settings.ppi} PPI · ` +
      `artwork ${artSize.width}×${artSize.height} px (scale to fit at print time)`,
    describeArtRaster(settings.ppi, artSize, depthSize, {
      edges: 'wedge seams',
      setting: 'Artwork px per wedge',
    }),
    `Lenslet pitch ${mm(geometry.pitchMm)} mm — ${geometry.pitchPx.toFixed(2)} px of lens profile, ` +
      `${((artSize.width / ((settings.widthMm * settings.lpi) / 25.4)) * (Math.PI / n)).toFixed(2)} px ` +
      `across a wedge at the rim`,
    `Each view resolves to ${cells.width}×${cells.height} px (one per lenslet)`,
    `Lens sag ${mm(geometry.sagMm)} mm on a ${mm(geometry.baseMm)} mm base = ${mm(geometry.totalMm)} mm total`,
    `Radius ${mm(geometry.radiusMm)} mm · focus ${mm(geometry.focusMm)} mm below apex · ` +
      `viewing cone ${geometry.viewAngleDeg.toFixed(1)}° — a view holds from just off head-on to the edge ` +
      `of that cone, at its own bearing`,
  ];
  if (!geometry.feasible) {
    lines.push(
      `⚠ At ${settings.lpi} LPI / RI ${settings.ri} the lens cannot focus in ${mm(settings.heightMm)} mm — ` +
        `it focuses ${mm(geometry.focusMm)} mm down. Raise Height to ${mm(geometry.minHeightMm)} mm or raise LPI.`,
    );
  }
  if (geometry.pitchPx < MIN_LENS_PX) {
    lines.push(
      `⚠ Only ${geometry.pitchPx.toFixed(2)} px across a lenslet — the printed lens will be terraced. ` +
        `Raise PPI or lower LPI.`,
    );
  }
  // A wedge narrower than a printed dot at the rim cannot be printed at all.
  const wedgeRimPx = (geometry.pitchPx * Math.PI) / n;
  if (wedgeRimPx < 2) {
    lines.push(
      `⚠ A wedge is only ${wedgeRimPx.toFixed(2)} px across even at the rim of a lenslet — the views will ` +
        `blur into each other everywhere, not just head-on. Use fewer views, lower LPI, or raise PPI.`,
    );
  }
  return lines.join('\n');
}

/** {@link describeGeometry} for the 2D grid node. */
export function describeGridGeometry(
  settings: LensGridSettings,
  geometry: LensGeometry,
  depthSize: OutputSize,
  artSize: OutputSize,
  cells: OutputSize,
): string {
  const mm = (v: number) => v.toFixed(3);
  const grid = clampGrid(settings.grid);
  const packing = clampPacking(settings.packing);
  const lines = [
    `${grid}×${grid} grid = ${grid * grid} views · ${settings.widthMm} mm wide`,
    `${packing === 'hex' ? 'Hexagonal' : 'Square'} lenslet packing — ` +
      `${(packingFill(packing) * 100).toFixed(1)}% of the sheet under a cap` +
      (packingAlignsRows(packing)
        ? '; its rows sit a whole pitch apart, so the artwork lands on whole pixels down the sheet as ' +
          'well as across and the whole print switches at once in both axes'
        : '; its rows sit √3/2 of a pitch apart, and √3/2 is irrational — so no raster can put whole ' +
          'pixels between rows as well as between columns. Tilting left and right switches the sheet ' +
          'as one; tilting up and down sweeps the change through the rows. Square packing is the way ' +
          'out of that, at 15% fewer lenslets'),
    `Depth map ${depthSize.width}×${depthSize.height} px @ ${settings.ppi} PPI · ` +
      `artwork ${artSize.width}×${artSize.height} px (scale to fit at print time)`,
    describeArtRaster(
      settings.ppi,
      artSize,
      depthSize,
      gridTilesOffPixelGrid(settings)
        ? {
            edges: packing === 'hex' ? 'staggered view-tile edges' : 'view-tile edges',
            setting: 'Artwork px per view tile',
          }
        : null,
    ),
    `Lenslet pitch ${mm(geometry.pitchMm)} mm — ${geometry.pitchPx.toFixed(2)} px of lens profile, ` +
      `${(artSize.width / ((settings.widthMm * settings.lpi) / 25.4) / grid).toFixed(2)} px per view tile`,
    // The lens count *is* the per-view resolution: one lenslet shows one pixel
    // of each view, so this is what the viewer actually sees.
    `Each view resolves to ${cells.width}×${cells.height} px (one per lenslet)`,
    `Lens sag ${mm(geometry.sagMm)} mm on a ${mm(geometry.baseMm)} mm base = ${mm(geometry.totalMm)} mm total`,
    `Radius ${mm(geometry.radiusMm)} mm · focus ${mm(geometry.focusMm)} mm below apex · viewing angle ${geometry.viewAngleDeg.toFixed(1)}°`,
  ];
  if (!geometry.feasible) {
    lines.push(
      `⚠ At ${settings.lpi} LPI / RI ${settings.ri} the lens cannot focus in ${mm(settings.heightMm)} mm — ` +
        `it focuses ${mm(geometry.focusMm)} mm down. Raise Height to ${mm(geometry.minHeightMm)} mm or raise LPI.`,
    );
  }
  if (geometry.pitchPx < MIN_LENS_PX) {
    lines.push(
      `⚠ Only ${geometry.pitchPx.toFixed(2)} px across a lenslet — the printed lens will be terraced. ` +
        `Raise PPI or lower LPI.`,
    );
  }
  // What a view tile is worth once the artwork is scaled onto the sheet. The
  // artwork raster always carries `stripSamples` px per tile — it grows to
  // guarantee it — but the printer has only the lenslet's own dots to spend and
  // they divide by the grid. Under about two, neighbouring views bleed together
  // everywhere rather than switching, and that is what finally caps the grid.
  const printedTilePx = geometry.pitchPx / grid;
  if (printedTilePx < 2) {
    lines.push(
      `⚠ A view tile lands on only ${printedTilePx.toFixed(2)} printed dots at ${settings.ppi} PPI — ` +
        `the views will bleed into each other at every angle rather than switching. Use a smaller grid, ` +
        `lower LPI, or raise PPI.`,
    );
  }
  return lines.join('\n');
}
