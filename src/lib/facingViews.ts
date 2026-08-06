// One picture, turned to face the viewer from wherever the print is looked at.
//
// Every other view producer in the tool asks "what does the scene look like
// from over there?" This one asks the opposite: what would have to be printed
// so that the picture looks the *same* from over there — square on, undistorted
// — as it does head-on? Under a lens that is a poster which pivots to follow
// you round the room, and it is the one effect a flat print cannot fake by any
// amount of retouching, because it needs a different image per angle.
//
// The construction is a ray trace of one textured plane, and it is worth being
// exact about why that is the whole of it:
//
//   • The picture lives on a plane through the centre of the sheet whose normal
//     points at the eye. That is the definition of "facing you", and `follow`
//     scales the two turn angles so a fraction of it is available too — 0 is a
//     plain flat print, 1 is dead square on at every angle.
//
//   • Each view is rendered by casting a ray from that view's eye through each
//     pixel of the sheet and sampling the plane where it lands. So the eye,
//     looking at the printed sheet from that position, sees exactly what a real
//     picture hanging in that plane would show it. No foreshortening survives:
//     the sheet's own cos θ squash is undone by the same cos θ the ray trace put
//     in. See {@link facingViewChunks}.
//
//   • A turned plane covers less of the sheet than a square one does, so the
//     picture is scaled up until it covers the sheet from *every* view in the
//     run — {@link coverScale} — and the same scale is used for all of them.
//     One scale, not one per view: a per-view fit would breathe in and out as
//     you moved, which reads as the picture bulging rather than turning.
//
// What the viewer sees, then, is a picture bigger than the sheet, cropped by
// the sheet's own edges, with the crop sliding and the plane pivoting as they
// move — a window onto a poster that always faces them.

import type { RasterImage } from '../types';
import type { ChunkProgress } from './chunked';
import { createImage, resizeBilinear } from './image';
import { eyeOffsetsMm } from './render3d';

export interface FacingViewOptions {
  /** A horizontal run for a Lenticular Print, or a grid for a Lens Grid Print. */
  layout: '1d' | '2d';
  /** Views in the run, when the layout is `1d`. */
  views: number;
  /** Views across the grid, when the layout is `2d`. */
  grid: number;
  /** Views down it; omitted is square. */
  gridY?: number;
  /** Printed sheet size, mm — the aspect every view is rendered at. */
  widthMm: number;
  heightMm: number;
  /** Pixels across one view; the height follows the sheet aspect. */
  widthPx: number;
  /** How far the print is meant to be looked at, mm. */
  viewDistanceMm: number;
  /** The angle the views span — the lens's own viewing cone, degrees. */
  coneDeg: number;
  /**
   * How much of the way round the picture turns, 0–1. 1 is square on to the eye
   * at every angle (the whole point); 0 leaves it flat on the sheet, which
   * makes every view identical and prints an ordinary picture. In between it
   * lags behind you, which reads as a picture on a loose pivot.
   */
  follow: number;
  /**
   * Multiplier on the smallest picture that still covers the sheet everywhere.
   * 1 shows as much of the source as possible; above that crops in, which
   * exaggerates the movement because the same turn sweeps a bigger picture past
   * the sheet's edges.
   */
  zoom?: number;
}

export interface FacingViewRender {
  /** The views, in reading order: left→right for a run, row-major for a grid. */
  views: RasterImage[];
  /** Each view's eye position, mm off the sheet's axis. */
  eyesMm: { x: number; y: number }[];
  /** The picture's size as a multiple of the sheet, cover and zoom included. */
  scale: number;
  /** Half-angles the outermost views turn through, degrees. */
  turnXDeg: number;
  turnYDeg: number;
  /** Fraction of the source visible head-on, 0–1 — what the crop costs. */
  headOnFraction: number;
  /** The source as actually sampled, after any downscale to the printed size. */
  sourcePx: { width: number; height: number };
}

/** Views this configuration will produce. */
export const facingViewCount = (o: FacingViewOptions): number =>
  o.layout === '2d'
    ? Math.max(1, Math.round(o.grid)) * Math.max(1, Math.round(o.gridY ?? o.grid))
    : Math.max(1, Math.round(o.views));

/**
 * Where the eye stands for each view, mm off-axis, in the order the views come
 * back: left to right for a run; row-major from `Left · Up` for a grid, which is
 * the order Lens Grid Print names its cells in. Row 0 is `Up`, so the eye is
 * above the sheet and y is positive.
 */
export function facingEyePositions(o: FacingViewOptions): { x: number; y: number }[] {
  if (o.layout === '2d') {
    const cols = Math.max(1, Math.round(o.grid));
    const rows = Math.max(1, Math.round(o.gridY ?? o.grid));
    // Both axes cross the same cone — a lens cap is as wide up as it is across —
    // so a sparser axis simply takes bigger steps through it.
    const xs = eyeOffsetsMm(cols, o.coneDeg, o.viewDistanceMm);
    const ys = eyeOffsetsMm(rows, o.coneDeg, o.viewDistanceMm);
    const out: { x: number; y: number }[] = [];
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) out.push({ x: xs[col], y: -ys[row] });
    }
    return out;
  }
  return eyeOffsetsMm(Math.max(1, Math.round(o.views)), o.coneDeg, o.viewDistanceMm).map((x) => ({
    x,
    y: 0,
  }));
}

/** The picture plane for one eye: its normal, and the two axes across its face. */
interface PicturePlane {
  n: [number, number, number];
  u: [number, number, number];
  v: [number, number, number];
  /** The turn itself, radians — reported, and zero for the head-on view. */
  yaw: number;
  pitch: number;
}

/**
 * The plane that faces an eye at (`ex`, `ey`, `D`), turned `follow` of the way.
 *
 * A yaw about the sheet's up axis followed by a pitch about its across axis,
 * both taken from the eye's own bearing, so at `follow` = 1 the normal points
 * straight down the line of sight. Two angles rather than one axis-angle on
 * purpose: they are what the viewer's head actually does, they scale
 * independently, and a print that follows sideways but not vertically (which is
 * what a 1D lens can carry) is exactly `pitch` = 0.
 */
function planeFacing(ex: number, ey: number, D: number, follow: number): PicturePlane {
  const f = Math.min(1, Math.max(0, follow));
  const yaw = f * Math.atan2(ex, D);
  const pitch = f * -Math.asin(ey / Math.max(1e-6, Math.hypot(ex, ey, D)));
  const [sy, cy] = [Math.sin(yaw), Math.cos(yaw)];
  const [sp, cp] = [Math.sin(pitch), Math.cos(pitch)];
  return {
    n: [sy * cp, -sp, cy * cp],
    u: [cy, 0, -sy],
    v: [sy * sp, cp, cy * sp],
    yaw,
    pitch,
  };
}

const dot = (a: [number, number, number], x: number, y: number, z: number): number =>
  a[0] * x + a[1] * y + a[2] * z;

/**
 * Where a sheet point lands on the picture plane, in millimetres across its
 * face from its centre.
 *
 * The ray leaves the eye, passes through the sheet at (`X`, `Y`, 0) and meets
 * the plane, which passes through the origin: `n·(E + t(Q − E)) = 0`, so
 * `t = n·E / (n·E − n·Q)`. The denominator only vanishes for a plane seen
 * edge-on, which a plane turned to face the eye never is.
 */
function planeHit(
  p: PicturePlane,
  ex: number,
  ey: number,
  D: number,
  X: number,
  Y: number,
): { a: number; b: number } {
  const nE = dot(p.n, ex, ey, D);
  const nQ = dot(p.n, X, Y, 0);
  const denom = nE - nQ;
  const t = nE / (Math.abs(denom) < 1e-9 ? 1e-9 : denom);
  const hx = ex + t * (X - ex);
  const hy = ey + t * (Y - ey);
  const hz = D + t * (0 - D);
  return { a: dot(p.u, hx, hy, hz), b: dot(p.v, hx, hy, hz) };
}

/**
 * How much bigger than the sheet the picture has to be for the sheet to be
 * covered in every view of the run.
 *
 * The map from sheet to picture is a homography, so the sheet rectangle lands
 * as a quadrilateral and its extremes are its four corners — checking those is
 * checking all of it. Taken over the whole run at once, so one picture size
 * serves every view and the print does not breathe as you move.
 */
export function coverScale(o: FacingViewOptions): number {
  const halfW = Math.max(0.01, o.widthMm) / 2;
  const halfH = Math.max(0.01, o.heightMm) / 2;
  const D = Math.max(1, o.viewDistanceMm);
  let scale = 1;
  for (const eye of facingEyePositions(o)) {
    const plane = planeFacing(eye.x, eye.y, D, o.follow);
    for (const sx of [-1, 1]) {
      for (const sy of [-1, 1]) {
        const hit = planeHit(plane, eye.x, eye.y, D, sx * halfW, sy * halfH);
        scale = Math.max(scale, Math.abs(hit.a) / halfW, Math.abs(hit.b) / halfH);
      }
    }
  }
  return scale;
}

/** Bilinear sample of `img` at normalised coordinates, edge-clamped. */
function sampleInto(img: RasterImage, u: number, v: number, out: Uint8ClampedArray, at: number) {
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

/** The printed raster of one view: sheet aspect, at the requested width. */
export function facingViewSize(o: FacingViewOptions): { width: number; height: number } {
  const width = Math.max(8, Math.round(o.widthPx));
  const height = Math.max(1, Math.round((width * Math.max(0.01, o.heightMm)) / Math.max(0.01, o.widthMm)));
  return { width, height };
}

/**
 * How the source is laid onto the picture plane: cover, so the plane is full
 * whatever aspect the picture arrived in, and the overflow is cropped rather
 * than letterboxed. `sx`/`sy` are the fractions of the source that survive.
 */
function coverFit(img: RasterImage, sheetAspect: number): { sx: number; sy: number } {
  const imageAspect = Math.max(1e-6, img.width / Math.max(1, img.height));
  return imageAspect > sheetAspect
    ? { sx: sheetAspect / imageAspect, sy: 1 }
    : { sx: 1, sy: imageAspect / sheetAspect };
}

/**
 * The source at no more resolution than the print can show it.
 *
 * The picture is `scale` sheets wide and the sheet prints `widthPx` across, so
 * anything past that is detail the view raster cannot carry — and sampling a
 * much larger source point by point would alias it rather than average it.
 * Downscaling once, up front, is both the cheap and the correct thing.
 */
function sourceForPrint(img: RasterImage, o: FacingViewOptions, scale: number): RasterImage {
  const { width } = facingViewSize(o);
  const wanted = Math.max(8, Math.ceil(width * scale));
  if (img.width <= wanted) return img;
  return resizeBilinear(img, wanted, Math.max(1, Math.round((img.height * wanted) / img.width)));
}

/** Render every view of the run. See {@link facingViewChunks}. */
export function renderFacingViews(image: RasterImage, o: FacingViewOptions): FacingViewRender {
  const gen = facingViewChunks(image, o);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * {@link renderFacingViews}, one view at a time.
 *
 * A view is the chunk, as everywhere else in the tool: it is one full pass over
 * the sheet raster, it is the unit worth counting, and a 15×15 grid is 225 of
 * them.
 */
export function* facingViewChunks(
  image: RasterImage,
  o: FacingViewOptions,
): Generator<ChunkProgress, FacingViewRender> {
  const eyes = facingEyePositions(o);
  const { width, height } = facingViewSize(o);
  const widthMm = Math.max(0.01, o.widthMm);
  const heightMm = Math.max(0.01, o.heightMm);
  const D = Math.max(1, o.viewDistanceMm);
  const zoom = Math.max(1, o.zoom ?? 1);
  const scale = coverScale(o) * zoom;

  const src = sourceForPrint(image, o, scale);
  const fit = coverFit(src, widthMm / heightMm);
  // Half the picture, in millimetres of the sheet it is measured against.
  const pw = (scale * widthMm) / 2;
  const ph = (scale * heightMm) / 2;
  const mmPerPxX = widthMm / width;
  const mmPerPxY = heightMm / height;

  const views: RasterImage[] = [];
  for (const eye of eyes) {
    const plane = planeFacing(eye.x, eye.y, D, o.follow);
    const out = createImage(width, height, [255, 255, 255, 255]);
    for (let y = 0; y < height; y++) {
      // Sheet coordinates: centred, y up, so row 0 is the top of the print.
      const Y = heightMm / 2 - (y + 0.5) * mmPerPxY;
      for (let x = 0; x < width; x++) {
        const X = (x + 0.5) * mmPerPxX - widthMm / 2;
        const { a, b } = planeHit(plane, eye.x, eye.y, D, X, Y);
        sampleInto(
          src,
          0.5 + (0.5 * a * fit.sx) / pw,
          0.5 - (0.5 * b * fit.sy) / ph,
          out.data,
          (y * width + x) * 4,
        );
      }
    }
    views.push(out);
    yield { done: views.length, total: eyes.length, what: 'Views' };
  }

  const outer = eyes[eyes.length - 1] ?? { x: 0, y: 0 };
  const turn = planeFacing(Math.abs(outer.x), Math.abs(outer.y), D, o.follow);
  return {
    views,
    eyesMm: eyes,
    scale,
    turnXDeg: (Math.abs(turn.yaw) * 180) / Math.PI,
    turnYDeg: (Math.abs(turn.pitch) * 180) / Math.PI,
    // Head-on the picture is square to the sheet, so the sheet is a 1/scale
    // window on it in each axis — which is the crop the effect costs.
    headOnFraction: 1 / (scale * scale),
    sourcePx: { width: src.width, height: src.height },
  };
}
