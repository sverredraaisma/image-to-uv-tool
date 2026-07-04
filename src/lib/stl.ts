// Height-map -> solid STL mesh. Pure and testable.
//
// The surface is a triangulated grid ("terrain"): each included pixel is a cell
// whose four corner heights are the average of the included pixels meeting at
// that corner, so the top tilts smoothly between pixels (gentle slopes) rather
// than stepping with vertical walls. A flat base at z=0 plus a skirt along the
// footprint boundary (outer edge + mask holes) closes it into a watertight solid.

import type { RasterImage, StlValue } from '../types';
import { luminance } from './image';

export interface HeightmapOptions {
  /**
   * Minimum white value (0-255) for a pixel to be part of the mesh. Use -1 to
   * include the whole image.
   */
  minWhite: number;
  /** Flat base thickness always added to included pixels. */
  baseThickness: number;
  /** Z distance between a fully black and fully white included pixel. */
  depthRange: number;
  /** Physical width of the whole image (X extent), in the STL's units. */
  width: number;
  /** Gaussian blur radius (σ, in pixels) applied to the heights before meshing,
   *  for a smoother surface. 0/undefined = off. The include mask is unaffected. */
  smooth?: number;
}

type Tri = [number, number, number, number, number, number, number, number, number];

function normal(
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
): [number, number, number] {
  const ux = bx - ax,
    uy = by - ay,
    uz = bz - az;
  const vx = cx - ax,
    vy = cy - ay,
    vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

interface Mesh {
  tris: Tri[];
}

/** Called for each triangle with its 9 vertex coordinates. Allocation-free. */
type EmitTri = (
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
) => void;

/** Emit a quad (a,b,c,d) as two triangles. */
function emitQuad(
  emit: EmitTri,
  ax: number,
  ay: number,
  az: number,
  bx: number,
  by: number,
  bz: number,
  cx: number,
  cy: number,
  cz: number,
  dx: number,
  dy: number,
  dz: number,
) {
  emit(ax, ay, az, bx, by, bz, cx, cy, cz);
  emit(ax, ay, az, cx, cy, cz, dx, dy, dz);
}

/** Separable Gaussian kernel (normalised) for a given σ. */
function gaussianKernel(sigma: number): Float32Array {
  const r = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(2 * r + 1);
  let sum = 0;
  for (let i = -r; i <= r; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + r] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;
  return k;
}

/**
 * The per-pixel luminance (0..1) used as the surface height, optionally
 * Gaussian-smoothed (`opts.smooth` = σ in px) to soften the faceted slopes.
 * Clamped edges. The mask is computed from the raw image, not this field.
 */
function computeHeightField(img: RasterImage, opts: HeightmapOptions): Float32Array {
  const { width: w, height: h, data } = img;
  const src = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const i = p * 4;
    src[p] = luminance(data[i], data[i + 1], data[i + 2]) / 255;
  }
  const sigma = opts.smooth ?? 0;
  if (sigma <= 0) return src;

  const k = gaussianKernel(sigma);
  const r = (k.length - 1) / 2;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) acc += src[y * w + Math.max(0, Math.min(w - 1, x + t))] * k[t + r];
      tmp[y * w + x] = acc;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) acc += tmp[Math.max(0, Math.min(h - 1, y + t)) * w + x] * k[t + r];
      out[y * w + x] = acc;
    }
  }
  return out;
}

/**
 * Walk the heightmap as a triangulated grid (a "terrain" surface), calling
 * `emit` for each triangle. Each included pixel is one cell whose four *corner*
 * heights are the average of the included pixels meeting at that corner — so the
 * surface tilts smoothly between pixels (gentle slopes) instead of stepping with
 * vertical walls (the old voxel "staircase"). Top + bottom + a skirt only along
 * the footprint boundary make it a watertight solid.
 *
 * Allocation-free (no per-triangle JS arrays), so it can be run twice — count,
 * then fill a Float32Array directly — for large meshes without garbage.
 */
function buildMesh(img: RasterImage, opts: HeightmapOptions, emit: EmitTri, heightField: Float32Array): void {
  const { width: w, height: h, data } = img;
  const ps = opts.width / w; // physical size of a pixel

  // Raw luminance decides the include mask (never blurred); the height field
  // (optionally Gaussian-smoothed) decides the surface z.
  const rawLum01 = (x: number, y: number): number => {
    const i = (y * w + x) * 4;
    return luminance(data[i], data[i + 1], data[i + 2]) / 255;
  };
  const lum01 = (x: number, y: number): number => heightField[y * w + x];
  const included = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (opts.minWhite < 0) return true;
    return rawLum01(x, y) * 255 >= opts.minWhite;
  };

  // Height at a pixel *corner* = average of the included pixels touching it.
  // Averaging neighbours turns inter-pixel steps into slopes and mildly smooths.
  const cornerZ = (ci: number, cj: number): number => {
    let sum = 0;
    let n = 0;
    for (const [px, py] of [
      [ci - 1, cj - 1],
      [ci, cj - 1],
      [ci - 1, cj],
      [ci, cj],
    ]) {
      if (included(px, py)) {
        sum += lum01(px, py);
        n++;
      }
    }
    return opts.baseThickness + (n ? sum / n : 0) * opts.depthRange;
  };

  // Vertical wall from a top edge p->q down to z=0, wound outward.
  const skirt = (px: number, py: number, pz: number, qx: number, qy: number, qz: number) => {
    emit(px, py, pz, px, py, 0, qx, qy, 0);
    emit(px, py, pz, qx, qy, 0, qx, qy, qz);
  };

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (!included(i, j)) continue; // one cell per included pixel
      const x0 = i * ps;
      const x1 = (i + 1) * ps;
      // Flip Y so image row 0 -> max Y (upright print).
      const yT = (h - j) * ps;
      const yB = (h - j - 1) * ps;
      const zA = cornerZ(i, j); // A = top-left     (x0, yT)
      const zB = cornerZ(i + 1, j); // B = top-right    (x1, yT)
      const zC = cornerZ(i + 1, j + 1); // C = bottom-right (x1, yB)
      const zD = cornerZ(i, j + 1); // D = bottom-left  (x0, yB)

      // Top surface (+Z): sloped quad through the four corner heights (split A-C).
      emitQuad(emit, x0, yT, zA, x0, yB, zD, x1, yB, zC, x1, yT, zB);
      // Bottom at z=0 (-Z): reversed winding so it lines up with the skirts.
      emitQuad(emit, x0, yT, 0, x1, yT, 0, x1, yB, 0, x0, yB, 0);

      // Skirt any edge whose neighbouring pixel isn't part of the solid — this
      // seals the outer boundary and every mask hole. Walked CCW seen from above.
      if (!included(i - 1, j)) skirt(x0, yT, zA, x0, yB, zD); // W (A->D)
      if (!included(i, j + 1)) skirt(x0, yB, zD, x1, yB, zC); // S (D->C)
      if (!included(i + 1, j)) skirt(x1, yB, zC, x1, yT, zB); // E (C->B)
      if (!included(i, j - 1)) skirt(x1, yT, zB, x0, yT, zA); // N (B->A)
    }
  }
}

/** Collect the mesh triangles into arrays (used by tests / small previews). */
export function heightmapToMesh(img: RasterImage, opts: HeightmapOptions): Mesh {
  const field = computeHeightField(img, opts);
  const tris: Tri[] = [];
  buildMesh(
    img,
    opts,
    (ax, ay, az, bx, by, bz, cx, cy, cz) => tris.push([ax, ay, az, bx, by, bz, cx, cy, cz]),
    field,
  );
  return { tris };
}

/** ASCII STL text (mainly for previews / debugging). */
export function stlToAscii(stl: StlValue, name = 'heightmap', maxTriangles = Infinity): string {
  const t = stl.triangles;
  const count = Math.min(stl.triangleCount, maxTriangles);
  const lines: string[] = [`solid ${name}`];
  for (let i = 0; i < count; i++) {
    const b = i * 9;
    const [n0, n1, n2] = normal(
      t[b],
      t[b + 1],
      t[b + 2],
      t[b + 3],
      t[b + 4],
      t[b + 5],
      t[b + 6],
      t[b + 7],
      t[b + 8],
    );
    lines.push(`  facet normal ${n0} ${n1} ${n2}`);
    lines.push('    outer loop');
    lines.push(`      vertex ${t[b]} ${t[b + 1]} ${t[b + 2]}`);
    lines.push(`      vertex ${t[b + 3]} ${t[b + 4]} ${t[b + 5]}`);
    lines.push(`      vertex ${t[b + 6]} ${t[b + 7]} ${t[b + 8]}`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  // Preview callers pass a small maxTriangles to avoid building a multi-MB
  // string for a large mesh; mark the truncation rather than serialising it all.
  if (count < stl.triangleCount) lines.push(`  # … ${stl.triangleCount - count} more facets`);
  lines.push(`endsolid ${name}`);
  return lines.join('\n');
}

/** Wavefront OBJ text (a widely-imported alternative to STL). */
export function stlToObj(stl: StlValue, name = 'heightmap'): string {
  const t = stl.triangles;
  const n = stl.triangleCount;
  const lines: string[] = [`# ${name} — exported by image-to-uv-tool`, `o ${name}`];
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    lines.push(`v ${t[b]} ${t[b + 1]} ${t[b + 2]}`);
    lines.push(`v ${t[b + 3]} ${t[b + 4]} ${t[b + 5]}`);
    lines.push(`v ${t[b + 6]} ${t[b + 7]} ${t[b + 8]}`);
  }
  for (let i = 0; i < n; i++) {
    const a = i * 3 + 1; // OBJ indices are 1-based
    lines.push(`f ${a} ${a + 1} ${a + 2}`);
  }
  return lines.join('\n') + '\n';
}

/** Binary STL bytes (80-byte header + uint32 count + 50 bytes/triangle). */
export function stlToBinary(stl: StlValue): Uint8Array<ArrayBuffer> {
  const n = stl.triangleCount;
  const buf = new ArrayBuffer(84 + n * 50);
  const view = new DataView(buf);
  view.setUint32(80, n, true);
  const t = stl.triangles;
  let off = 84;
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    const [nx, ny, nz] = normal(
      t[b],
      t[b + 1],
      t[b + 2],
      t[b + 3],
      t[b + 4],
      t[b + 5],
      t[b + 6],
      t[b + 7],
      t[b + 8],
    );
    view.setFloat32(off, nx, true);
    view.setFloat32(off + 4, ny, true);
    view.setFloat32(off + 8, nz, true);
    off += 12;
    for (let v = 0; v < 9; v++, off += 4) view.setFloat32(off, t[b + v], true);
    view.setUint16(off, 0, true); // attribute byte count
    off += 2;
  }
  return new Uint8Array(buf);
}

/** Sanity ceiling on input dimensions (the STL node is manual, so this is high). */
export const MAX_STL_PIXELS = 1_000_000; // ~1000×1000
/** Ceiling on output triangles (each is 9 floats = 36 bytes in the buffer). */
export const MAX_STL_TRIANGLES = 8_000_000;

/**
 * Build a solid STL from a heightmap. Two passes over the geometry — count the
 * triangles, then fill an exactly-sized Float32Array directly — so it scales to
 * high-resolution heightmaps without allocating millions of throwaway arrays.
 */
export function heightmapToStl(img: RasterImage, opts: HeightmapOptions): StlValue {
  const pixels = img.width * img.height;
  if (pixels > MAX_STL_PIXELS) {
    throw new Error(
      `Heightmap too large (${pixels.toLocaleString()} px) — resize it below ~1000×1000 before generating an STL.`,
    );
  }
  // Smooth the height field once (if requested); reused by both passes.
  const field = computeHeightField(img, opts);
  // Pass 1: count triangles (no allocation; wall count varies with the terrain).
  let count = 0;
  buildMesh(
    img,
    opts,
    () => {
      count++;
    },
    field,
  );
  if (count > MAX_STL_TRIANGLES) {
    throw new Error(
      `Mesh too detailed (${count.toLocaleString()} triangles) — raise "Min white" to include fewer pixels, or resize the heightmap smaller.`,
    );
  }
  // Pass 2: fill the buffer directly.
  const triangles = new Float32Array(count * 9);
  let o = 0;
  buildMesh(
    img,
    opts,
    (ax, ay, az, bx, by, bz, cx, cy, cz) => {
      triangles[o] = ax;
      triangles[o + 1] = ay;
      triangles[o + 2] = az;
      triangles[o + 3] = bx;
      triangles[o + 4] = by;
      triangles[o + 5] = bz;
      triangles[o + 6] = cx;
      triangles[o + 7] = cy;
      triangles[o + 8] = cz;
      o += 9;
    },
    field,
  );
  return { kind: 'stl', triangleCount: count, triangles };
}
