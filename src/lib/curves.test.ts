import { describe, it, expect } from 'vitest';
import { applyCurve, createImage, curveLut } from './image';

const px = (img: ReturnType<typeof createImage>, x = 0, y = 0) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

describe('curveLut', () => {
  it('an identity curve maps every value to itself', () => {
    const lut = curveLut([
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ]);
    for (const v of [0, 1, 64, 128, 200, 255]) expect(lut[v]).toBe(v);
  });

  it('empty points fall back to identity', () => {
    const lut = curveLut([]);
    expect([lut[0], lut[128], lut[255]]).toEqual([0, 128, 255]);
  });

  it('interpolates linearly between control points', () => {
    // 0→0, 128→255 (steep), 255→255 (flat top)
    const lut = curveLut([
      { x: 0, y: 0 },
      { x: 128, y: 255 },
      { x: 255, y: 255 },
    ]);
    expect(lut[128]).toBe(255);
    expect(lut[64]).toBe(128); // halfway up the steep segment
    expect(lut[200]).toBe(255); // flat top
  });

  it('clamps points and flattens below/above the endpoints', () => {
    const lut = curveLut([
      { x: 50, y: 20 },
      { x: 200, y: 240 },
    ]);
    expect(lut[0]).toBe(20); // below first point → held
    expect(lut[255]).toBe(240); // above last point → held
  });
});

describe('applyCurve', () => {
  const img = createImage(1, 1, [40, 120, 200, 255]);

  it('applies to all channels for rgb', () => {
    const lut = curveLut([
      { x: 0, y: 0 },
      { x: 255, y: 0 },
    ]); // everything → 0
    expect(px(applyCurve(img, lut, 'rgb'))).toEqual([0, 0, 0, 255]);
  });

  it('applies to a single channel only', () => {
    const lut = curveLut([
      { x: 0, y: 255 },
      { x: 255, y: 255 },
    ]); // everything → 255
    expect(px(applyCurve(img, lut, 'g'))).toEqual([40, 255, 200, 255]); // only green changed
  });
});
