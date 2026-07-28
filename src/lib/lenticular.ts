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
}

/** The value each band of a calibration sheet is printed at. */
export function calibrationValues(spec: CalibrationSpec): number[] {
  const bands = Math.max(2, Math.round(spec.bands));
  const lo = Math.min(spec.min, spec.max);
  const hi = Math.max(spec.min, spec.max);
  return Array.from({ length: bands }, (_, i) => lo + ((hi - lo) * i) / (bands - 1));
}

/** Apply one calibration band's value on top of the node's live settings. */
export function withCalibrationValue(
  settings: LenticularSettings,
  param: CalibrationParam,
  value: number,
): LenticularSettings {
  if (param === 'height') return { ...settings, heightMm: value };
  if (param === 'ri') return { ...settings, ri: value };
  return { ...settings, lpi: value };
}

export interface LenticularRender {
  /** Interlaced artwork, ready to print. */
  interlaced: RasterImage;
  /** Lens array as a 16-bit height field; 65535 = `depthScaleMm`. */
  depth: Uint16Array;
  /** Height in mm that a depth value of 65535 represents. */
  depthScaleMm: number;
  width: number;
  height: number;
  /** Geometry per band (a single entry for a normal, unbanded render). */
  bands: { value?: number; geometry: LensGeometry }[];
}

export interface RenderOptions {
  /** Sweep a setting across the sheet instead of rendering it flat. */
  calibration?: CalibrationSpec;
  /** Blank separator between calibration bands, printer pixels. */
  bandGapPx?: number;
}

/**
 * Render the interlaced artwork and its lens depth map in a single pass.
 *
 * Each output pixel is placed by its coordinate `u` across the lenticules
 * (rotated by `orientationDeg`). The fraction of the way through the lenticule
 * picks the frame; the sample point is the *lenticule centre*, not the pixel
 * itself, so every strip of a lenticule shows the same spot of the artwork from
 * its own frame — that squeeze to 1/n of the lenticule width is the interlace.
 */
export function renderLenticular(
  frames: RasterImage[],
  settings: LenticularSettings,
  options: RenderOptions = {},
): LenticularRender {
  if (frames.length < 2) throw new Error('Lenticular print needs at least 2 images');
  const size = outputSize(settings, frames[0]);
  const { width, height } = size;
  if (width * height > MAX_OUTPUT_PIXELS) {
    throw new Error(
      `Output would be ${width}×${height} px (${Math.round((width * height) / 1e6)} MP). ` +
        `Reduce Width (mm) or PPI — the limit is ${MAX_OUTPUT_PIXELS / 1e6} MP.`,
    );
  }

  const theta = (settings.orientationDeg * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const frameCount = frames.length;
  const phase = settings.phase - Math.floor(settings.phase); // wrap into 0–1

  // One geometry per calibration band (or a single one for a flat render).
  const values = options.calibration ? calibrationValues(options.calibration) : [];
  const bands = options.calibration
    ? values.map((value) => ({
        value,
        geometry: lensGeometry(withCalibrationValue(settings, options.calibration!.param, value)),
      }))
    : [{ geometry: lensGeometry(settings) }];

  // Depth is normalised against the tallest stack on the sheet, so a Height
  // calibration keeps every band on one comparable scale.
  const depthScaleMm = Math.max(1e-6, ...bands.map((b) => b.geometry.totalMm));

  // Bands are stacked along the lenticule direction (v), so each one still
  // carries whole, uncut lenticules at any orientation.
  const corners = [
    [0, 0],
    [width, 0],
    [0, height],
    [width, height],
  ].map(([x, y]) => -x * sin + y * cos);
  const vMin = Math.min(...corners);
  const vSpan = Math.max(1e-6, Math.max(...corners) - vMin);
  const bandSpan = vSpan / bands.length;
  const gap = Math.max(0, options.bandGapPx ?? 0);

  const interlaced = createImage(width, height, [255, 255, 255, 255]);
  const depth = new Uint16Array(width * height);
  const pixel = interlaced.data;

  for (let y = 0; y < height; y++) {
    const py = y + 0.5;
    for (let x = 0; x < width; x++) {
      const px = x + 0.5;
      const index = y * width + x;

      let band = bands[0];
      if (bands.length > 1) {
        const v = -px * sin + py * cos - vMin;
        const slot = Math.min(bands.length - 1, Math.max(0, Math.floor(v / bandSpan)));
        // Blank gutter between bands: white artwork, zero gloss.
        if (gap > 0 && v - slot * bandSpan < gap) continue;
        band = bands[slot];
      }

      const { pitchPx, sagMm, baseMm, radiusMm } = band.geometry;
      const s = (px * cos + py * sin) / pitchPx + phase;
      const cell = Math.floor(s);
      const t = s - cell;

      // --- interlace: this strip's frame, sampled at the lenticule centre ---
      const frame = Math.min(frameCount - 1, Math.floor(t * frameCount));
      const shift = (cell + 0.5 - phase) * pitchPx - (px * cos + py * sin);
      const sx = (px + shift * cos) / width;
      const sy = (py + shift * sin) / height;
      sampleNormalized(frames[frame], sx, sy, pixel, index * 4);

      // --- lens profile: circular arc of radius R, sag `sagMm`, on the base ---
      const offset = (t - 0.5) * band.geometry.pitchMm;
      const arc = Math.sqrt(Math.max(0, radiusMm * radiusMm - offset * offset)) - (radiusMm - sagMm);
      const mm = baseMm + Math.max(0, arc);
      depth[index] = Math.round(Math.min(1, mm / depthScaleMm) * 65535);
    }
  }

  return { interlaced, depth, depthScaleMm, width, height, bands };
}

/** 8-bit greyscale view of a 16-bit depth map, for on-canvas preview. */
export function depthPreview(render: LenticularRender): RasterImage {
  const img = createImage(render.width, render.height, [0, 0, 0, 255]);
  for (let i = 0; i < render.depth.length; i++) {
    const v = render.depth[i] >>> 8;
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = v;
    img.data[i * 4 + 2] = v;
  }
  return img;
}

/** Human-readable geometry report for the node's Info output and its editor. */
export function describeGeometry(
  settings: LenticularSettings,
  geometry: LensGeometry,
  frameCount: number,
  size: OutputSize,
): string {
  const mm = (v: number) => v.toFixed(3);
  const stripPx = geometry.pitchPx / frameCount;
  const lines = [
    `${frameCount} frames · ${size.width}×${size.height} px @ ${settings.ppi} PPI`,
    `Lenticule pitch ${mm(geometry.pitchMm)} mm (${geometry.pitchPx.toFixed(2)} px), ${stripPx.toFixed(2)} px per frame strip`,
    `Lens sag ${mm(geometry.sagMm)} mm on a ${mm(geometry.baseMm)} mm base = ${mm(geometry.totalMm)} mm total`,
    `Radius ${mm(geometry.radiusMm)} mm · focus ${mm(geometry.focusMm)} mm below apex · viewing angle ${geometry.viewAngleDeg.toFixed(1)}°`,
  ];
  if (!geometry.feasible) {
    lines.push(
      `⚠ At ${settings.lpi} LPI / RI ${settings.ri} the lens cannot focus in ${mm(settings.heightMm)} mm — ` +
        `it focuses ${mm(geometry.focusMm)} mm down. Raise Height to ${mm(geometry.minHeightMm)} mm or raise LPI.`,
    );
  }
  if (stripPx < 4) {
    lines.push(
      `⚠ Only ${stripPx.toFixed(2)} px per frame strip — raise PPI, lower LPI, or use fewer frames.`,
    );
  }
  return lines.join('\n');
}
