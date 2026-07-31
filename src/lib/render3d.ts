// Rendering a triangle mesh into the grid of views a 2D lens print needs.
//
// A software z-buffer rasteriser rather than WebGL, for three reasons: it is
// pure and unit-testable like the rest of the lens stack (the gloss preview is
// the one WebGL exception and it cannot be tested at all), it is deterministic,
// and it is cheap enough not to matter — a lens grid resolves *one pixel per
// lenslet per view*, about 177×153 at the tool's defaults, so these are small
// images however big the mesh is.
//
// The camera is the part that has to be right, and it is not the obvious one:
//
//   • The eye TRANSLATES; it never rotates. Aiming a camera at the subject for
//     each view ("toe-in") keystones every view differently and introduces
//     vertical parallax between them, which under a lens grid reads as a wobble
//     as your head moves. Here all views share one view direction and one focal
//     plane — the sheet — and only the eye position moves, so each view is a
//     shear of the same projection.
//
//   • That focal plane is the sheet, and it is where the print is sharp. A point
//     lying on it projects to the same place in every view (see the algebra in
//     `projectToSheet`), so it cannot smear no matter how far you tilt. Depth is
//     bought entirely by how far the subject strays off that plane.
//
//   • The grid spans the lens's own viewing cone. Place the views wider than the
//     cone and the print jumps at the flip; narrower and you have thrown depth
//     away. `eyeOffsetsMm` takes the cone `lensGeometry()` solved.
//
//   • The subject stands entirely BEHIND the sheet, in both renderers. The sheet
//     is a window you look into rather than a surface things float in front of;
//     the reasons fill the section at the foot of this file, and they apply to a
//     grid in two axes just as they do to a 1D run in one.
//
// Coordinates: the sheet is the z = 0 plane, x right, y up, and the viewer is at
// positive z. Millimetres throughout, so every setting is a physical one.

import type { RasterImage, StlValue } from '../types';
import type { ChunkProgress } from './chunked';
import { createImage } from './image';
import { meshBounds } from './stl';

/** Light direction and how much of the surface is lit regardless of it. */
export interface Shading {
  /** Where the light comes from, degrees: 0 = straight on, +x right, +y up. */
  lightAzimuthDeg: number;
  lightElevationDeg: number;
  /** Floor on the diffuse term, 0–1, so a face turned away is not pure black. */
  ambient: number;
  /**
   * Object colour, 0–255 per channel. The fallback: a texture or the mesh's own
   * vertex colours replace it rather than tinting it, so a photographic texture
   * is not quietly dyed by whatever this happens to be set to.
   */
  colour: [number, number, number];
  /** Sheet colour where nothing is hit. */
  background: [number, number, number];
}

/** Everything both renderers need; the view layout is what differs. */
export interface ViewRenderOptions {
  /** Printed sheet size in mm — also the aspect of every view rendered. */
  widthMm: number;
  heightMm: number;
  /** Pixels across one view. Height follows the sheet aspect. */
  widthPx: number;
  /** How far away the print is meant to be looked at, mm. */
  viewDistanceMm: number;
  /** Total depth the subject occupies, mm, centred on the sheet plane. */
  depthMm: number;
  /** Full angle the view grid spans — the lens's viewing cone, degrees. */
  coneDeg: number;
  /** Model rotation applied before fitting, degrees, X then Y then Z. */
  rotationDeg: [number, number, number];
  /** Fraction of the sheet left empty around the subject, 0–0.4. */
  margin: number;
  /** Render this many times oversampled on each axis, then box-filter down. */
  supersample: number;
  shading: Shading;
  /**
   * Texture map, sampled through the mesh's uvs. Ignored by a mesh that has no
   * uvs — an STL never does, and an OBJ only if it was exported unmapped.
   */
  texture?: RasterImage;
  /**
   * Slide the whole subject along z at projection time, mm. 0 straddles the
   * sheet plane (half in front, half behind); negative puts it behind the
   * sheet, which is what makes the print a window rather than a hologram.
   * Applied after `zScale`, so it is a distance in printed millimetres.
   */
  zOffsetMm?: number;
  /**
   * The z plane, mm, at which the subject is fitted to the sheet — negative
   * for behind it. A subject behind the window projects smaller by
   * D/(D − z), so fitting it *at the sheet* and then pushing it back leaves it
   * short of the frame. Setting this scales the fit by (D − z)/D so the
   * subject fills the window at that plane instead. 0 is the old behaviour.
   */
  fitAtZMm?: number;
}

export interface ViewGridOptions extends ViewRenderOptions {
  /** Views per side: 3 renders a 3×3 = 9 view grid. */
  grid: number;
  /**
   * Where the nearest point of the subject sits relative to the sheet, mm
   * *behind* it. 0 puts it right against the glass — the plain window — and
   * more sinks the whole subject further in.
   *
   * Negative brings it out through the plate: at −2 the nearest 2 mm of the
   * subject stands in front of the sheet and everything else is still behind
   * it. See {@link clampSetbackMm} and the window section at the foot of this
   * file for what that costs.
   */
  setbackMm: number;
}

/** A vertex ready to project: world millimetres, sheet plane at z = 0. */
type Verts = Float32Array;

export interface PreparedMesh {
  /**
   * Vertices rotated, centred and fitted to the sheet with their proportions
   * intact — a cube is still a cube. Shading reads normals from these.
   */
  verts: Verts;
  /**
   * Factor applied to z at *projection* time only, to bring the subject's
   * parallax inside what the lens can carry.
   *
   * Squashing the geometry itself would squash its normals with it, and a cube
   * flattened to the 2 mm a lens grid can show shades exactly like the 2 mm slab
   * it has become — three faces at one grey, no solidity at all. Compressing
   * only the projection keeps every shading cue at full strength while the
   * parallax stays printable. That is not a cheat; it is what a bas-relief does,
   * and it has been the trick since Donatello.
   */
  zScale: number;
  /** Carried straight through from the mesh — the fit never reorders triangles. */
  uvs?: Float32Array;
  colours?: Uint8Array;
}

/** Run a chunked view render straight through, ignoring the progress. */
function drainViews<T>(gen: Generator<ChunkProgress, T>): T {
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}

export const MIN_VIEW_PX = 16;
export const MAX_VIEW_PX = 4096;

/**
 * How far in front of the sheet the near face may be brought, as a fraction of
 * the viewing distance. A negative setback pops the subject out of the plate,
 * which is a real thing to want; but z/(D − z) runs away as z approaches the
 * eye, so a subject a quarter of the way to the viewer already moves 33% more
 * per eye step than the same distance behind the glass, and past that the
 * projection stops meaning anything.
 */
export const MAX_POPOUT_FRACTION = 0.25;

/** Keep a negative setback inside {@link MAX_POPOUT_FRACTION} of the viewing distance. */
export const clampSetbackMm = (setbackMm: number, viewDistanceMm: number): number =>
  Math.max(-MAX_POPOUT_FRACTION * Math.max(1e-6, viewDistanceMm), setbackMm);

/**
 * How far the eye sits off the sheet's axis for each column (or row) of the
 * view grid, in mm, at the given viewing distance.
 *
 * The grid spans the whole cone, so the outermost views sit at exactly ±cone/2
 * and the middle of an odd grid sits dead ahead. `tan` because these are
 * positions on a plane, not arc lengths: at 57° and 400 mm the outer eye is
 * 217 mm off-axis, not 199 mm.
 */
export function eyeOffsetsMm(grid: number, coneDeg: number, viewDistanceMm: number): number[] {
  const n = Math.max(1, Math.round(grid));
  const half = (Math.max(0, coneDeg) * Math.PI) / 360;
  if (n === 1) return [0];
  return Array.from({ length: n }, (_, i) => {
    const frac = (i / (n - 1)) * 2 - 1; // -1 … +1
    return Math.tan(frac * half) * Math.max(1e-6, viewDistanceMm);
  });
}

/**
 * Where the ray from an eye to a point crosses the sheet, and how near the eye
 * that point is.
 *
 * With the eye at (ex, ey, D) and the sheet at z = 0, the ray reaches the sheet
 * at t = D / (D − z), so:
 *
 *   X = ex + t·(x − ex)        Y = ey + t·(y − ey)
 *
 * At z = 0, t = 1 and X = x exactly — the eye drops out, which is the whole
 * point: the sheet plane is common to every view. Off the plane, t ≠ 1 and the
 * eye term survives as parallax, opposite in sign either side of the sheet.
 *
 * `t` doubles as the depth key. It is 1/w for this projection, so it varies
 * *linearly across the triangle in screen space* — which is what lets the
 * rasteriser interpolate it with plain barycentric weights. Larger is nearer.
 */
export function projectToSheet(
  x: number,
  y: number,
  z: number,
  ex: number,
  ey: number,
  distanceMm: number,
): { X: number; Y: number; t: number } {
  const t = distanceMm / (distanceMm - z);
  return { X: ex + t * (x - ex), Y: ey + t * (y - ey), t };
}

/**
 * Rotate, centre and scale the mesh so it fills the sheet with `margin` to
 * spare, keeping its proportions — and work out how much its depth has to be
 * compressed at projection time to fit `depthMm` (see {@link PreparedMesh}).
 */
export function prepareVertices(stl: StlValue, o: ViewRenderOptions): PreparedMesh {
  const [rx, ry, rz] = o.rotationDeg.map((d) => (d * Math.PI) / 180);
  const [cx, sx] = [Math.cos(rx), Math.sin(rx)];
  const [cy, sy] = [Math.cos(ry), Math.sin(ry)];
  const [cz, sz] = [Math.cos(rz), Math.sin(rz)];

  const n = stl.triangleCount * 9;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 3) {
    let px = stl.triangles[i];
    let py = stl.triangles[i + 1];
    let pz = stl.triangles[i + 2];
    // X, then Y, then Z — the order the config fields are listed in.
    let ty = py * cx - pz * sx;
    let tz = py * sx + pz * cx;
    py = ty;
    pz = tz;
    let tx = px * cy + pz * sy;
    tz = -px * sy + pz * cy;
    px = tx;
    pz = tz;
    tx = px * cz - py * sz;
    ty = px * sz + py * cz;
    out[i] = tx;
    out[i + 1] = ty;
    out[i + 2] = pz;
  }

  // Fit the rotated result, not the model: rotating changes the silhouette.
  const rotated: StlValue = { kind: 'stl', triangleCount: stl.triangleCount, triangles: out };
  const b = meshBounds(rotated);
  const margin = Math.min(0.4, Math.max(0, o.margin));
  const fitW = Math.max(0.01, o.widthMm) * (1 - margin);
  const fitH = Math.max(0.01, o.heightMm) * (1 - margin);
  // Perspective compensation for a subject that will sit off the sheet plane:
  // seen from the centre eye a point at z projects to x·D/(D − z), so a subject
  // pushed behind the window comes out smaller than the fit intended. Scaling
  // by the reciprocal makes it fill the window at that plane. See fitAtZMm.
  const fitAtZ = o.fitAtZMm ?? 0;
  const D = Math.max(1e-6, o.viewDistanceMm);
  const perspective = Math.max(1e-6, (D - fitAtZ) / D);
  const planar = Math.min(fitW / (b.size[0] || 1e-6), fitH / (b.size[1] || 1e-6)) * perspective;

  // One scale for all three axes: the model keeps its shape.
  for (let i = 0; i < n; i += 3) {
    out[i] = (out[i] - b.centre[0]) * planar;
    out[i + 1] = (out[i + 1] - b.centre[1]) * planar;
    out[i + 2] = (out[i + 2] - b.centre[2]) * planar;
  }

  // How much of that true depth the print can actually carry. A flat model (a
  // plate, a relief) has no depth to compress: leave it on the sheet rather than
  // dividing by zero and flinging it at the viewer.
  const trueDepth = b.size[2] * planar;
  const zScale = trueDepth > 1e-6 ? Math.max(0, o.depthMm) / trueDepth : 0;
  return { verts: out, zScale, uvs: stl.uvs, colours: stl.colours };
}

/** Unit normal of a triangle, from its winding. */
function faceNormal(v: Verts, b: number): [number, number, number] {
  const ux = v[b + 3] - v[b];
  const uy = v[b + 4] - v[b + 1];
  const uz = v[b + 5] - v[b + 2];
  const vx = v[b + 6] - v[b];
  const vy = v[b + 7] - v[b + 1];
  const vz = v[b + 8] - v[b + 2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

function lightVector(s: Shading): [number, number, number] {
  const az = (s.lightAzimuthDeg * Math.PI) / 180;
  const el = (s.lightElevationDeg * Math.PI) / 180;
  return [Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)];
}

/** Bilinear sample of a texture at OBJ-convention uv (0–1, origin bottom-left). */
function sampleTexture(img: RasterImage, u: number, v: number, out: [number, number, number]): void {
  // Wrap, so uv outside 0–1 tiles rather than smearing the edge pixel.
  const fu = u - Math.floor(u);
  // OBJ counts v up from the bottom; raster rows count down from the top.
  const fv = 1 - (v - Math.floor(v));
  const x = fu * img.width - 0.5;
  const y = fv * img.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const tx = x - x0;
  const ty = y - y0;
  const wrapX = (i: number) => ((i % img.width) + img.width) % img.width;
  const wrapY = (i: number) => ((i % img.height) + img.height) % img.height;
  const i00 = (wrapY(y0) * img.width + wrapX(x0)) * 4;
  const i10 = (wrapY(y0) * img.width + wrapX(x0 + 1)) * 4;
  const i01 = (wrapY(y0 + 1) * img.width + wrapX(x0)) * 4;
  const i11 = (wrapY(y0 + 1) * img.width + wrapX(x0 + 1)) * 4;
  for (let c = 0; c < 3; c++) {
    const top = img.data[i00 + c] * (1 - tx) + img.data[i10 + c] * tx;
    const bottom = img.data[i01 + c] * (1 - tx) + img.data[i11 + c] * tx;
    out[c] = top * (1 - ty) + bottom * ty;
  }
}

/**
 * Render one view: eye offset (ex, ey), everything else from `o`.
 *
 * Flat shading off the winding normal, and the diffuse term is |N·L| rather
 * than max(N·L, 0) — with backfaces drawn rather than culled. Exported STLs
 * are notorious for inconsistent winding, and a hole or a black patch in one
 * view of nine is far worse than a slightly flat-looking backface: a missing
 * patch in one view means one whole view of the print is wrong there.
 *
 * Surface colour comes from the first of these the mesh actually has: the
 * texture wired to the node (needs uvs), the mesh's own vertex colours, or the
 * flat material colour. Both of the first two vary per pixel, so they are
 * interpolated *perspective-correctly*: `t` is 1/w for this projection, so an
 * attribute times `t` is what varies linearly across the triangle in screen
 * space, and dividing the interpolated product by the interpolated `t` puts it
 * back. Interpolating uv directly would swim visibly across a tilted face.
 */
function renderOne(mesh: PreparedMesh, triangleCount: number, o: ViewRenderOptions, ex: number, ey: number) {
  const v = mesh.verts;
  const uvs = o.texture ? mesh.uvs : undefined;
  const colours = uvs ? undefined : mesh.colours;
  const texel: [number, number, number] = [0, 0, 0];
  const ss = Math.min(4, Math.max(1, Math.round(o.supersample)));
  const w = Math.max(1, Math.round(o.widthPx)) * ss;
  const h = Math.max(1, Math.round((o.widthPx * o.heightMm) / Math.max(0.01, o.widthMm))) * ss;
  const D = Math.max(1e-6, o.viewDistanceMm);
  const [lx, ly, lz] = lightVector(o.shading);
  const { colour, background, ambient } = o.shading;
  const amb = Math.min(1, Math.max(0, ambient));

  const rgb = new Uint8ClampedArray(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = background[0];
    rgb[i * 3 + 1] = background[1];
    rgb[i * 3 + 2] = background[2];
  }
  const key = new Float32Array(w * h); // 0 = nothing yet; larger t = nearer

  // Sheet millimetres → pixels. y flips: +y is up, rows run down.
  const pxPerMmX = w / Math.max(0.01, o.widthMm);
  const pxPerMmY = h / Math.max(0.01, o.heightMm);

  const zOffset = o.zOffsetMm ?? 0;
  const sx = [0, 0, 0];
  const sy = [0, 0, 0];
  const st = [0, 0, 0];
  for (let tri = 0; tri < triangleCount; tri++) {
    const b = tri * 9;
    let behind = false;
    for (let c = 0; c < 3; c++) {
      // z compressed here and only here — the normal below still comes off the
      // model's true shape. See PreparedMesh. The offset puts the subject
      // behind the window when there is one; it is a printed-mm distance, so it
      // rides after the compression rather than before it.
      const p = projectToSheet(
        v[b + c * 3],
        v[b + c * 3 + 1],
        v[b + c * 3 + 2] * mesh.zScale + zOffset,
        ex,
        ey,
        D,
      );
      // Level with the eye or beyond it, the projection is meaningless. The
      // subject depth is clamped well inside D, so this is a corrupt-mesh guard.
      if (p.t <= 0 || !Number.isFinite(p.t)) behind = true;
      sx[c] = p.X * pxPerMmX + w / 2;
      sy[c] = h / 2 - p.Y * pxPerMmY;
      st[c] = p.t;
    }
    if (behind) continue;

    // Edge-function setup. A zero area is a degenerate triangle: skip it.
    const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sy[1] - sy[0]) * (sx[2] - sx[0]);
    if (!area) continue;
    const inv = 1 / area;

    const x0 = Math.max(0, Math.floor(Math.min(sx[0], sx[1], sx[2])));
    const x1 = Math.min(w - 1, Math.ceil(Math.max(sx[0], sx[1], sx[2])));
    const y0 = Math.max(0, Math.floor(Math.min(sy[0], sy[1], sy[2])));
    const y1 = Math.min(h - 1, Math.ceil(Math.max(sy[0], sy[1], sy[2])));
    if (x1 < x0 || y1 < y0) continue;

    const [nx, ny, nz] = faceNormal(v, b);
    const diffuse = amb + (1 - amb) * Math.abs(nx * lx + ny * ly + nz * lz);
    const r = colour[0] * diffuse;
    const g = colour[1] * diffuse;
    const bl = colour[2] * diffuse;

    // Attribute × t is what interpolates linearly in screen space.
    const uvBase = tri * 6;
    const cBase = tri * 9;
    for (let y = y0; y <= y1; y++) {
      const py = y + 0.5;
      for (let x = x0; x <= x1; x++) {
        const px = x + 0.5;
        // Barycentric weights from the same cross products as the area.
        const w0 = ((sx[1] - px) * (sy[2] - py) - (sy[1] - py) * (sx[2] - px)) * inv;
        const w1 = ((sx[2] - px) * (sy[0] - py) - (sy[2] - py) * (sx[0] - px)) * inv;
        const w2 = 1 - w0 - w1;
        if (w0 < 0 || w1 < 0 || w2 < 0) continue;
        const t = w0 * st[0] + w1 * st[1] + w2 * st[2];
        const at = y * w + x;
        if (t <= key[at]) continue;
        key[at] = t;

        if (uvs && o.texture) {
          const q0 = w0 * st[0];
          const q1 = w1 * st[1];
          const q2 = w2 * st[2];
          sampleTexture(
            o.texture,
            (q0 * uvs[uvBase] + q1 * uvs[uvBase + 2] + q2 * uvs[uvBase + 4]) / t,
            (q0 * uvs[uvBase + 1] + q1 * uvs[uvBase + 3] + q2 * uvs[uvBase + 5]) / t,
            texel,
          );
          rgb[at * 3] = texel[0] * diffuse;
          rgb[at * 3 + 1] = texel[1] * diffuse;
          rgb[at * 3 + 2] = texel[2] * diffuse;
        } else if (colours) {
          const q0 = w0 * st[0];
          const q1 = w1 * st[1];
          const q2 = w2 * st[2];
          for (let c = 0; c < 3; c++) {
            const mixed =
              (q0 * colours[cBase + c] + q1 * colours[cBase + 3 + c] + q2 * colours[cBase + 6 + c]) / t;
            rgb[at * 3 + c] = mixed * diffuse;
          }
        } else {
          rgb[at * 3] = r;
          rgb[at * 3 + 1] = g;
          rgb[at * 3 + 2] = bl;
        }
      }
    }
  }
  return { rgb, key, w, h, ss };
}

/** Box-filter an oversampled buffer down to the requested size. */
function downsample(rgb: Uint8ClampedArray, w: number, h: number, ss: number): RasterImage {
  const ow = Math.max(1, Math.round(w / ss));
  const oh = Math.max(1, Math.round(h / ss));
  const img = createImage(ow, oh, [0, 0, 0, 255]);
  const n = ss * ss;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < ss; dy++) {
        const sy = Math.min(h - 1, y * ss + dy);
        for (let dx = 0; dx < ss; dx++) {
          const at = (sy * w + Math.min(w - 1, x * ss + dx)) * 3;
          r += rgb[at];
          g += rgb[at + 1];
          b += rgb[at + 2];
        }
      }
      const o = (y * ow + x) * 4;
      img.data[o] = r / n;
      img.data[o + 1] = g / n;
      img.data[o + 2] = b / n;
    }
  }
  return img;
}

/**
 * How far the most extreme point of the subject slides across the sheet from
 * one view to the next, in lenslets.
 *
 * This is the number that decides whether a print reads as depth or as mush. A
 * lens grid samples each view once per lenslet, so a feature that moves more
 * than about one lenslet per view step is never recorded in between: instead of
 * gliding it jumps, and the lens blur turns the jump into a double image. (Up
 * to a point that blur is worth having — it grows with depth, so it reads as
 * haze; see the guide. Past it the print doubles.)
 *
 * From `projectToSheet`, ∂X/∂ex = 1 − t, so a step `s` of eye position moves the
 * point by s·(t − 1) = s·z/(D − z). Which face is the extreme depends on where
 * the subject sits: behind the sheet it is the far one, but a subject brought
 * out through the plate can move more at its near face, since z/(D − z) grows
 * faster in front than behind. Take whichever is worse.
 */
export function disparityPerStep(o: ViewGridOptions, lpi: number): { mm: number; lenslets: number } {
  const offsets = eyeOffsetsMm(o.grid, o.coneDeg, o.viewDistanceMm);
  const step = offsets.length > 1 ? Math.abs(offsets[1] - offsets[0]) : 0;
  const near = clampSetbackMm(o.setbackMm, o.viewDistanceMm);
  return worstDisparity(step, near, near + Math.max(0, o.depthMm), o.viewDistanceMm, lpi);
}

/**
 * The larger of the two faces' movement per eye step. `nearMm` and `farMm` are
 * distances *behind* the sheet, so a negative near face is one standing in
 * front of it.
 */
export function worstDisparity(
  stepMm: number,
  nearMm: number,
  farMm: number,
  viewDistanceMm: number,
  lpi: number,
): { mm: number; lenslets: number } {
  const at = (behindMm: number) => disparityAtDepth(stepMm, -behindMm, viewDistanceMm, lpi);
  const near = at(nearMm);
  const far = at(farMm);
  return far.mm >= near.mm ? far : near;
}

/**
 * How far a point at depth `zMm` slides across the sheet when the eye moves
 * `stepMm`, in mm and in lenslets. Positive z is in front of the sheet,
 * negative behind it — behind is the gentler side, because D − z grows instead
 * of shrinking, which is one reason a window is easier to print than a
 * pop-out.
 */
export function disparityAtDepth(
  stepMm: number,
  zMm: number,
  viewDistanceMm: number,
  lpi: number,
): { mm: number; lenslets: number } {
  const D = Math.max(1e-6, viewDistanceMm);
  const mm = zMm >= D ? Infinity : Math.abs((stepMm * zMm) / (D - zMm));
  return { mm, lenslets: mm / (25.4 / Math.max(1e-6, lpi)) };
}

export interface ViewGridRender {
  /** grid² views, row-major from the top-left (`Left · Up`), as gridCells lists. */
  views: RasterImage[];
  /** Depth of the centre view, white = nearest. Feeds the gloss/heightmap chain. */
  depth: RasterImage;
  /** Fraction of the centre view the subject covers, 0–1. */
  coverage: number;
  /**
   * Where the subject sits behind the sheet, mm: near face and far face. A
   * negative `nearMm` is a subject brought out through the plate by that much.
   */
  nearMm: number;
  farMm: number;
}

/**
 * Render the whole view grid, of a subject standing *behind* the sheet. Views
 * come back in {@link gridCells} order, so they line up one-to-one with the
 * Lens Grid Print node's inputs.
 *
 * The window is the same one the 1D run uses, in two axes rather than one: the
 * subject does not cross the sheet plane, so it cannot be clipped by an edge it
 * appears to float in front of, and the edges of the sheet cover and uncover it
 * both sideways and vertically as you move. See the section at the foot of this
 * file for the whole argument — including what a negative `setbackMm` trades
 * away to bring the front of the subject out through the plate.
 *
 * No mirroring happens here: each view is honestly what an eye in that position
 * sees. The print node inverts them, because the *lens* is what inverts them.
 */
export function renderViewGrid(stl: StlValue, o: ViewGridOptions): ViewGridRender {
  return drainViews(viewGridChunks(stl, o));
}

/**
 * {@link renderViewGrid}, one view at a time.
 *
 * A view is the natural chunk here: it is one whole pass over the mesh, it is
 * the unit the progress is worth counting in ("view 37 of 225"), and a 15×15
 * grid is 225 of them — which at half a second each is two minutes of frozen
 * tab if nobody hands the event loop back in between.
 */
export function* viewGridChunks(stl: StlValue, o: ViewGridOptions): Generator<ChunkProgress, ViewGridRender> {
  const grid = Math.max(1, Math.round(o.grid));
  const depthMm = Math.max(0, o.depthMm);
  const setbackMm = clampSetbackMm(o.setbackMm, o.viewDistanceMm);
  // The subject occupies [-(setback + depth), -setback]: near face `setback`
  // behind the sheet, or in front of it if that is negative. prepareVertices
  // centres it on z = 0 and the compression maps it to `depthMm`, so the offset
  // is to its mid-plane.
  const placed: ViewGridOptions = {
    ...o,
    zOffsetMm: -(setbackMm + depthMm / 2),
    // Fit at the near face: that is the plane that projects largest, so
    // nothing of the subject can spill past the window's edge.
    fitAtZMm: -setbackMm,
  };

  const mesh = prepareVertices(stl, placed);
  const offsets = eyeOffsetsMm(grid, o.coneDeg, o.viewDistanceMm);

  // The view nearest head-on; for an even grid, one of the middle four.
  const mid = grid >> 1;
  const views: RasterImage[] = [];
  const total = grid * grid;
  let centre: ReturnType<typeof renderOne> | undefined;
  for (let row = 0; row < grid; row++) {
    for (let col = 0; col < grid; col++) {
      // Row 0 is `Up`: the eye is above the sheet, so +y. Column 0 is `Left`.
      const rendered = renderOne(mesh, stl.triangleCount, placed, offsets[col], -offsets[row]);
      views.push(downsample(rendered.rgb, rendered.w, rendered.h, rendered.ss));
      if (col === mid && row === mid) centre = rendered;
      yield { done: views.length, total, what: 'Views' };
    }
  }

  const { depth, coverage } = depthOf(centre ?? renderOne(mesh, stl.triangleCount, placed, 0, 0));
  return { views, depth, coverage, nearMm: setbackMm, farMm: setbackMm + depthMm };
}

/**
 * Depth map of one rendered view, normalised over the range actually hit so it
 * always uses the full 0–255 whatever the subject depth is, plus the fraction
 * of the frame the subject covers.
 */
function depthOf(src: ReturnType<typeof renderOne>): { depth: RasterImage; coverage: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let hits = 0;
  for (const t of src.key) {
    if (!t) continue;
    hits++;
    if (t < lo) lo = t;
    if (t > hi) hi = t;
  }
  const span = hi - lo || 1;
  const dw = Math.max(1, Math.round(src.w / src.ss));
  const dh = Math.max(1, Math.round(src.h / src.ss));
  const depth = createImage(dw, dh, [0, 0, 0, 255]);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const t = src.key[Math.min(src.h - 1, y * src.ss) * src.w + Math.min(src.w - 1, x * src.ss)];
      const g = t ? Math.round(((t - lo) / span) * 255) : 0;
      const o4 = (y * dw + x) * 4;
      depth.data[o4] = g;
      depth.data[o4 + 1] = g;
      depth.data[o4 + 2] = g;
    }
  }
  return { depth, coverage: hits / (src.w * src.h) };
}

// ---------------------------------------------------------------------------
// The window: a subject standing *behind* the sheet. Both renderers place their
// subject this way — the grid over two axes, the run below over one — and this
// is where the argument and the maths live.
//
// The camera is the same either way: the eye translates and never rotates, and
// the subject is pushed back so that none of it crosses the sheet plane. That
// makes the print a window rather than a hologram, and it is not a stylistic
// choice; three things follow from it:
//
//   • Nothing pops out, so nothing can be cut off by the edge of the sheet while
//     appearing to float in front of it. That contradiction ("window violation")
//     is the single most uncomfortable thing a stereo print can do.
//   • The frame occludes, exactly as a real window does. Off-axis views see the
//     subject shifted behind a fixed aperture, so the edges of the sheet cover
//     and uncover it as you move — the strongest depth cue in the whole picture,
//     and free.
//   • Disparity is gentler for the same depth: a point behind moves by
//     s·Z/(D + Z), against s·Z/(D − Z) in front. See `disparityAtDepth`.
//
// The one thing it costs is size. Seen from the eye, a subject Z behind the
// window subtends D/(D + Z) of what it would at the glass, so it has to be
// scaled up by the reciprocal to fill the frame — `fitAtZMm` in
// {@link prepareVertices}, applied at the near face so nothing spills out of the
// aperture.
//
// Breaking the window on purpose
// ------------------------------
// `setbackMm` may be negative, which brings the near face out through the plate
// while the rest of the subject stays inside it — a nose in front of the glass
// on a head that is still in the box. Nothing in the maths above needs changing:
// the near face is at z = −setback, which is now positive, `fitAtZMm` scales the
// fit *down* instead of up (a plane in front subtends more, not less), and the
// disparity formula carries the sign on its own.
//
// What it trades away is the first bullet, and only for the part that crosses:
// anything in front of the plane that touches the edge of the sheet is a window
// violation. Keep the crossing part small — a millimetre or two is plenty to
// read as "out of the plate" — and keep it away from the border, and the frame
// still occludes everything else exactly as before. The near face also stops
// being the sharp one: what prints sharp is always the sheet plane, which now
// cuts through the subject rather than sitting at its front.
// ---------------------------------------------------------------------------

/**
 * The two Info lines that place the subject relative to the sheet: where it
 * stands, and what standing there does to its size. Shared by both render
 * nodes, since it is the same window either way — `occlusion` is the clause
 * that differs, the grid occluding in two axes and the 1D run in one.
 *
 * `nearMm` and `farMm` are distances behind the sheet, so a negative near face
 * is one brought out through the plate.
 */
export function describePlacement(
  nearMm: number,
  farMm: number,
  viewDistanceMm: number,
  occlusion: string,
): string[] {
  const D = Math.max(1e-6, viewDistanceMm);
  const outMm = Math.max(0, -nearMm);
  const place =
    outMm === 0
      ? `Window: the subject stands ${nearMm.toFixed(1)}–${farMm.toFixed(1)} mm behind the sheet, all ` +
        `of it. Nothing crosses the plane, so nothing can float in front of the paper edge and be cut ` +
        `off by it, ${occlusion}`
      : farMm > 0
        ? `Window, broken on purpose: the subject reaches ${outMm.toFixed(1)} mm out through the plate ` +
          `and ${farMm.toFixed(1)} mm into it. Keep that front ${outMm.toFixed(1)} mm clear of the ` +
          `edges — something nearer than the paper that the paper's own edge cuts off is a window ` +
          `violation, and that is the one thing that reads as wrong rather than as depth. Everything ` +
          `behind the plane is unaffected, ${occlusion}`
        : `Pop-out: the whole subject stands ${outMm.toFixed(1)}–${(-farMm).toFixed(1)} mm in front of ` +
          `the sheet, none of it behind. Wherever it reaches the border the paper edge will cut off ` +
          `something that appears nearer than the paper — a window violation. Pull the Setback back ` +
          `toward 0 unless you know you want this`;
  // The near face is the plane that projects largest, so the fit is measured
  // there. Behind the glass that scales the subject up; in front of it, down.
  const shrink = (D + nearMm) / (D + farMm);
  return [
    place,
    `Fitted at the near face, scaled ×${((D + nearMm) / D).toFixed(3)} to fill the frame from there; ` +
      `the far face lands ${((1 - shrink) * 100).toFixed(1)}% smaller, which is the perspective doing ` +
      `the work`,
  ];
}

export interface ViewSequenceOptions extends ViewRenderOptions {
  /** How many views to render across the cone, left to right. */
  views: number;
  /**
   * Where the nearest point of the subject sits relative to the sheet, mm
   * *behind* it. 0 stands it right against the glass — the classic window — and
   * anything more sinks it further into the box. Negative brings the front of
   * the subject out through the plate; see {@link clampSetbackMm} and the
   * section above.
   */
  setbackMm: number;
}

export interface ViewSequenceRender {
  /** The views, left eye first. */
  views: RasterImage[];
  /** Eye position of each view, mm off-axis; negative is left. */
  offsetsMm: number[];
  /** Depth of the middle view, white = nearest. */
  depth: RasterImage;
  /** Fraction of the middle view the subject covers, 0–1. */
  coverage: number;
  /** Where the subject sits behind the sheet, mm: near face and far face. */
  nearMm: number;
  farMm: number;
}

/**
 * Render a horizontal run of views of a subject standing behind the sheet.
 *
 * Views come back in eye order, leftmost first — honestly what an eye in that
 * position sees through the window, with no mirroring. A lens inverts, so
 * whatever prints them has to account for that (the node does).
 */
export function renderViewSequence(stl: StlValue, o: ViewSequenceOptions): ViewSequenceRender {
  return drainViews(viewSequenceChunks(stl, o));
}

/** {@link renderViewSequence}, one view at a time. See {@link viewGridChunks}. */
export function* viewSequenceChunks(
  stl: StlValue,
  o: ViewSequenceOptions,
): Generator<ChunkProgress, ViewSequenceRender> {
  const count = Math.max(1, Math.round(o.views));
  const depthMm = Math.max(0, o.depthMm);
  const setbackMm = clampSetbackMm(o.setbackMm, o.viewDistanceMm);
  // The subject occupies [-(setback + depth), -setback]: near face `setback`
  // behind the sheet, or in front of it if that is negative. prepareVertices
  // centres it on z = 0 and the compression maps it to `depthMm`, so the offset
  // is to its mid-plane.
  const placed: ViewSequenceOptions = {
    ...o,
    zOffsetMm: -(setbackMm + depthMm / 2),
    // Fit at the near face: that is the plane that projects largest, so
    // nothing of the subject can spill past the window's edge.
    fitAtZMm: -setbackMm,
  };

  const mesh = prepareVertices(stl, placed);
  const offsetsMm = eyeOffsetsMm(count, o.coneDeg, o.viewDistanceMm);
  const views: RasterImage[] = [];
  const mid = count >> 1;
  let centre: ReturnType<typeof renderOne> | undefined;
  for (let i = 0; i < count; i++) {
    const rendered = renderOne(mesh, stl.triangleCount, placed, offsetsMm[i], 0);
    views.push(downsample(rendered.rgb, rendered.w, rendered.h, rendered.ss));
    if (i === mid) centre = rendered;
    yield { done: views.length, total: count, what: 'Views' };
  }

  const { depth, coverage } = depthOf(centre ?? renderOne(mesh, stl.triangleCount, placed, 0, 0));
  return {
    views,
    offsetsMm,
    depth,
    coverage,
    nearMm: setbackMm,
    farMm: setbackMm + depthMm,
  };
}
