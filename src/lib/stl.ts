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
  /**
   * Merge same-height neighbours into large flat plateaus (greedy meshing) so
   * simple art produces a tiny mesh. Trades the smooth per-pixel slopes for a
   * blocky, quantised surface; ideal for posters / flat illustrations.
   */
  optimize?: boolean;
  /** Optimize mode: number of discrete height bands (2–256). Fewer = more
   *  merging = smaller mesh but chunkier relief. Default 16. */
  heightLevels?: number;
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

/**
 * Optimized "flat plateau" mesher: quantises heights into bands, then greedy-
 * meshes the top, bottom and vertical walls so runs of equal-height pixels
 * collapse into a few large rectangles. A uniform block becomes 12 triangles
 * regardless of resolution, so large-but-simple images produce tiny meshes.
 *
 * The surface has no holes (it slices/prints cleanly); greedy merging can leave
 * T-junctions where a big face meets several small ones, which slicers handle.
 * Allocation-light (one visited buffer, reused) so it runs twice for count+fill.
 */
function buildOptimizedMesh(
  img: RasterImage,
  opts: HeightmapOptions,
  emit: EmitTri,
  heightField: Float32Array,
): void {
  const { width: w, height: h, data } = img;
  const ps = opts.width / w;
  const N = Math.max(2, Math.min(256, Math.floor(opts.heightLevels ?? 16)));
  const steps = N - 1;

  // Per-pixel quantised level (from the possibly-smoothed height field).
  const level = new Int16Array(w * h);
  for (let p = 0; p < w * h; p++) {
    const f = Math.max(0, Math.min(1, heightField[p]));
    level[p] = Math.round(f * steps);
  }

  const included = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (opts.minWhite < 0) return true;
    const i = (y * w + x) * 4;
    return luminance(data[i], data[i + 1], data[i + 2]) >= opts.minWhite;
  };
  const zLevel = (lvl: number) => opts.baseThickness + (lvl / steps) * opts.depthRange;
  // Top height of a column (0 for empty cells — used for wall spans).
  const colTop = (x: number, y: number): number => (included(x, y) ? zLevel(level[y * w + x]) : 0);
  const yTop = (row: number) => (h - row) * ps; // world Y at the top edge of `row`

  const visited = new Uint8Array(w * h);

  // --- Top faces: maximal same-level rectangles (+Z). ---
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (visited[j * w + i] || !included(i, j)) continue;
      const lvl = level[j * w + i];
      let wi = 1;
      while (i + wi < w && !visited[j * w + i + wi] && included(i + wi, j) && level[j * w + i + wi] === lvl)
        wi++;
      let hj = 1;
      grow: while (j + hj < h) {
        for (let k = 0; k < wi; k++) {
          const c = (j + hj) * w + (i + k);
          if (visited[c] || !included(i + k, j + hj) || level[c] !== lvl) break grow;
        }
        hj++;
      }
      for (let b = 0; b < hj; b++) for (let a = 0; a < wi; a++) visited[(j + b) * w + (i + a)] = 1;
      const x0 = i * ps;
      const x1 = (i + wi) * ps;
      const yT = yTop(j);
      const yB = yTop(j + hj);
      const z = zLevel(lvl);
      emitQuad(emit, x0, yT, z, x0, yB, z, x1, yB, z, x1, yT, z);
    }
  }

  // --- Bottom faces: maximal included rectangles at z=0 (−Z, reversed). ---
  visited.fill(0);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (visited[j * w + i] || !included(i, j)) continue;
      let wi = 1;
      while (i + wi < w && !visited[j * w + i + wi] && included(i + wi, j)) wi++;
      let hj = 1;
      growB: while (j + hj < h) {
        for (let k = 0; k < wi; k++) {
          const c = (j + hj) * w + (i + k);
          if (visited[c] || !included(i + k, j + hj)) break growB;
        }
        hj++;
      }
      for (let b = 0; b < hj; b++) for (let a = 0; a < wi; a++) visited[(j + b) * w + (i + a)] = 1;
      const x0 = i * ps;
      const x1 = (i + wi) * ps;
      const yT = yTop(j);
      const yB = yTop(j + hj);
      emitQuad(emit, x0, yT, 0, x1, yT, 0, x1, yB, 0, x0, yB, 0);
    }
  }

  // Vertical wall (top edge p→q at zTop, down to zBot); skirt winding → outward.
  const wall = (px: number, py: number, qx: number, qy: number, zTop: number, zBot: number) => {
    emit(px, py, zTop, px, py, zBot, qx, qy, zBot);
    emit(px, py, zTop, qx, qy, zBot, qx, qy, zTop);
  };

  // --- Vertical walls at each x-boundary, merged along Y. ---
  for (let xb = 0; xb <= w; xb++) {
    const x = xb * ps;
    let dir = 0;
    let zLo = 0;
    let zHi = 0;
    let jStart = 0;
    const flush = (jEnd: number) => {
      if (dir === 0) return;
      const yHi = yTop(jStart); // larger Y (top of first row)
      const yLo = yTop(jEnd); // smaller Y (bottom of last row)
      // dir>0: left column taller ⇒ face exposed +X, wound +Y (low→high Y).
      // dir<0: right column taller ⇒ face exposed −X, wound −Y (high→low Y).
      if (dir > 0) wall(x, yLo, x, yHi, zHi, zLo);
      else wall(x, yHi, x, yLo, zHi, zLo);
    };
    for (let j = 0; j < h; j++) {
      const lz = colTop(xb - 1, j);
      const rz = colTop(xb, j);
      let d = 0;
      let lo = 0;
      let hi = 0;
      if (lz > rz) {
        d = 1;
        lo = rz;
        hi = lz;
      } else if (rz > lz) {
        d = -1;
        lo = lz;
        hi = rz;
      }
      if (d === dir && d !== 0 && lo === zLo && hi === zHi) continue; // extend run
      flush(j);
      dir = d;
      zLo = lo;
      zHi = hi;
      jStart = j;
    }
    flush(h);
  }

  // --- Horizontal walls at each y-boundary, merged along X. ---
  for (let yb = 0; yb <= h; yb++) {
    const yw = yTop(yb);
    let dir = 0;
    let zLo = 0;
    let zHi = 0;
    let iStart = 0;
    const flush = (iEnd: number) => {
      if (dir === 0) return;
      const xL = iStart * ps;
      const xR = iEnd * ps;
      // dir>0: upper row (larger Y) taller ⇒ face exposed −Y, wound +X (L→R).
      // dir<0: lower row taller ⇒ face exposed +Y, wound −X (R→L).
      if (dir > 0) wall(xL, yw, xR, yw, zHi, zLo);
      else wall(xR, yw, xL, yw, zHi, zLo);
    };
    for (let i = 0; i < w; i++) {
      const uz = colTop(i, yb - 1); // upper row (image row yb-1 = larger Y)
      const dz = colTop(i, yb); // lower row
      let d = 0;
      let lo = 0;
      let hi = 0;
      if (uz > dz) {
        d = 1;
        lo = dz;
        hi = uz;
      } else if (dz > uz) {
        d = -1;
        lo = uz;
        hi = dz;
      }
      if (d === dir && d !== 0 && lo === zLo && hi === zHi) continue;
      flush(i);
      dir = d;
      zLo = lo;
      zHi = hi;
      iStart = i;
    }
    flush(w);
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

// ---------------------------------------------------------------------------
// Reading a mesh back in — the mirror of the writers below, for the 3D Model
// Input node. Both STL flavours, because which one you get depends on whatever
// exported the file and nothing in the format announces it.
// ---------------------------------------------------------------------------

/** Ceiling on an uploaded mesh, so a bad file can't exhaust memory. */
export const MAX_IMPORT_TRIANGLES = 4_000_000;

/** Axis-aligned bounds of a mesh, plus its centre and extent. */
export interface MeshBounds {
  min: [number, number, number];
  max: [number, number, number];
  centre: [number, number, number];
  size: [number, number, number];
}

/** Bounding box of a triangle soup. An empty mesh bounds to a point at origin. */
export function meshBounds(stl: StlValue): MeshBounds {
  const t = stl.triangles;
  const n = stl.triangleCount * 9;
  if (n === 0) {
    return { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0], size: [0, 0, 0] };
  }
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = t[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  return {
    min,
    max,
    centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

/**
 * Is this binary STL, or ASCII?
 *
 * The header is 80 free-form bytes, and plenty of exporters write "solid <name>"
 * into a *binary* file's header, so the leading keyword proves nothing. What is
 * reliable is the length: a binary file is exactly 84 + 50·count bytes, and the
 * count is right there at offset 80. Check that arithmetic first and only fall
 * back to sniffing text.
 */
function looksBinary(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  if (84 + count * 50 === bytes.length) return true;
  // Length is off (a truncated or padded file). Trailing junk is common enough
  // that a plausible count with no ASCII "facet" in the first block still reads
  // as binary — an ASCII file always has one within a few hundred bytes.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(512, bytes.length)));
  return !/facet\s+normal/i.test(head);
}

function parseBinaryStl(bytes: Uint8Array): StlValue {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declared = view.getUint32(80, true);
  // Trust whichever is smaller: a truncated file must not read past its end.
  const fits = Math.max(0, Math.floor((bytes.length - 84) / 50));
  const count = Math.min(declared, fits);
  if (count > MAX_IMPORT_TRIANGLES) {
    throw new Error(
      `Mesh too large: ${count.toLocaleString()} triangles (limit ${MAX_IMPORT_TRIANGLES.toLocaleString()}). Decimate it first.`,
    );
  }
  const triangles = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    // 12 bytes of face normal, then the 9 vertex floats, then 2 attribute bytes.
    // The stored normal is discarded: it is often absent, zeroed or simply wrong,
    // and the winding gives us the true one for free at shading time.
    let off = 84 + i * 50 + 12;
    for (let v = 0; v < 9; v++, off += 4) triangles[i * 9 + v] = view.getFloat32(off, true);
  }
  return { kind: 'stl', triangleCount: count, triangles };
}

function parseAsciiStl(text: string): StlValue {
  // Pull every number in order and take them nine at a time, which makes the
  // parse indifferent to whitespace and line endings. Two things would poison
  // that stream and both go first: the face normals, and the solid's *name* —
  // "solid Part2" is perfectly legal and that 2 is not a coordinate.
  const body = text
    .replace(/^[ \t]*(?:end)?solid[^\n]*/gim, ' ')
    .replace(/facet\s+normal[^\n]*/gi, ' ')
    .replace(/\bvertex\b/gi, ' ');
  const coords: number[] = [];
  for (const m of body.matchAll(/[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/g)) {
    coords.push(parseFloat(m[0]));
  }
  const count = Math.floor(coords.length / 9);
  if (count > MAX_IMPORT_TRIANGLES) {
    throw new Error(
      `Mesh too large: ${count.toLocaleString()} triangles (limit ${MAX_IMPORT_TRIANGLES.toLocaleString()}). Decimate it first.`,
    );
  }
  const triangles = new Float32Array(count * 9);
  for (let i = 0; i < count * 9; i++) triangles[i] = coords[i];
  return { kind: 'stl', triangleCount: count, triangles };
}

/**
 * Parse an uploaded STL, binary or ASCII, into the same {@link StlValue} the
 * export side produces. Throws with a readable message on anything unusable.
 */
export function parseStl(input: ArrayBuffer | Uint8Array): StlValue {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new Error('That file is empty.');
  const stl = looksBinary(bytes)
    ? parseBinaryStl(bytes)
    : parseAsciiStl(new TextDecoder('utf-8').decode(bytes));
  if (stl.triangleCount === 0) {
    throw new Error('No triangles found — is that really an STL file?');
  }
  return stl;
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
/** Optimize mode collapses flat regions, so it can take much larger images. */
export const MAX_STL_PIXELS_OPTIMIZED = 6_000_000; // ~2450×2450
/** Ceiling on output triangles (each is 9 floats = 36 bytes in the buffer). */
export const MAX_STL_TRIANGLES = 8_000_000;

/**
 * Build a solid STL from a heightmap. Two passes over the geometry — count the
 * triangles, then fill an exactly-sized Float32Array directly — so it scales to
 * high-resolution heightmaps without allocating millions of throwaway arrays.
 */
export function heightmapToStl(img: RasterImage, opts: HeightmapOptions): StlValue {
  const pixels = img.width * img.height;
  // Optimize mode merges flat regions, so it can accept much larger images; the
  // smooth per-pixel mesher keeps the tighter cap.
  const cap = opts.optimize ? MAX_STL_PIXELS_OPTIMIZED : MAX_STL_PIXELS;
  if (pixels > cap) {
    const limit = opts.optimize ? '~2400×2400' : '~1000×1000';
    throw new Error(
      `Heightmap too large (${pixels.toLocaleString()} px) — resize it below ${limit} before generating an STL.`,
    );
  }
  // Smooth the height field once (if requested); reused by both passes.
  const field = computeHeightField(img, opts);
  const build = opts.optimize ? buildOptimizedMesh : buildMesh;
  // Pass 1: count triangles (no allocation; wall count varies with the terrain).
  let count = 0;
  build(
    img,
    opts,
    () => {
      count++;
    },
    field,
  );
  if (count > MAX_STL_TRIANGLES) {
    throw new Error(
      `Mesh too detailed (${count.toLocaleString()} triangles) — raise "Min white" to include fewer pixels${opts.optimize ? ', lower "Height levels",' : ''} or resize the heightmap smaller.`,
    );
  }
  // Pass 2: fill the buffer directly.
  const triangles = new Float32Array(count * 9);
  let o = 0;
  build(
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
