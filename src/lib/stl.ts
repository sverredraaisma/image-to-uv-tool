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
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): [number, number, number] {
  const ux = bx - ax, uy = by - ay, uz = bz - az;
  const vx = cx - ax, vy = cy - ay, vz = cz - az;
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const len = Math.hypot(nx, ny, nz) || 1;
  return [nx / len, ny / len, nz / len];
}

interface Mesh {
  tris: Tri[];
}

function addTri(mesh: Mesh, a: number[], b: number[], c: number[]) {
  mesh.tris.push([a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]]);
}

/** Add a quad (a,b,c,d) as two triangles. */
function addQuad(mesh: Mesh, a: number[], b: number[], c: number[], d: number[]) {
  addTri(mesh, a, b, c);
  addTri(mesh, a, c, d);
}

export function heightmapToMesh(img: RasterImage, opts: HeightmapOptions): Mesh {
  const { width: w, height: h, data } = img;
  const ps = opts.width / w; // physical size of a pixel
  const mesh: Mesh = { tris: [] };

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
      const x0 = x * ps, x1 = (x + 1) * ps;
      const y0 = (h - y) * ps, y1 = (h - y - 1) * ps;

      // Top (normal +Z): CCW when viewed from above.
      addQuad(mesh, [x0, y1, z], [x1, y1, z], [x1, y0, z], [x0, y0, z]);
      // Bottom (normal -Z): reverse winding.
      addQuad(mesh, [x0, y0, 0], [x1, y0, 0], [x1, y1, 0], [x0, y1, 0]);

      // Walls. For an included neighbour we only emit the exposed step from the
      // taller side; for an excluded neighbour we emit a full wall down to 0.
      // Left edge (x0)
      wall(mesh, [x0, y0, 0], [x0, y1, 0], z, included(x - 1, y) ? heightAt(x - 1, y) : 0, included(x - 1, y));
      // Right edge (x1)
      wall(mesh, [x1, y1, 0], [x1, y0, 0], z, included(x + 1, y) ? heightAt(x + 1, y) : 0, included(x + 1, y));
      // Top edge in image space (y0 side, towards y-1)
      wall(mesh, [x0, y0, 0], [x1, y0, 0], z, included(x, y - 1) ? heightAt(x, y - 1) : 0, included(x, y - 1), true);
      // Bottom edge in image space (y1 side, towards y+1)
      wall(mesh, [x1, y1, 0], [x0, y1, 0], z, included(x, y + 1) ? heightAt(x, y + 1) : 0, included(x, y + 1), true);
    }
  }
  return mesh;
}

/**
 * Emit a vertical wall along edge p1->p2 for the exposed portion of this
 * pixel's column (top height `z`). If the neighbour is included we only emit
 * the step above the neighbour's height (and only when we are taller, so the
 * shared face isn't drawn twice). If excluded, emit the full 0..z wall.
 */
function wall(
  mesh: Mesh,
  p1: number[],
  p2: number[],
  z: number,
  neighbourHeight: number,
  neighbourIncluded: boolean,
  flip = false,
) {
  let zLow: number;
  if (neighbourIncluded) {
    if (z <= neighbourHeight) return; // neighbour draws (or flush) — skip
    zLow = neighbourHeight;
  } else {
    zLow = 0;
  }
  if (z <= zLow) return;
  const a = [p1[0], p1[1], zLow];
  const b = [p2[0], p2[1], zLow];
  const c = [p2[0], p2[1], z];
  const d = [p1[0], p1[1], z];
  // The two Y-side walls are traversed p1->p2 in the opposite screen sense to
  // the X-side walls, so emitting a,b,c,d there yields an inward-facing normal.
  // Reverse the winding for those faces so every wall points outward.
  if (flip) addQuad(mesh, a, d, c, b);
  else addQuad(mesh, a, b, c, d);
}

/** ASCII STL text (mainly for previews / debugging). */
export function stlToAscii(stl: StlValue, name = 'heightmap', maxTriangles = Infinity): string {
  const t = stl.triangles;
  const count = Math.min(stl.triangleCount, maxTriangles);
  const lines: string[] = [`solid ${name}`];
  for (let i = 0; i < count; i++) {
    const b = i * 9;
    const [n0, n1, n2] = normal(
      t[b], t[b + 1], t[b + 2], t[b + 3], t[b + 4], t[b + 5], t[b + 6], t[b + 7], t[b + 8],
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
      t[b], t[b + 1], t[b + 2], t[b + 3], t[b + 4], t[b + 5], t[b + 6], t[b + 7], t[b + 8],
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

/** Above this many included pixels the mesh/ASCII STL gets pathologically large. */
export const MAX_STL_PIXELS = 90_000;

function includedCount(img: RasterImage, opts: HeightmapOptions): number {
  if (opts.minWhite < 0) return img.width * img.height;
  let n = 0;
  for (let p = 0; p < img.width * img.height; p++) {
    const i = p * 4;
    if (luminance(img.data[i], img.data[i + 1], img.data[i + 2]) >= opts.minWhite) n++;
  }
  return n;
}

export function heightmapToStl(img: RasterImage, opts: HeightmapOptions): StlValue {
  // Each included pixel becomes up to 12 triangles, so a large heightmap would
  // freeze the tab / produce hundreds of MB of ASCII STL. Guard early.
  const included = includedCount(img, opts);
  if (included > MAX_STL_PIXELS) {
    throw new Error(
      `Heightmap too detailed (${included} included pixels) — resize it smaller (≈300×300) before generating an STL.`,
    );
  }
  const mesh = heightmapToMesh(img, opts);
  const triangles = new Float32Array(mesh.tris.length * 9);
  for (let i = 0; i < mesh.tris.length; i++) triangles.set(mesh.tris[i], i * 9);
  return { kind: 'stl', triangleCount: mesh.tris.length, triangles };
}
