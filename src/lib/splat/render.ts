// Rendering a Gaussian splat cloud through the print's own window.
//
// The camera here is the same one `render3d.ts` uses for meshes, and for the
// same reason: the eye slides sideways across the viewing cone and never
// rotates, so the sheet plane is common to every view and prints pin-sharp,
// while everything off it separates. See `projectToSheet` — the projection is
// literally that function, applied to a few hundred thousand ellipsoids instead
// of to triangle corners.
//
// What differs is what gets drawn. A splat has no surface and no edges: it is a
// 3D Gaussian, and its image is a 2D Gaussian obtained by pushing the 3D one
// through the projection's own derivative (the EWA construction — Zwicker et
// al.). So there is no depth buffer and no rasterised outline anywhere below;
// there is a sort, and then a lot of alpha blending, and the "surface" is
// wherever enough of them piled up.
//
// Three things make that affordable in JavaScript:
//
//   • The world → camera transform and the 3D covariances are built once for
//     the whole run, not once per view. They do not depend on the eye.
//   • The sort is a counting sort over 16-bit depth buckets — O(n) — because a
//     comparison sort of a million splats, per view, is the whole budget.
//   • The window camera only translates, so the cull and the sort are stable
//     across the run; nothing has to be rebuilt between views.
//
// This module is fetched on demand — see `nodes/splat.ts`.

import type { RasterImage, SplatValue, TransformValue } from '../../types';
import type { ChunkProgress } from '../chunked';
import { gridCells } from '../lenticular';
import { clampSetbackMm, eyeOffsetsMm } from '../render3d';
import { cameraBasis } from './cloud';

export interface SplatViewOptions {
  /** Where the camera stands, and how many scene units a millimetre is. */
  camera: TransformValue;
  /** The sheet: physical size, and the raster each view is drawn at. */
  widthMm: number;
  heightMm: number;
  widthPx: number;
  /** How far the viewer stands from the print. */
  viewDistanceMm: number;
  /** The cone the run spans. */
  coneDeg: number;
  /** A horizontal run of `views`, or a `grid`×`grid` square of them. */
  layout: '1d' | '2d';
  views: number;
  grid: number;
  /** Paper colour, showing through wherever the cloud is thin. */
  background: [number, number, number];
  /** Draw at this multiple and box-filter down. */
  supersample?: number;
  /** Render at most this many splats — the editor's preview lever. */
  splatBudget?: number;
  /**
   * Splats closer to the eye than this are dropped. A splat that passes through
   * the eye projects to infinity, and a capture is always full of floaters that
   * would do exactly that.
   */
  nearClipMm?: number;
}

export interface SplatViewRender {
  /** The views: left eye first for a run, {@link gridCells} order for a grid. */
  views: RasterImage[];
  /** Eye positions, mm off-axis. */
  offsetsMm: number[];
  /** Composite depth of the middle view, white = nearest. */
  depth: RasterImage;
  /** Fraction of the middle view the cloud actually covered, 0–1. */
  coverage: number;
  /** Where the drawn cloud sits relative to the sheet, mm behind it. */
  nearMm: number;
  farMm: number;
  /** Splats drawn per view after the cull, and the cull's input. */
  drawn: number;
  considered: number;
}

/** Smallest a splat may be drawn, in px². Below this it aliases into fireflies. */
const MIN_VARIANCE_PX = 0.3;

/** Widest a single splat may be drawn. A degenerate one would otherwise fill the frame. */
const MAX_RADIUS_PX = 512;

/** Depth buckets the counting sort uses. */
const DEPTH_BUCKETS = 1 << 16;

/** The cloud in camera space: positions in mm, covariances in mm², eye-independent. */
export interface CameraSpaceCloud {
  count: number;
  /** [x, y, zSheet] per splat, mm — zSheet is signed distance in front of the sheet. */
  xyz: Float32Array;
  /** Upper triangle of each 3×3 covariance: 00, 01, 02, 11, 12, 22. */
  cov: Float32Array;
  colours: Uint8ClampedArray;
}

/**
 * Move the cloud into the camera's frame, in millimetres of print.
 *
 * Two changes of basis at once, which is why it is worth doing in one pass: the
 * rotation into camera axes, and the division by `scale` that turns scene units
 * into millimetres on the sheet. After this the print geometry is the only
 * geometry left — the scene's own units never appear again.
 *
 * The covariance goes through the same transform, but quadratically: Σ' = MΣMᵀ.
 * Rather than build Σ and multiply, `M` is folded straight into the ellipsoid's
 * own axes (basis · rotation, columns scaled by the radii), and Σ' = AAᵀ falls
 * out — a third of the arithmetic, and no intermediate to lose precision in.
 */
export function toCameraSpace(cloud: SplatValue, o: SplatViewOptions, budget?: number): CameraSpaceCloud {
  const step = budget && budget < cloud.count ? cloud.count / budget : 1;
  const count = step > 1 ? Math.floor(cloud.count / step) : cloud.count;
  const B = cameraBasis(o.camera.rotationDeg);
  const [cx, cy, cz] = o.camera.position;
  const perMm = 1 / Math.max(1e-9, o.camera.scale);
  const D = Math.max(1e-6, o.viewDistanceMm);

  const xyz = new Float32Array(count * 3);
  const cov = new Float32Array(count * 6);
  const colours = new Uint8ClampedArray(count * 4);

  for (let i = 0; i < count; i++) {
    const s = step > 1 ? Math.min(cloud.count - 1, Math.floor(i * step)) : i;
    const wx = (cloud.positions[s * 3] - cx) * perMm;
    const wy = (cloud.positions[s * 3 + 1] - cy) * perMm;
    const wz = (cloud.positions[s * 3 + 2] - cz) * perMm;
    // Camera axes: +x right, +y up, −z forward. A point D mm in front of the
    // camera therefore lands on the sheet plane, which is what makes the print
    // and the preview the same picture.
    const qx = B[0] * wx + B[1] * wy + B[2] * wz;
    const qy = B[3] * wx + B[4] * wy + B[5] * wz;
    const qz = B[6] * wx + B[7] * wy + B[8] * wz;
    xyz[i * 3] = qx;
    xyz[i * 3 + 1] = qy;
    xyz[i * 3 + 2] = D + qz;

    // A = B · R, columns then scaled by the ellipsoid radii.
    const rx = cloud.rotations[s * 4],
      ry = cloud.rotations[s * 4 + 1],
      rz = cloud.rotations[s * 4 + 2],
      rw = cloud.rotations[s * 4 + 3];
    const r00 = 1 - 2 * (ry * ry + rz * rz),
      r01 = 2 * (rx * ry - rw * rz),
      r02 = 2 * (rx * rz + rw * ry);
    const r10 = 2 * (rx * ry + rw * rz),
      r11 = 1 - 2 * (rx * rx + rz * rz),
      r12 = 2 * (ry * rz - rw * rx);
    const r20 = 2 * (rx * rz - rw * ry),
      r21 = 2 * (ry * rz + rw * rx),
      r22 = 1 - 2 * (rx * rx + ry * ry);

    const sx = cloud.scales[s * 3] * perMm,
      sy = cloud.scales[s * 3 + 1] * perMm,
      sz = cloud.scales[s * 3 + 2] * perMm;

    const a00 = (B[0] * r00 + B[1] * r10 + B[2] * r20) * sx;
    const a01 = (B[0] * r01 + B[1] * r11 + B[2] * r21) * sy;
    const a02 = (B[0] * r02 + B[1] * r12 + B[2] * r22) * sz;
    const a10 = (B[3] * r00 + B[4] * r10 + B[5] * r20) * sx;
    const a11 = (B[3] * r01 + B[4] * r11 + B[5] * r21) * sy;
    const a12 = (B[3] * r02 + B[4] * r12 + B[5] * r22) * sz;
    const a20 = (B[6] * r00 + B[7] * r10 + B[8] * r20) * sx;
    const a21 = (B[6] * r01 + B[7] * r11 + B[8] * r21) * sy;
    const a22 = (B[6] * r02 + B[7] * r12 + B[8] * r22) * sz;

    cov[i * 6] = a00 * a00 + a01 * a01 + a02 * a02;
    cov[i * 6 + 1] = a00 * a10 + a01 * a11 + a02 * a12;
    cov[i * 6 + 2] = a00 * a20 + a01 * a21 + a02 * a22;
    cov[i * 6 + 3] = a10 * a10 + a11 * a11 + a12 * a12;
    cov[i * 6 + 4] = a10 * a20 + a11 * a21 + a12 * a22;
    cov[i * 6 + 5] = a20 * a20 + a21 * a21 + a22 * a22;

    for (let a = 0; a < 4; a++) colours[i * 4 + a] = cloud.colours[s * 4 + a];
  }
  return { count, xyz, cov, colours };
}

/** One view's worth of scratch, reused across the run. */
interface Buffers {
  order: Uint32Array;
  sorted: Uint32Array;
  keys: Uint16Array;
  counts: Uint32Array;
  rgb: Float32Array;
  alpha: Float32Array;
  depth: Float32Array;
}

// Allocated once for the whole run, not once per view: a 15×15 grid would
// otherwise churn a few megabytes of typed array 225 times over.
const buffersFor = (n: number, px: number): Buffers => ({
  order: new Uint32Array(n),
  sorted: new Uint32Array(n),
  keys: new Uint16Array(n),
  counts: new Uint32Array(DEPTH_BUCKETS + 1),
  rgb: new Float32Array(px * 3),
  alpha: new Float32Array(px),
  depth: new Float32Array(px),
});

/** What one view's blend produced, before it becomes a raster. */
interface ViewAccum {
  drawn: number;
  nearMm: number;
  farMm: number;
}

/**
 * Draw one view: cull, sort back-to-front, and blend.
 *
 * Back-to-front with a plain `over` is the right order here even though
 * front-to-back would let the blend stop early, because the same operator then
 * composites the *depth* for free — `d = z·α + d·(1−α)` alongside the colour
 * gives an alpha-weighted depth that tracks whatever the eye would call the
 * surface, with no second pass and no arbitrary "first splat over 0.5" rule.
 */
function drawView(
  cam: CameraSpaceCloud,
  o: SplatViewOptions,
  buf: Buffers,
  eyeX: number,
  eyeY: number,
  w: number,
  h: number,
): ViewAccum {
  const D = Math.max(1e-6, o.viewDistanceMm);
  const nearClip = Math.max(0.001, o.nearClipMm ?? 1);
  const pxPerMm = w / Math.max(1e-6, o.widthMm);
  const halfW = o.widthMm / 2;
  // The raster's aspect is the sheet's, by construction — h/w = heightMm/widthMm
  // — so one pxPerMm serves both axes.
  const halfH = o.heightMm / 2;
  const { order, keys, counts } = buf;

  // --- cull, and bucket by depth in the same pass ------------------------
  let n = 0;
  let zMin = Infinity;
  let zMax = -Infinity;
  for (let i = 0; i < cam.count; i++) {
    if (cam.colours[i * 4 + 3] === 0) continue;
    const z = cam.xyz[i * 3 + 2];
    // Distance in front of the eye is D − z; anything at or through the eye
    // plane projects to infinity.
    if (D - z < nearClip) continue;
    const t = D / (D - z);
    const X = eyeX + t * (cam.xyz[i * 3] - eyeX);
    const Y = eyeY + t * (cam.xyz[i * 3 + 1] - eyeY);
    // A generous frame: a splat centred outside can still reach in, and the
    // margin is cheaper than the arithmetic to work out by how much.
    if (X < -halfW * 2 || X > halfW * 2 || Y < -halfH * 2 || Y > halfH * 2) continue;
    order[n] = i;
    if (z < zMin) zMin = z;
    if (z > zMax) zMax = z;
    n++;
  }
  if (n === 0) return { drawn: 0, nearMm: 0, farMm: 0 };

  // --- counting sort, farthest first ------------------------------------
  const span = Math.max(1e-6, zMax - zMin);
  counts.fill(0);
  for (let k = 0; k < n; k++) {
    // Smallest z is farthest behind the sheet, so it must be drawn first.
    const q = Math.min(DEPTH_BUCKETS - 1, ((cam.xyz[order[k] * 3 + 2] - zMin) / span) * (DEPTH_BUCKETS - 1)) | 0;
    keys[k] = q;
    counts[q + 1]++;
  }
  for (let b = 0; b < DEPTH_BUCKETS; b++) counts[b + 1] += counts[b];
  const sorted = buf.sorted;
  for (let k = 0; k < n; k++) sorted[counts[keys[k]]++] = order[k];

  // --- blend -------------------------------------------------------------
  const { rgb, alpha, depth } = buf;
  rgb.fill(0);
  alpha.fill(0);
  depth.fill(0);

  for (let k = 0; k < n; k++) {
    const i = sorted[k];
    const z = cam.xyz[i * 3 + 2];
    const t = D / (D - z);
    const X = eyeX + t * (cam.xyz[i * 3] - eyeX);
    const Y = eyeY + t * (cam.xyz[i * 3 + 1] - eyeY);

    // The projection's Jacobian at this point. ∂X/∂x is t; the interesting
    // term is ∂X/∂z = (x − ex)·t²/D, which is what shears a splat as it moves
    // off-axis and is the whole reason a splat renderer needs the derivative
    // rather than just the projection.
    const j02 = ((cam.xyz[i * 3] - eyeX) * t * t) / D;
    const j12 = ((cam.xyz[i * 3 + 1] - eyeY) * t * t) / D;
    const c00 = cam.cov[i * 6],
      c01 = cam.cov[i * 6 + 1],
      c02 = cam.cov[i * 6 + 2],
      c11 = cam.cov[i * 6 + 3],
      c12 = cam.cov[i * 6 + 4],
      c22 = cam.cov[i * 6 + 5];

    const s = pxPerMm * pxPerMm;
    let a = (t * t * c00 + 2 * t * j02 * c02 + j02 * j02 * c22) * s + MIN_VARIANCE_PX;
    let b = (t * t * c11 + 2 * t * j12 * c12 + j12 * j12 * c22) * s + MIN_VARIANCE_PX;
    let c = (t * t * c01 + t * j12 * c02 + j02 * t * c12 + j02 * j12 * c22) * s;

    let det = a * b - c * c;
    if (!(det > 1e-12)) {
      // Edge-on to the point of being a line: draw it as a small round dot
      // rather than dropping it, or thin structures dissolve at grazing angles.
      a = b = MIN_VARIANCE_PX * 2;
      c = 0;
      det = a * b;
    }
    // Conic = Σ⁻¹, the quadratic form the falloff is evaluated with.
    const k00 = b / det,
      k01 = -c / det,
      k11 = a / det;

    const lambda = (a + b) / 2 + Math.sqrt(Math.max(0, ((a - b) / 2) ** 2 + c * c));
    const radius = Math.min(MAX_RADIUS_PX, Math.ceil(3 * Math.sqrt(Math.max(lambda, MIN_VARIANCE_PX))));

    const cxPx = (X + halfW) * pxPerMm;
    const cyPx = (halfH - Y) * pxPerMm; // +Y is up, rows count down
    const x0 = Math.max(0, Math.floor(cxPx - radius));
    const x1 = Math.min(w - 1, Math.ceil(cxPx + radius));
    const y0 = Math.max(0, Math.floor(cyPx - radius));
    const y1 = Math.min(h - 1, Math.ceil(cyPx + radius));
    if (x1 < x0 || y1 < y0) continue;

    const opacity = cam.colours[i * 4 + 3] / 255;
    const cr = cam.colours[i * 4] / 255;
    const cg = cam.colours[i * 4 + 1] / 255;
    const cb = cam.colours[i * 4 + 2] / 255;

    for (let py = y0; py <= y1; py++) {
      const dy = py + 0.5 - cyPx;
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - cxPx;
        const power = 0.5 * (k00 * dx * dx + 2 * k01 * dx * dy + k11 * dy * dy);
        if (power > 8) continue; // e⁻⁸ ≈ 0.0003 — below a colour step
        const av = opacity * Math.exp(-power);
        if (av < 1 / 512) continue;
        const p = py * w + px;
        const inv = 1 - av;
        rgb[p * 3] = cr * av + rgb[p * 3] * inv;
        rgb[p * 3 + 1] = cg * av + rgb[p * 3 + 1] * inv;
        rgb[p * 3 + 2] = cb * av + rgb[p * 3 + 2] * inv;
        alpha[p] = av + alpha[p] * inv;
        depth[p] = z * av + depth[p] * inv;
      }
    }
  }
  return { drawn: n, nearMm: -zMax, farMm: -zMin };
}

/** Composite buffers → a raster, over the paper colour, box-filtered down. */
function resolve(buf: Buffers, w: number, h: number, ss: number, bg: [number, number, number]): RasterImage {
  const ow = Math.max(1, Math.round(w / ss));
  const oh = Math.max(1, Math.round(h / ss));
  const out: RasterImage = {
    kind: 'image',
    width: ow,
    height: oh,
    data: new Uint8ClampedArray(ow * oh * 4),
  };
  const n = ss * ss;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0,
        g = 0,
        b = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const p = Math.min(h - 1, y * ss + sy) * w + Math.min(w - 1, x * ss + sx);
          const a = buf.alpha[p];
          // Over the paper: a splat print has no transparency to give.
          r += buf.rgb[p * 3] * 255 + (1 - a) * bg[0];
          g += buf.rgb[p * 3 + 1] * 255 + (1 - a) * bg[1];
          b += buf.rgb[p * 3 + 2] * 255 + (1 - a) * bg[2];
        }
      }
      const i = (y * ow + x) * 4;
      out.data[i] = r / n;
      out.data[i + 1] = g / n;
      out.data[i + 2] = b / n;
      out.data[i + 3] = 255;
    }
  }
  return out;
}

/** The composite depth as a raster, white = nearest, black where nothing landed. */
function resolveDepth(buf: Buffers, w: number, h: number, ss: number): { depth: RasterImage; coverage: number } {
  const ow = Math.max(1, Math.round(w / ss));
  const oh = Math.max(1, Math.round(h / ss));
  let lo = Infinity;
  let hi = -Infinity;
  let covered = 0;
  for (let p = 0; p < w * h; p++) {
    if (buf.alpha[p] < 0.02) continue;
    covered++;
    const z = buf.depth[p] / buf.alpha[p];
    if (z < lo) lo = z;
    if (z > hi) hi = z;
  }
  const span = hi - lo || 1;
  const depth: RasterImage = {
    kind: 'image',
    width: ow,
    height: oh,
    data: new Uint8ClampedArray(ow * oh * 4),
  };
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const p = Math.min(h - 1, y * ss) * w + Math.min(w - 1, x * ss);
      const a = buf.alpha[p];
      // Larger z is nearer the eye, and white is near — matching every other
      // depth output in the tool, so the gloss chain reads it unchanged.
      const v = a < 0.02 ? 0 : ((buf.depth[p] / a - lo) / span) * 255;
      const i = (y * ow + x) * 4;
      depth.data[i] = depth.data[i + 1] = depth.data[i + 2] = v;
      depth.data[i + 3] = 255;
    }
  }
  return { depth, coverage: covered / (w * h) };
}

/** Eye positions of the run, in the order the views come back. */
export function splatEyeOffsets(o: SplatViewOptions): { x: number; y: number }[] {
  if (o.layout === '2d') {
    const grid = Math.max(1, Math.round(o.grid));
    const offsets = eyeOffsetsMm(grid, o.coneDeg, o.viewDistanceMm);
    return gridCells(grid).map((_, idx) => ({
      x: offsets[idx % grid],
      // Row 0 is `Up`: the eye is above the sheet, so +y.
      y: -offsets[Math.floor(idx / grid)],
    }));
  }
  return eyeOffsetsMm(Math.max(1, Math.round(o.views)), o.coneDeg, o.viewDistanceMm).map((x) => ({ x, y: 0 }));
}

/**
 * Render the whole run, one view at a time.
 *
 * A view is the chunk, as everywhere else in the tool: it is one full pass over
 * the cloud, it is the unit worth counting ("view 37 of 225"), and a 15×15 grid
 * of a million splats is long enough that nobody should have to watch a frozen
 * tab through it.
 */
export function* splatViewChunks(
  cloud: SplatValue,
  o: SplatViewOptions,
): Generator<ChunkProgress, SplatViewRender> {
  const ss = Math.min(3, Math.max(1, Math.round(o.supersample ?? 1)));
  const w = Math.max(8, Math.round(o.widthPx)) * ss;
  const h = Math.max(8, Math.round((o.widthPx * o.heightMm) / Math.max(1e-6, o.widthMm))) * ss;
  const cam = toCameraSpace(cloud, o, o.splatBudget);
  const buf = buffersFor(cam.count, w * h);
  const eyes = splatEyeOffsets(o);
  const mid = eyes.length >> 1;

  const views: RasterImage[] = [];
  let depth: RasterImage | undefined;
  let coverage = 0;
  let nearMm = 0;
  let farMm = 0;
  let drawn = 0;

  for (let i = 0; i < eyes.length; i++) {
    const acc = drawView(cam, o, buf, eyes[i].x, eyes[i].y, w, h);
    views.push(resolve(buf, w, h, ss, o.background));
    if (i === mid) {
      const d = resolveDepth(buf, w, h, ss);
      depth = d.depth;
      coverage = d.coverage;
      nearMm = acc.nearMm;
      farMm = acc.farMm;
      drawn = acc.drawn;
    }
    yield { done: views.length, total: eyes.length, what: 'Views' };
  }

  return {
    views,
    offsetsMm: eyes.map((e) => e.x),
    depth: depth ?? views[0],
    coverage,
    nearMm,
    farMm,
    drawn,
    considered: cam.count,
  };
}

/** {@link splatViewChunks}, run straight through. */
export function renderSplatViews(cloud: SplatValue, o: SplatViewOptions): SplatViewRender {
  const gen = splatViewChunks(cloud, o);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

/**
 * One head-on view, for the camera editor.
 *
 * Deliberately the same code path as the print: what you frame while flying is
 * the middle view of the run, not an approximation of it. `splatBudget` is the
 * only thing that differs, and it only thins the cloud — a preview at 150k
 * splats is the same picture, grainier.
 */
export function renderSplatPreview(
  cloud: SplatValue,
  camera: TransformValue,
  o: Partial<SplatViewOptions> & { widthPx: number; widthMm: number; heightMm: number },
): RasterImage {
  return renderSplatViews(cloud, {
    camera,
    viewDistanceMm: 400,
    coneDeg: 0,
    layout: '1d',
    views: 1,
    grid: 1,
    background: [255, 255, 255],
    supersample: 1,
    nearClipMm: 1,
    ...o,
  }).views[0];
}

/** Where the drawn cloud ended up relative to the sheet, for the reports. */
export function describePlacementOf(render: SplatViewRender): string {
  const near = render.nearMm;
  const far = render.farMm;
  if (near <= 0 && far <= 0) {
    return `Everything drawn stands in front of the sheet (${(-near).toFixed(0)}–${(-far).toFixed(0)} mm) — ` +
      'the print is one big pop-out and the paper edge will cut through it. Move the camera back.';
  }
  if (near < 0) {
    return (
      `The cloud reaches ${(-near).toFixed(0)} mm out through the plate and ${far.toFixed(0)} mm into it. ` +
      'Keep whatever is in front clear of the sheet edges.'
    );
  }
  return `The cloud sits ${near.toFixed(0)}–${far.toFixed(0)} mm behind the sheet, all of it — a window.`;
}

/** Keep a negative setback sane, re-exported so the nodes need one import. */
export { clampSetbackMm };
