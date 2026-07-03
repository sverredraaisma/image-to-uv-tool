import { describe, it, expect } from 'vitest';
import { createImage } from './image';
import { heightmapToMesh, heightmapToStl } from './stl';

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

  it('emits valid ASCII STL text', () => {
    const img = createImage(2, 2, [255, 255, 255, 255]);
    const stl = heightmapToStl(img, { minWhite: -1, baseThickness: 1, depthRange: 5, width: 4 });
    expect(stl.text.startsWith('solid heightmap')).toBe(true);
    expect(stl.text.trimEnd().endsWith('endsolid heightmap')).toBe(true);
    const facets = stl.text.match(/facet normal/g)?.length ?? 0;
    expect(facets).toBe(stl.triangleCount);
    // no NaN coordinates
    expect(stl.text).not.toMatch(/NaN/);
  });

  it('height scales with white value and base thickness', () => {
    const white = createImage(1, 1, [255, 255, 255, 255]);
    const stl = heightmapToStl(white, { minWhite: -1, baseThickness: 2, depthRange: 10, width: 1 });
    // max Z should be base(2) + depth(10) = 12 somewhere in the vertices
    expect(stl.text).toMatch(/ 12($|\s)/);
  });
});
