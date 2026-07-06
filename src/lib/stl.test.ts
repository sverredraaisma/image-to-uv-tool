import { describe, it, expect } from 'vitest';
import { createImage } from './image';
import { heightmapToMesh, heightmapToStl, stlToAscii, stlToBinary, stlToObj } from './stl';

describe('heightmapToStl', () => {
  it('produces a watertight box for a single included pixel', () => {
    const img = createImage(1, 1, [255, 255, 255, 255]);
    const mesh = heightmapToMesh(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 2 });
    // top(2) + bottom(2) + 4 full walls(2 each) = 12
    expect(mesh.tris.length).toBe(12);
  });

  it('excludes pixels below the min-white threshold', () => {
    const img = createImage(2, 1, [0, 0, 0, 255]);
    // make pixel 0 white, pixel 1 stays black
    img.data.set([255, 255, 255, 255], 0);
    const stl = heightmapToStl(img, { minWhite: 128, baseThickness: 0, depthRange: 10, width: 2 });
    // only the white pixel contributes -> single box = 12 triangles
    expect(stl.triangleCount).toBe(12);
  });

  it('serialises valid ASCII STL text', () => {
    const img = createImage(2, 2, [255, 255, 255, 255]);
    const stl = heightmapToStl(img, { minWhite: -1, baseThickness: 1, depthRange: 5, width: 4 });
    const text = stlToAscii(stl);
    expect(text.startsWith('solid heightmap')).toBe(true);
    expect(text.trimEnd().endsWith('endsolid heightmap')).toBe(true);
    expect(text.match(/facet normal/g)?.length ?? 0).toBe(stl.triangleCount);
    expect(text).not.toMatch(/NaN/);
  });

  it('caps facets and marks truncation when maxTriangles is given', () => {
    const img = createImage(2, 2, [255, 255, 255, 255]);
    const stl = heightmapToStl(img, { minWhite: -1, baseThickness: 1, depthRange: 5, width: 4 });
    expect(stl.triangleCount).toBeGreaterThan(3);
    const text = stlToAscii(stl, 'heightmap', 3);
    expect(text.match(/facet normal/g)?.length ?? 0).toBe(3); // capped
    expect(text).toMatch(/# … \d+ more facets/); // truncation marker
    expect(text.trimEnd().endsWith('endsolid heightmap')).toBe(true);
  });

  it('serialises Wavefront OBJ with one vertex per corner and valid 1-based faces', () => {
    const img = createImage(1, 1, [255, 255, 255, 255]);
    const stl = heightmapToStl(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 2 });
    const obj = stlToObj(stl);
    const verts = obj.match(/^v /gm)?.length ?? 0;
    const faces = obj.match(/^f /gm)?.length ?? 0;
    expect(verts).toBe(stl.triangleCount * 3);
    expect(faces).toBe(stl.triangleCount);
    expect(obj).not.toMatch(/NaN/);
    // Every face index is within [1, vertexCount].
    for (const m of obj.matchAll(/^f (\d+) (\d+) (\d+)$/gm)) {
      for (let i = 1; i <= 3; i++) {
        const idx = Number(m[i]);
        expect(idx).toBeGreaterThanOrEqual(1);
        expect(idx).toBeLessThanOrEqual(verts);
      }
    }
  });

  it('serialises binary STL with the correct size and triangle count', () => {
    const img = createImage(1, 1, [255, 255, 255, 255]);
    const stl = heightmapToStl(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 2 });
    const bin = stlToBinary(stl);
    expect(bin.byteLength).toBe(84 + stl.triangleCount * 50);
    const count = new DataView(bin.buffer, bin.byteOffset).getUint32(80, true);
    expect(count).toBe(stl.triangleCount);
  });

  it('handles a high-resolution heightmap (previously over the cap)', () => {
    const img = createImage(400, 400, [255, 255, 255, 255]); // 160k px — was rejected before
    const stl = heightmapToStl(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 100 });
    expect(stl.triangleCount).toBeGreaterThan(0);
    expect(stl.triangles.length).toBe(stl.triangleCount * 9);
    expect([...stl.triangles.slice(0, 90)].some(Number.isNaN)).toBe(false);
  });

  it('the two-pass build matches the (array-based) mesh builder exactly', () => {
    const img = createImage(3, 3, [10, 10, 10, 255]);
    img.data.set([255, 255, 255, 255], (1 * 3 + 1) * 4); // vary a height → step walls
    const opts = { minWhite: -1, baseThickness: 1, depthRange: 8, width: 6 };
    const stl = heightmapToStl(img, opts);
    const mesh = heightmapToMesh(img, opts);
    expect(stl.triangleCount).toBe(mesh.tris.length);
    for (let i = 0; i < mesh.tris.length; i++) {
      for (let j = 0; j < 9; j++) expect(stl.triangles[i * 9 + j]).toBeCloseTo(mesh.tris[i][j], 5);
    }
  });

  it('rejects a heightmap above the pixel ceiling', () => {
    const img = createImage(1001, 1001, [255, 255, 255, 255]); // 1.002M > 1M limit
    expect(() => heightmapToStl(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 100 })).toThrow(
      /too large/i,
    );
  });

  it('height scales with white value and base thickness', () => {
    const white = createImage(1, 1, [255, 255, 255, 255]);
    const stl = heightmapToStl(white, { minWhite: -1, baseThickness: 2, depthRange: 10, width: 1 });
    // max Z should be base(2) + depth(10) = 12 somewhere in the vertices
    expect(stlToAscii(stl)).toMatch(/ 12($|\s)/);
  });
});

// --- Mesh integrity: winding orientation & watertightness (guards H2) -------

type Vec3 = [number, number, number];

function triNormal(a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const vx = c[0] - a[0],
    vy = c[1] - a[1],
    vz = c[2] - a[2];
  return [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
}

function meshTris(mesh: { tris: number[][] }): { a: Vec3; b: Vec3; c: Vec3 }[] {
  return mesh.tris.map((t) => ({
    a: [t[0], t[1], t[2]] as Vec3,
    b: [t[3], t[4], t[5]] as Vec3,
    c: [t[6], t[7], t[8]] as Vec3,
  }));
}

describe('mesh orientation (H2 regression)', () => {
  it('every facet of a convex box points outward from its centre', () => {
    // A single included pixel is a convex box: an outward normal must have a
    // positive dot with (facet centroid - box centre). A backward-wound wall
    // (the pre-fix bug) fails this for the two Y-side faces.
    const img = createImage(1, 1, [255, 255, 255, 255]);
    const mesh = heightmapToMesh(img, { minWhite: -1, baseThickness: 3, depthRange: 7, width: 2 });
    const zTop = 3 + 7; // baseThickness + depthRange
    const centre: Vec3 = [1, 1, zTop / 2]; // box spans x,y in [0,2], z in [0,zTop]
    for (const { a, b, c } of meshTris(mesh)) {
      const n = triNormal(a, b, c);
      const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const outward: Vec3 = [centroid[0] - centre[0], centroid[1] - centre[1], centroid[2] - centre[2]];
      const dot = n[0] * outward[0] + n[1] * outward[1] + n[2] * outward[2];
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('produces sloped surfaces, not stairs (intermediate averaged corner heights)', () => {
    // One white pixel among black ones. The old voxel mesher only ever produced
    // vertices at the discrete pixel heights (0 or 10) joined by vertical walls;
    // the grid mesher averages corners, so shared corners sit at in-between
    // heights → the top surface tilts (gentle slopes) instead of stepping.
    const img = createImage(2, 2, [0, 0, 0, 255]);
    img.data.set([255, 255, 255, 255], 0); // pixel (0,0) = white
    const mesh = heightmapToMesh(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 2 });
    const zs = new Set<number>();
    for (const t of mesh.tris) {
      zs.add(t[2]);
      zs.add(t[5]);
      zs.add(t[8]);
    }
    expect([...zs].filter((z) => z > 0.01 && z < 9.99).length).toBeGreaterThan(0); // slope
    expect(zs.has(2.5)).toBe(true); // corner of 1 white + 3 black pixels → 0.25·10
  });

  it('the Gaussian smooth option softens (lowers) an isolated peak', () => {
    const img = createImage(5, 5, [0, 0, 0, 255]);
    img.data.set([255, 255, 255, 255], (2 * 5 + 2) * 4); // one central white pixel = a spike
    const opts = { minWhite: -1, baseThickness: 0, depthRange: 100, width: 5 };
    const sharp = heightmapToStl(img, opts);
    const blurred = heightmapToStl(img, { ...opts, smooth: 1.5 });
    const maxZ = (s: ReturnType<typeof heightmapToStl>) => Math.max(...s.triangles);
    // The pre-blur spreads the spike across neighbours → a lower, gentler peak.
    expect(maxZ(blurred)).toBeLessThan(maxZ(sharp));
    // A uniform field is unchanged by the blur (sanity: no drift).
    const flat = createImage(4, 4, [200, 200, 200, 255]);
    expect(maxZ(heightmapToStl(flat, { ...opts, smooth: 2 }))).toBeCloseTo(
      maxZ(heightmapToStl(flat, opts)),
      3,
    );
  });

  it('a masked heightmap with an interior hole stays watertight', () => {
    // 3×3 with the centre pixel excluded → a hole the skirt must seal.
    const img = createImage(3, 3, [255, 255, 255, 255]);
    img.data.set([0, 0, 0, 255], (1 * 3 + 1) * 4); // centre black
    const mesh = heightmapToMesh(img, { minWhite: 128, baseThickness: 1, depthRange: 8, width: 6 });
    const key = (p: Vec3) => `${p[0]},${p[1]},${p[2]}`;
    const balance = new Map<string, number>();
    for (const { a, b, c } of meshTris(mesh)) {
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as [Vec3, Vec3][]) {
        balance.set(`${key(u)}->${key(v)}`, (balance.get(`${key(u)}->${key(v)}`) ?? 0) + 1);
        balance.set(`${key(v)}->${key(u)}`, (balance.get(`${key(v)}->${key(u)}`) ?? 0) - 1);
      }
    }
    for (const [, bal] of balance) expect(bal).toBe(0);
  });

  it('produces a watertight mesh (every directed edge has an opposite twin)', () => {
    // In a closed, consistently-wound triangle mesh each directed edge (u->v)
    // is matched by exactly one opposite (v->u). A flipped facet breaks this.
    const img = createImage(2, 2, [255, 255, 255, 255]);
    const mesh = heightmapToMesh(img, { minWhite: -1, baseThickness: 1, depthRange: 10, width: 4 });
    const key = (p: Vec3) => `${p[0]},${p[1]},${p[2]}`;
    const edges = new Map<string, number>();
    const bump = (u: Vec3, v: Vec3) => {
      const f = `${key(u)}->${key(v)}`;
      const r = `${key(v)}->${key(u)}`;
      edges.set(f, (edges.get(f) ?? 0) + 1);
      edges.set(r, (edges.get(r) ?? 0) - 1);
    };
    for (const { a, b, c } of meshTris(mesh)) {
      bump(a, b);
      bump(b, c);
      bump(c, a);
    }
    for (const [, balance] of edges) expect(balance).toBe(0);
  });
});

// --- Optimize mode: greedy meshing of equal-height regions -------------------

const stlToMesh = (stl: ReturnType<typeof heightmapToStl>): { tris: number[][] } => {
  const tris: number[][] = [];
  for (let i = 0; i < stl.triangleCount; i++) tris.push([...stl.triangles.slice(i * 9, i * 9 + 9)]);
  return { tris };
};

describe('heightmapToStl optimize (greedy meshing)', () => {
  it('collapses a uniform block to a 12-triangle box at any resolution', () => {
    for (const n of [4, 40, 200]) {
      const img = createImage(n, n, [255, 255, 255, 255]);
      const stl = heightmapToStl(img, {
        minWhite: -1,
        baseThickness: 0,
        depthRange: 10,
        width: n,
        optimize: true,
      });
      // top(2) + bottom(2) + 4 merged walls(2 each) = 12, independent of n.
      expect(stl.triangleCount).toBe(12);
    }
  });

  it('the merged box is watertight and outward-wound', () => {
    const img = createImage(8, 8, [255, 255, 255, 255]);
    const stl = heightmapToStl(img, {
      minWhite: -1,
      baseThickness: 3,
      depthRange: 7,
      width: 8,
      optimize: true,
    });
    const mesh = stlToMesh(stl);
    // Every directed edge has an opposite twin (closed, consistent winding).
    const key = (p: Vec3) => `${p[0]},${p[1]},${p[2]}`;
    const edges = new Map<string, number>();
    for (const { a, b, c } of meshTris(mesh)) {
      for (const [u, v] of [
        [a, b],
        [b, c],
        [c, a],
      ] as [Vec3, Vec3][]) {
        edges.set(`${key(u)}->${key(v)}`, (edges.get(`${key(u)}->${key(v)}`) ?? 0) + 1);
        edges.set(`${key(v)}->${key(u)}`, (edges.get(`${key(v)}->${key(u)}`) ?? 0) - 1);
      }
    }
    for (const [, bal] of edges) expect(bal).toBe(0);
    // Outward normals from the box centre.
    const centre: Vec3 = [4, 4, (3 + 7) / 2];
    for (const { a, b, c } of meshTris(mesh)) {
      const n = triNormal(a, b, c);
      const cen: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3];
      const dot = n[0] * (cen[0] - centre[0]) + n[1] * (cen[1] - centre[1]) + n[2] * (cen[2] - centre[2]);
      expect(dot).toBeGreaterThan(0);
    }
  });

  it('is dramatically smaller than the smooth mesher on flat art', () => {
    const img = createImage(60, 60, [255, 255, 255, 255]);
    const opts = { minWhite: -1, baseThickness: 1, depthRange: 10, width: 60 };
    const smooth = heightmapToStl(img, opts);
    const merged = heightmapToStl(img, { ...opts, optimize: true });
    expect(merged.triangleCount).toBe(12);
    expect(smooth.triangleCount).toBeGreaterThan(merged.triangleCount * 100);
    expect([...merged.triangles].some(Number.isNaN)).toBe(false);
  });

  it('meshes a two-level split without NaN and stays compact', () => {
    // Left half low, right half high.
    const img = createImage(20, 20, [40, 40, 40, 255]);
    for (let y = 0; y < 20; y++)
      for (let x = 10; x < 20; x++) img.data.set([220, 220, 220, 255], (y * 20 + x) * 4);
    const stl = heightmapToStl(img, {
      minWhite: -1,
      baseThickness: 1,
      depthRange: 10,
      width: 20,
      optimize: true,
      heightLevels: 8,
    });
    expect(stl.triangleCount).toBeGreaterThan(0);
    expect(stl.triangleCount).toBeLessThan(60); // two plateaus + a seam, not per-pixel
    expect([...stl.triangles].some(Number.isNaN)).toBe(false);
  });

  it('fewer height levels merge more (never more triangles) on a gradient', () => {
    const img = createImage(64, 8);
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 64; x++) {
        const v = Math.round((x / 63) * 255);
        img.data.set([v, v, v, 255], (y * 64 + x) * 4);
      }
    const opts = { minWhite: -1, baseThickness: 0, depthRange: 10, width: 64, optimize: true };
    const coarse = heightmapToStl(img, { ...opts, heightLevels: 4 });
    const fine = heightmapToStl(img, { ...opts, heightLevels: 64 });
    expect(coarse.triangleCount).toBeLessThanOrEqual(fine.triangleCount);
  });

  it('accepts a heightmap larger than the smooth-mode cap when optimizing', () => {
    const img = createImage(1100, 1000, [255, 255, 255, 255]); // 1.1M px > 1M smooth cap
    const opts = { minWhite: -1, baseThickness: 0, depthRange: 10, width: 100 };
    expect(() => heightmapToStl(img, opts)).toThrow(/too large/i); // smooth rejects
    const merged = heightmapToStl(img, { ...opts, optimize: true });
    expect(merged.triangleCount).toBe(12); // optimize accepts and collapses it
  });
});
