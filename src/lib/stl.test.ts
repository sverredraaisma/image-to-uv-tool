import { describe, it, expect } from 'vitest';
import { createImage } from './image';
import { heightmapToMesh, heightmapToStl, stlToAscii, stlToBinary } from './stl';

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

  it('serialises binary STL with the correct size and triangle count', () => {
    const img = createImage(1, 1, [255, 255, 255, 255]);
    const stl = heightmapToStl(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 2 });
    const bin = stlToBinary(stl);
    expect(bin.byteLength).toBe(84 + stl.triangleCount * 50);
    const count = new DataView(bin.buffer, bin.byteOffset).getUint32(80, true);
    expect(count).toBe(stl.triangleCount);
  });

  it('rejects an over-large heightmap instead of freezing', () => {
    const img = createImage(400, 400, [255, 255, 255, 255]); // 160k > 90k limit
    expect(() =>
      heightmapToStl(img, { minWhite: -1, baseThickness: 0, depthRange: 10, width: 100 }),
    ).toThrow(/too detailed/i);
  });

  it('height scales with white value and base thickness', () => {
    const white = createImage(1, 1, [255, 255, 255, 255]);
    const stl = heightmapToStl(white, { minWhite: -1, baseThickness: 2, depthRange: 10, width: 1 });
    // max Z should be base(2) + depth(10) = 12 somewhere in the vertices
    expect(stlToAscii(stl)).toMatch(/ 12($|\s)/);
  });
});
