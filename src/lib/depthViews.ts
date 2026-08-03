// One picture and its heightmap → the run of views a Lenticular Print needs.
//
// `render3d.ts` gets its views the honest way: it has a mesh, so it re-renders
// the whole scene from each eye position and every occlusion resolves itself.
// Here there is no mesh. There is a photograph and a depth map, which between
// them describe a *relief* — one height per pixel, nothing behind it — and the
// views have to be warped out of that single sample.
//
// The projection is the same one, though, and that is the point of doing it
// here rather than inventing something: a point at depth z, seen by an eye
// `e` off-axis at distance D, lands on the sheet at
//
//     X = X₀ − e · z / (D − z)
//
// where X₀ is where it lands head-on — which is exactly the pixel it already
// occupies in the source image. So the head-on view *is* the source, untouched,
// and every other view is that image with each pixel slid sideways by an amount
// its depth decides. The same z/(D − z) that `disparityAtDepth` reports, so the
// parallax figures in the node's Info mean the same thing they do for a mesh.
//
// What a relief cannot do is show you what is behind itself. Slide a near
// pixel sideways and it uncovers ground the camera never saw — a disocclusion —
// and something has to be put there. The rule below is the usual one and the
// only one that reads as depth rather than as smearing: a gap between two
// neighbours is filled from the *farther* of the two. The near edge stays a
// crisp silhouette and the background stretches behind it, which is what the
// eye expects from an object passing in front of a wall. The node reports how
// wide those invented strips got, because that number is the honest limit on
// how much depth this method can carry.

import type { RasterImage } from '../types';
import type { ChunkProgress } from './chunked';
import { boxBlur, luminance, resizeBilinear } from './image';
import { MAX_VIEW_PX, MIN_VIEW_PX, clampSetbackMm, eyeOffsetsMm } from './render3d';

export interface DepthViewOptions {
  /** How many views to warp across the cone, left to right. */
  views: number;
  /** Printed width of the sheet, mm — what turns a shift in mm into pixels. */
  widthMm: number;
  /** How far the viewer stands from the print, mm. */
  viewDistanceMm: number;
  /** Front-to-back depth the heightmap's full black→white range stands for, mm. */
  depthMm: number;
  /**
   * Where the nearest plane of the picture sits, mm *behind* the sheet. 0 puts
   * white right against the glass. Negative brings it out through the plate;
   * {@link clampSetbackMm} holds it to a sane distance in front.
   */
  setbackMm: number;
  /** Viewing cone the run spans, degrees. */
  coneDeg: number;
  /** Working/output width in px. 0 or absent keeps the source's own width. */
  widthPx?: number;
  /** Heightmap convention: white is nearest, unless this flips it. */
  invertDepth?: boolean;
  /** Box-blur radius on the depth map before warping, in px of the working raster. */
  depthBlurPx?: number;
  /**
   * How much a run has to stretch, in output px, before the warp calls it a
   * silhouette and repaints the gap from the background beyond it rather than
   * from the edge pixels inside it. See {@link warpView}. Defaults to
   * {@link DEFAULT_EDGE_JUMP_PX}.
   */
  edgeJumpPx?: number;
}

/**
 * Default {@link DepthViewOptions.edgeJumpPx}. A run that pulls apart by more
 * than a pixel and a half across the edge window is not a surface any more.
 */
export const DEFAULT_EDGE_JUMP_PX = 1.5;

/**
 * The window a cliff is measured over: wide enough to span the depth map's own
 * ramp plus whatever the blur added, since the whole point is to look *past*
 * the ramp to the plateau on either side.
 */
export const edgeWindowFor = (depthBlurPx = 0): number => Math.max(2, Math.round(depthBlurPx) + 2);

/** The two numbers {@link warpView} uses to tell a cliff from a slope. */
export const tuningFrom = (o: DepthViewOptions): WarpTuning => ({
  edgeJumpPx: Math.max(0, o.edgeJumpPx ?? DEFAULT_EDGE_JUMP_PX),
  edgeWindowPx: edgeWindowFor(o.depthBlurPx),
});

export interface DepthViewRender {
  /** The views, left eye first — no mirroring; the lens is what inverts. */
  views: RasterImage[];
  /** Eye position of each view, mm off-axis; negative is left. */
  offsetsMm: number[];
  /** The depth map as actually used: resized, blurred, white = near. */
  depth: RasterImage;
  /** Where the picture sits behind the sheet, mm: near plane and far plane. */
  nearMm: number;
  farMm: number;
  /** Fraction of all warped pixels that had to be invented, 0–1. */
  filledFraction: number;
  /** Widest single invented strip, in px of the working raster. */
  maxHolePx: number;
}

/** Depth levels the LUT covers — one per 8-bit luminance step. */
const LEVELS = 256;

/** Working raster size for a source image at the requested output width. */
export function workingSize(img: RasterImage, widthPx?: number): { width: number; height: number } {
  const w = Math.round(widthPx && widthPx > 0 ? widthPx : img.width);
  const width = Math.min(MAX_VIEW_PX, Math.max(MIN_VIEW_PX, w));
  const height = Math.max(1, Math.round((img.height * width) / Math.max(1, img.width)));
  return { width, height };
}

/**
 * The depth map the warp will read: resized onto the working raster, blurred if
 * asked, and normalised so white is the near plane.
 *
 * The blur is not cosmetic. A depth map that steps by one level per pixel is
 * fine; one that dithers or comes out of a network with 8-bit banding tears the
 * warp into slivers, because every level boundary is a place where two adjacent
 * pixels land a whole pixel apart. A radius of 1–2 costs nothing visible and
 * removes most of it.
 */
export function prepareDepth(
  depthImg: RasterImage,
  width: number,
  height: number,
  { invertDepth = false, depthBlurPx = 0 }: Pick<DepthViewOptions, 'invertDepth' | 'depthBlurPx'> = {},
): RasterImage {
  let d = depthImg.width === width && depthImg.height === height ? depthImg : resizeBilinear(depthImg, width, height);
  const radius = Math.max(0, Math.round(depthBlurPx));
  if (radius > 0) d = boxBlur(d, radius);
  const out: RasterImage = {
    kind: 'image',
    width,
    height,
    data: new Uint8ClampedArray(width * height * 4),
  };
  for (let i = 0; i < out.data.length; i += 4) {
    const l = luminance(d.data[i], d.data[i + 1], d.data[i + 2]);
    const v = invertDepth ? 255 - l : l;
    out.data[i] = out.data[i + 1] = out.data[i + 2] = v;
    out.data[i + 3] = 255;
  }
  return out;
}

/**
 * How far, in px of the working raster, each of the 256 depth levels slides when
 * the eye moves to `eyeMm` off-axis.
 *
 * Level 255 (white) is the near plane at `setbackMm` behind the sheet; level 0
 * is `depthMm` further back. Behind the sheet z is negative, so the shift takes
 * the sign of the eye offset: the background moves *with* your head, which is
 * the whole of what makes a window read as deep.
 */
export function shiftLut(o: DepthViewOptions, eyeMm: number, widthPx: number): Float32Array {
  const D = Math.max(1e-6, o.viewDistanceMm);
  const nearMm = clampSetbackMm(o.setbackMm, D);
  const depthMm = Math.max(0, o.depthMm);
  const pxPerMm = widthPx / Math.max(1e-6, o.widthMm);
  const lut = new Float32Array(LEVELS);
  for (let level = 0; level < LEVELS; level++) {
    // Behind the sheet is negative z, matching projectToSheet / disparityAtDepth.
    const z = -(nearMm + (1 - level / (LEVELS - 1)) * depthMm);
    lut[level] = ((-eyeMm * z) / (D - z)) * pxPerMm;
  }
  return lut;
}

/** What one warped view cost in invented pixels. */
interface WarpStats {
  filled: number;
  maxRun: number;
}

/** How the warp decides an edge is a cliff rather than a slope. See {@link warpView}. */
export interface WarpTuning {
  /**
   * Output px of stretch across the edge window, past which the run is treated
   * as a silhouette rather than as a surface turning away.
   */
  edgeJumpPx: number;
  /** Half-width of the window a cliff is looked for over, in source px. */
  edgeWindowPx: number;
}

/**
 * Warp one view: every source pixel slides by its depth's shift, nearest sample
 * wins, and the gaps that opens are filled from behind.
 *
 * Forward warping rather than an inverse lookup, because the inverse of this
 * map is not a function — at an occlusion two source pixels want the same
 * output pixel, and at a disocclusion none do. So each source pixel is splatted
 * with a depth test (the occlusion case resolves itself, nearest wins), and the
 * runs between neighbours that ended up more than a pixel apart are painted
 * from whichever of the two is farther.
 *
 * Filling from the farther *neighbour* is not enough, and this is the thing
 * that makes or breaks the result. No real depth map has a one-pixel cliff: an
 * estimator hands back a two- or three-pixel ramp at every silhouette, the
 * blur above widens it, and the picture has its own antialiased edge in the
 * same place. Those ramp pixels are neither subject nor background — their
 * colour is a blend of the two and their depth is between the two — and they
 * are exactly the pixels that a neighbour-wise fill picks up and drags across
 * the hole. That is the smear: not the subject moving, the subject's *edge*
 * being stretched into the ground behind it.
 *
 * So an edge is measured over a window rather than between two pixels. Where
 * the row stretches by more than `edgeJumpPx` across ±`edgeWindowPx`, the whole
 * run is one cliff, and the span it opens is repainted from the plateau on the
 * far side — discarding whatever ramp pixels landed inside it, and only those
 * (a pixel written from outside the cliff is left alone, so an unrelated
 * surface passing through is never overwritten). The silhouette keeps its own
 * edge, the background keeps its own colour, and nothing in between survives to
 * be smeared.
 *
 * A gentle slope stays a slope: under the threshold the old neighbour-wise fill
 * still runs, which is what stretches a receding surface honestly. The
 * threshold is where "a surface turning away" becomes "a surface seen edge-on",
 * and a surface seen that nearly edge-on carries no detail worth keeping.
 */
export function warpView(
  src: RasterImage,
  depth: RasterImage,
  lut: Float32Array,
  out: RasterImage,
  tuning: WarpTuning,
  stats?: WarpStats,
): void {
  const { width: w, height: h } = src;
  const xs = new Float32Array(w);
  const key = new Int16Array(w);
  const zbuf = new Int16Array(w);
  const srcOf = new Int32Array(w);
  const drawn = new Uint8Array(w);
  const cliff = new Uint8Array(w);
  const r = Math.max(1, Math.round(tuning.edgeWindowPx));
  const jump = Math.max(0, tuning.edgeJumpPx);
  out.data.fill(0);

  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      const level = depth.data[(row + x) * 4];
      key[x] = level;
      xs[x] = x + lut[level];
    }
    zbuf.fill(-1);
    srcOf.fill(-1);
    drawn.fill(0);

    // Pass 1 — every source pixel lands somewhere, nearest sample wins.
    for (let x = 0; x < w; x++) {
      const px = Math.round(xs[x]);
      if (px < 0 || px >= w) continue;
      if (key[x] > zbuf[px]) {
        zbuf[px] = key[x];
        srcOf[px] = x;
        drawn[px] = 1;
        copyPixel(src.data, (row + x) * 4, out.data, (row + px) * 4);
      }
    }

    // Pass 2 — the gaps between neighbours that came apart, filled from the
    // farther one. Only where they moved apart: crossed neighbours are an
    // occlusion, which pass 1 has already settled.
    for (let x = 0; x < w - 1; x++) {
      if (xs[x + 1] - xs[x] <= 1) continue;
      const from = key[x] <= key[x + 1] ? x : x + 1;
      const k = key[from];
      const lo = Math.max(0, Math.ceil(xs[x]));
      const hi = Math.min(w - 1, Math.floor(xs[x + 1]));
      for (let px = lo; px <= hi; px++) {
        if (k > zbuf[px]) {
          zbuf[px] = k;
          srcOf[px] = from;
          drawn[px] = 0;
          copyPixel(src.data, (row + from) * 4, out.data, (row + px) * 4);
        }
      }
    }

    // Pass 3 — the cliffs. Signed on purpose: a run that *stretches* is a
    // disocclusion and needs this, while one that compresses is the occluding
    // side of the same edge, where pass 1 has already covered everything and
    // the subject's own leading edge must not be touched.
    for (let x = 0; x < w; x++) {
      const a = Math.max(0, x - r);
      const b = Math.min(w - 1, x + r);
      cliff[x] = xs[b] - xs[a] - (b - a) > jump ? 1 : 0;
    }
    for (let start = 0; start < w; start++) {
      if (!cliff[start]) continue;
      let end = start;
      while (end + 1 < w && cliff[end + 1]) end++;
      // The window flags the pixels *around* the transition, so the run already
      // reaches the plateau either side of it — its ends are the honest subject
      // and the honest background, whatever the ramp between them says.
      const from = key[start] <= key[end] ? start : end;
      const lo = Math.max(0, Math.ceil(xs[start]));
      const hi = Math.min(w - 1, Math.floor(xs[end]));
      for (let px = lo; px <= hi; px++) {
        const s = srcOf[px];
        if (s === -1 || (s > start && s < end)) {
          zbuf[px] = key[from];
          srcOf[px] = from;
          drawn[px] = 0;
          copyPixel(src.data, (row + from) * 4, out.data, (row + px) * 4);
        }
      }
      start = end;
    }

    // Pass 4 — the margins. The whole picture has slid one way, so one edge of
    // the row has run out of source; hold the last pixel there rather than
    // letting a transparent band print.
    let first = 0;
    while (first < w && zbuf[first] < 0) first++;
    if (first >= w) continue; // nothing landed in this row at all
    let last = w - 1;
    while (last >= 0 && zbuf[last] < 0) last--;
    for (let px = 0; px < first; px++) copyPixel(out.data, (row + first) * 4, out.data, (row + px) * 4);
    for (let px = last + 1; px < w; px++) copyPixel(out.data, (row + last) * 4, out.data, (row + px) * 4);

    if (stats) {
      let run = 0;
      for (let px = 0; px < w; px++) {
        if (drawn[px]) {
          run = 0;
        } else {
          stats.filled++;
          run++;
          if (run > stats.maxRun) stats.maxRun = run;
        }
      }
    }
  }
}

function copyPixel(src: Uint8ClampedArray, si: number, dst: Uint8ClampedArray, di: number): void {
  dst[di] = src[si];
  dst[di + 1] = src[si + 1];
  dst[di + 2] = src[si + 2];
  dst[di + 3] = src[si + 3];
}

/**
 * Warp a picture and its heightmap into the run of views a lenticular print
 * needs, one view at a time.
 *
 * A view is the natural chunk: one whole pass over the raster, and the unit the
 * progress is worth counting in ("view 9 of 16").
 */
export function* depthViewChunks(
  image: RasterImage,
  depthImg: RasterImage,
  o: DepthViewOptions,
): Generator<ChunkProgress, DepthViewRender> {
  const count = Math.max(1, Math.round(o.views));
  const { width, height } = workingSize(image, o.widthPx);
  const src = image.width === width && image.height === height ? image : resizeBilinear(image, width, height);
  const depth = prepareDepth(depthImg, width, height, o);
  const offsetsMm = eyeOffsetsMm(count, o.coneDeg, o.viewDistanceMm);
  const nearMm = clampSetbackMm(o.setbackMm, o.viewDistanceMm);

  const views: RasterImage[] = [];
  const stats: WarpStats = { filled: 0, maxRun: 0 };
  const tuning = tuningFrom(o);
  for (let i = 0; i < count; i++) {
    const out: RasterImage = {
      kind: 'image',
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    };
    warpView(src, depth, shiftLut(o, offsetsMm[i], width), out, tuning, stats);
    views.push(out);
    yield { done: views.length, total: count, what: 'Views' };
  }

  return {
    views,
    offsetsMm,
    depth,
    nearMm,
    farMm: nearMm + Math.max(0, o.depthMm),
    filledFraction: stats.filled / Math.max(1, width * height * count),
    maxHolePx: stats.maxRun,
  };
}

/** {@link depthViewChunks}, run straight through. */
export function renderDepthViews(
  image: RasterImage,
  depthImg: RasterImage,
  o: DepthViewOptions,
): DepthViewRender {
  const gen = depthViewChunks(image, depthImg, o);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}
