// Height-map -> solid STL mesh. Pure and testable.
//
// Each included pixel becomes a flat-topped column: a top quad at its computed
// height, a bottom quad at z=0, and vertical walls only where a face is exposed
// (a taller-than-neighbour step, or a boundary with an excluded pixel / the
// image edge). This yields a watertight solid.

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

/**
 * Walk the heightmap geometry, calling `emit` for each triangle. Allocation-free
 * (no per-triangle JS arrays), so it can be run twice — count, then fill a
 * Float32Array directly — for large meshes without millions of throwaway arrays.
 */
function buildMesh(img: RasterImage, opts: HeightmapOptions, emit: EmitTri): void {
  const { width: w, height: h, data } = img;
  const ps = opts.width / w; // physical size of a pixel

  const value = (x: number, y: number): number => {
    const i = (y * w + x) * 4;
    return luminance(data[i], data[i + 1], data[i + 2]);
  };
  const included = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (opts.minWhite < 0) return true;
    return value(x, y) >= opts.minWhite;
  };
  const heightAt = (x: number, y: number): number =>
    opts.baseThickness + (value(x, y) / 255) * opts.depthRange;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!included(x, y)) continue;
      const z = heightAt(x, y);
      // Flip Y so the image appears upright (image row 0 -> max Y).
      const x0 = x * ps;
      const x1 = (x + 1) * ps;
      const y0 = (h - y) * ps;
      const y1 = (h - y - 1) * ps;

      // Top (normal +Z): CCW when viewed from above.
      emitQuad(emit, x0, y1, z, x1, y1, z, x1, y0, z, x0, y0, z);
      // Bottom (normal -Z): reverse winding.
      emitQuad(emit, x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0);

      // Walls. For an included neighbour we only emit the exposed step from the
      // taller side; for an excluded neighbour we emit a full wall down to 0.
      wall(emit, x0, y0, x0, y1, z, included(x - 1, y) ? heightAt(x - 1, y) : 0, included(x - 1, y), false);
      wall(emit, x1, y1, x1, y0, z, included(x + 1, y) ? heightAt(x + 1, y) : 0, included(x + 1, y), false);
      wall(emit, x0, y0, x1, y0, z, included(x, y - 1) ? heightAt(x, y - 1) : 0, included(x, y - 1), true);
      wall(emit, x1, y1, x0, y1, z, included(x, y + 1) ? heightAt(x, y + 1) : 0, included(x, y + 1), true);
    }
  }
}

/** Collect the mesh triangles into arrays (used by tests / small previews). */
export function heightmapToMesh(img: RasterImage, opts: HeightmapOptions): Mesh {
  const tris: Tri[] = [];
  buildMesh(img, opts, (ax, ay, az, bx, by, bz, cx, cy, cz) =>
    tris.push([ax, ay, az, bx, by, bz, cx, cy, cz]),
  );
  return { tris };
}

/**
 * Emit a vertical wall along edge p1->p2 for the exposed portion of this
 * pixel's column (top height `z`). If the neighbour is included we only emit
 * the step above the neighbour's height (and only when we are taller, so the
 * shared face isn't drawn twice). If excluded, emit the full 0..z wall.
 */
function wall(
  emit: EmitTri,
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  z: number,
  neighbourHeight: number,
  neighbourIncluded: boolean,
  flip: boolean,
) {
  let zLow: number;
  if (neighbourIncluded) {
    if (z <= neighbourHeight) return; // neighbour draws (or flush) — skip
    zLow = neighbourHeight;
  } else {
    zLow = 0;
  }
  if (z <= zLow) return;
  // Quad corners: a(p1,zLow) b(p2,zLow) c(p2,z) d(p1,z).
  // The two Y-side walls are traversed p1->p2 in the opposite screen sense to
  // the X-side walls, so a,b,c,d there yields an inward normal — reverse the
  // winding (a,d,c,b) for those so every wall points outward.
  if (flip) emitQuad(emit, p1x, p1y, zLow, p1x, p1y, z, p2x, p2y, z, p2x, p2y, zLow);
  else emitQuad(emit, p1x, p1y, zLow, p2x, p2y, zLow, p2x, p2y, z, p1x, p1y, z);
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
  // Pass 1: count triangles (no allocation; wall count varies with the terrain).
  let count = 0;
  buildMesh(img, opts, () => {
    count++;
  });
  if (count > MAX_STL_TRIANGLES) {
    throw new Error(
      `Mesh too detailed (${count.toLocaleString()} triangles) — raise "Min white" to include fewer pixels, or resize the heightmap smaller.`,
    );
  }
  // Pass 2: fill the buffer directly.
  const triangles = new Float32Array(count * 9);
  let o = 0;
  buildMesh(img, opts, (ax, ay, az, bx, by, bz, cx, cy, cz) => {
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
  });
  return { kind: 'stl', triangleCount: count, triangles };
}
