import { describe, it, expect } from 'vitest';
import { channelPack, createImage, linearGradient, normalMap, resizeBilinear, valueNoise } from './image';
import type { RasterImage } from '../types';

const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

describe('normalMap', () => {
  it('turns a flat heightmap into the canonical flat-blue normal', () => {
    const flat = createImage(3, 3, [120, 120, 120, 255]);
    const out = normalMap(flat, 2);
    expect(px(out, 1, 1)).toEqual([128, 128, 255, 255]);
    expect(px(out, 0, 0)).toEqual([128, 128, 255, 255]);
  });

  it('tilts the normal away from an uphill gradient', () => {
    // Height increases left→right, so the normal tilts toward -X (R < 128).
    const grad = linearGradient(5, 1, [0, 0, 0, 255], [255, 255, 255, 255], true);
    const out = normalMap(grad, 1);
    const [r, , b] = px(out, 2, 0);
    expect(r).toBeLessThan(128);
    expect(b).toBeGreaterThan(128); // still mostly facing +Z
  });

  it('preserves dimensions and opacity', () => {
    const out = normalMap(createImage(4, 6, [50, 50, 50, 255]), 1);
    expect([out.width, out.height]).toEqual([4, 6]);
    expect(px(out, 3, 5)[3]).toBe(255);
  });
});

describe('channelPack', () => {
  it('packs each source luminance into R/G/B/A', () => {
    const r = createImage(1, 1, [100, 100, 100, 255]);
    const g = createImage(1, 1, [200, 200, 200, 255]);
    expect(px(channelPack({ r, g }), 0, 0)).toEqual([100, 200, 0, 255]);
  });

  it('defaults missing channels (RGB→0, A→255) and sizes to the first source', () => {
    const b = createImage(2, 2, [0, 0, 180, 255]); // luminance of pure blue
    const out = channelPack({ b });
    expect([out.width, out.height]).toEqual([2, 2]);
    const [rr, gg, , aa] = px(out, 0, 0);
    expect(rr).toBe(0);
    expect(gg).toBe(0);
    expect(aa).toBe(255);
  });

  it('resizes a mismatched source to the reference size', () => {
    const r = createImage(2, 2, [255, 255, 255, 255]);
    const a = createImage(1, 1, [0, 0, 0, 255]); // luminance 0 → alpha 0
    const out = channelPack({ r, a });
    expect([out.width, out.height]).toEqual([2, 2]);
    expect(px(out, 1, 1)[3]).toBe(0);
  });
});

describe('valueNoise', () => {
  it('is deterministic for a given seed and varies by seed', () => {
    const a = valueNoise(16, 16, 4, 7);
    const b = valueNoise(16, 16, 4, 7);
    const c = valueNoise(16, 16, 4, 8);
    expect([...a.data]).toEqual([...b.data]);
    expect([...a.data]).not.toEqual([...c.data]);
  });

  it('produces greyscale values in range at the requested size', () => {
    const n = valueNoise(8, 8, 3, 1);
    expect([n.width, n.height]).toEqual([8, 8]);
    for (let i = 0; i < n.data.length; i += 4) {
      expect(n.data[i]).toBe(n.data[i + 1]);
      expect(n.data[i + 1]).toBe(n.data[i + 2]);
      expect(n.data[i]).toBeGreaterThanOrEqual(0);
      expect(n.data[i]).toBeLessThanOrEqual(255);
      expect(n.data[i + 3]).toBe(255);
    }
  });
});

describe('resizeBilinear', () => {
  it('is an identity when the size is unchanged', () => {
    const img = createImage(2, 2, [10, 20, 30, 40]);
    expect([...resizeBilinear(img, 2, 2).data]).toEqual([...img.data]);
  });

  it('interpolates (unlike nearest-neighbour) when upscaling', () => {
    const grad = createImage(2, 1, [0, 0, 0, 255]);
    grad.data.set([200, 200, 200, 255], 4); // px1 = 200
    const up = resizeBilinear(grad, 3, 1);
    expect(px(up, 0, 0)[0]).toBe(0);
    expect(px(up, 1, 0)[0]).toBe(100); // midpoint average
    expect(px(up, 2, 0)[0]).toBe(200);
  });
});
