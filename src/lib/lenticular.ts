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

/** Guard against a settings typo asking for a hundred-gigapixel raster. */
export const MAX_OUTPUT_PIXELS = 80_000_000;

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
}

/** The value each band of a calibration sheet is printed at. */
export function calibrationValues(spec: CalibrationSpec): number[] {
  const bands = Math.max(2, Math.round(spec.bands));
  const lo = Math.min(spec.min, spec.max);
  const hi = Math.max(spec.min, spec.max);
  return Array.from({ length: bands }, (_, i) => lo + ((hi - lo) * i) / (bands - 1));
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
 * Solid frames that read as a hard switch: frame 0 white through to black on
 * the last. With two frames that is simply white then black — the target for
 * checking *where* a print flips, with none of the artwork's own detail in the
 * way. 1×1 because a lenticular render samples frames normalised.
 */
export function switchFrames(count: number): RasterImage[] {
  const n = Math.max(2, Math.round(count));
  return Array.from({ length: n }, (_, i) => {
    const v = Math.round(255 * (1 - i / (n - 1)));
    return createImage(1, 1, [v, v, v, 255]);
  });
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
 * The aspect ratio is the first frame's, as everywhere else. The bound is
 * orientation-independent: the pixels are square, so a strip that survives
 * along x survives at any angle.
 */
export function interlacedSize(settings: LenticularSettings, frames: RasterImage[]): OutputSize {
  const first = frames[0];
  const lenticules = (Math.max(0.01, settings.widthMm) * Math.max(1e-6, settings.lpi)) / 25.4;
  const samples = Math.max(1, settings.stripSamples);
  const forStrips = Math.ceil(lenticules * frames.length * samples);
  const forArtwork = Math.max(...frames.map((f) => f.width));
  const width = Math.max(1, forStrips, forArtwork);
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

function checkBudget(width: number, height: number, what: string, fix: string): void {
  if (width * height <= MAX_OUTPUT_PIXELS) return;
  throw new Error(
    `${what} would be ${width}×${height} px (${Math.round((width * height) / 1e6)} MP). ` +
      `${fix} — the limit is ${MAX_OUTPUT_PIXELS / 1e6} MP.`,
  );
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
  if (frames.length < 2) throw new Error('Lenticular print needs at least 2 images');
  const size = options.interlacedSize ?? interlacedSize(settings, frames);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  checkBudget(width, height, 'Interlaced artwork', 'Reduce Width (mm), LPI or the source resolution');

  const s = sheet(frames, settings, options);
  const frameCount = frames.length;
  const mmPerPx = s.widthMm / width;
  const out = createImage(width, height, [255, 255, 255, 255]);

  for (let y = 0; y < height; y++) {
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
  if (frames.length < 2) throw new Error('Lenticular print needs at least 2 images');
  const size = outputSize(settings, frames[0]);
  const { width, height } = size;
  checkBudget(width, height, 'Depth map', 'Reduce Width (mm) or PPI');

  const s = sheet(frames, settings, options);
  const mmPerPx = s.widthMm / width;
  const depth = new Uint16Array(width * height);

  for (let y = 0; y < height; y++) {
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
  if (frames.length < 2) throw new Error('Lenticular print needs at least 2 images');
  // Budget both halves before rendering either: a sheet too big for the depth
  // map must fail now, not after a multi-megapixel artwork pass.
  const art = options.interlacedSize ?? interlacedSize(settings, frames);
  const map = outputSize(settings, frames[0]);
  checkBudget(art.width, art.height, 'Interlaced artwork', 'Reduce Width (mm), LPI or the source resolution');
  checkBudget(map.width, map.height, 'Depth map', 'Reduce Width (mm) or PPI');

  const interlaced = renderInterlaced(frames, settings, options);
  const depth = renderDepthMap(frames, settings, options);
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
// differs — a round cap inscribed in each square cell, leaving the cell corners
// (1 − π/4, about 21%) flat at base height.
// ---------------------------------------------------------------------------

export interface LensGridSettings extends LenticularSettings {
  /** Lenslets per side of one view grid: 2 = 2×2 (4 views), 3 = 3×3 (9). */
  grid: number;
  /** 0–1 phase down the second axis, the rows of lenslets. */
  phaseY: number;
  /**
   * Place each view opposite the direction it is named for. A lens inverts, so
   * the view you see from the left has to sit on the *right* of its cell; with
   * this off the print is pseudoscopic (parallax runs backwards).
   */
  mirrorViews: boolean;
}

export const MIN_GRID = 2;
export const MAX_GRID = 6;
/** 3×3 — nine views, the smallest grid with a true head-on centre. */
export const DEFAULT_GRID = 3;

export const clampGrid = (grid: number): number =>
  Math.min(MAX_GRID, Math.max(MIN_GRID, Math.round(grid) || MIN_GRID));

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

/** {@link interlacedSize} for a grid: every cell needs `grid` views across. */
export function gridInterlacedSize(settings: LensGridSettings, views: RasterImage[]): OutputSize {
  const first = views[0];
  const cells = (Math.max(0.01, settings.widthMm) * Math.max(1e-6, settings.lpi)) / 25.4;
  const samples = Math.max(1, settings.stripSamples);
  const forViews = Math.ceil(cells * clampGrid(settings.grid) * samples);
  const forArtwork = Math.max(...views.map((v) => v.width));
  const width = Math.max(1, forViews, forArtwork);
  return { width, height: Math.max(1, Math.round((width * first.height) / first.width)) };
}

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
  const grid = requireGridViews(views, settings.grid);
  const size = options.interlacedSize ?? gridInterlacedSize(settings, views);
  const width = Math.max(1, Math.round(size.width));
  const height = Math.max(1, Math.round(size.height));
  checkBudget(width, height, 'Interlaced artwork', 'Reduce Width (mm), LPI, the grid or the source size');

  const s = sheet(views, settings, options);
  const phaseY = settings.phaseY - Math.floor(settings.phaseY);
  const mmPerPx = s.widthMm / width;
  const out = createImage(width, height, [255, 255, 255, 255]);

  for (let y = 0; y < height; y++) {
    const yMm = (y + 0.5) * mmPerPx;
    for (let x = 0; x < width; x++) {
      const xMm = (x + 0.5) * mmPerPx;
      const band = bandAt(s, xMm, yMm);
      if (!band) continue;

      const pitchMm = band.geometry.pitchMm;
      const u = xMm * s.cos + yMm * s.sin;
      const v = -xMm * s.sin + yMm * s.cos;
      const su = u / pitchMm + s.phase;
      const sv = v / pitchMm + phaseY;
      const cellU = Math.floor(su);
      const cellV = Math.floor(sv);
      const col = Math.min(grid - 1, Math.floor((su - cellU) * grid));
      const row = Math.min(grid - 1, Math.floor((sv - cellV) * grid));

      // The lens inverts: the tile on the left of a cell is what an eye to the
      // *right* sees, so a view named "Left" belongs on the right.
      const viewCol = settings.mirrorViews ? grid - 1 - col : col;
      const viewRow = settings.mirrorViews ? grid - 1 - row : row;

      // Sample at the cell centre, rotated back into sheet coordinates.
      const uc = (cellU + 0.5 - s.phase) * pitchMm;
      const vc = (cellV + 0.5 - phaseY) * pitchMm;
      sampleNormalized(
        views[viewRow * grid + viewCol],
        (uc * s.cos - vc * s.sin) / s.widthMm,
        (uc * s.sin + vc * s.cos) / s.heightMm,
        out.data,
        (y * width + x) * 4,
      );
    }
  }
  return out;
}

/**
 * The lens array as a 16-bit height field: a spherical cap per cell, inscribed
 * in the cell so the corners stay flat at base height.
 */
export function renderGridDepthMap(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): DepthMapResult {
  requireGridViews(views, settings.grid);
  const size = outputSize(settings, views[0]);
  const { width, height } = size;
  checkBudget(width, height, 'Depth map', 'Reduce Width (mm) or PPI');

  const s = sheet(views, settings, options);
  const phaseY = settings.phaseY - Math.floor(settings.phaseY);
  const mmPerPx = s.widthMm / width;
  const depth = new Uint16Array(width * height);

  for (let y = 0; y < height; y++) {
    const yMm = (y + 0.5) * mmPerPx;
    for (let x = 0; x < width; x++) {
      const xMm = (x + 0.5) * mmPerPx;
      const band = bandAt(s, xMm, yMm);
      if (!band) continue;

      const { pitchMm, sagMm, baseMm, radiusMm } = band.geometry;
      const u = xMm * s.cos + yMm * s.sin;
      const v = -xMm * s.sin + yMm * s.cos;
      const su = u / pitchMm + s.phase;
      const sv = v / pitchMm + phaseY;
      const du = (su - Math.floor(su) - 0.5) * pitchMm;
      const dv = (sv - Math.floor(sv) - 0.5) * pitchMm;

      // Round cap inscribed in the square cell; outside it, flat base.
      const r = Math.hypot(du, dv);
      const arc =
        r <= pitchMm / 2 ? Math.sqrt(Math.max(0, radiusMm * radiusMm - r * r)) - (radiusMm - sagMm) : 0;
      const mm = baseMm + Math.max(0, arc);
      depth[y * width + x] = Math.round(Math.min(1, mm / s.depthScaleMm) * 65535);
    }
  }
  return { depth, width, height, scaleMm: s.depthScaleMm, bands: s.bands };
}

/** Both halves of a 2D lens-grid print. See {@link renderLenticular}. */
export function renderLensGrid(
  views: RasterImage[],
  settings: LensGridSettings,
  options: RenderOptions = {},
): LenticularRender {
  const grid = requireGridViews(views, settings.grid);
  const art = options.interlacedSize ?? gridInterlacedSize(settings, views);
  const map = outputSize(settings, views[0]);
  checkBudget(
    art.width,
    art.height,
    'Interlaced artwork',
    'Reduce Width (mm), LPI, the grid or the source size',
  );
  checkBudget(map.width, map.height, 'Depth map', 'Reduce Width (mm) or PPI');

  const interlaced = renderGridInterlaced(views, { ...settings, grid }, options);
  const depth = renderGridDepthMap(views, { ...settings, grid }, options);
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

/** Fewer pixels than this across a lenticule and the lens profile is terraced. */
const MIN_LENS_PX = 8;

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
  return {
    width: Math.max(1, Math.round(across)),
    height: Math.max(1, Math.round((across * first.height) / first.width)),
  };
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
  const lines = [
    `${grid}×${grid} grid = ${grid * grid} views · ${settings.widthMm} mm wide`,
    `Depth map ${depthSize.width}×${depthSize.height} px @ ${settings.ppi} PPI · ` +
      `artwork ${artSize.width}×${artSize.height} px (scale to fit at print time)`,
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
  return lines.join('\n');
}
