import { describe, it, expect } from 'vitest';
import { createImage, linearGradient, rotate, seamlessTile, splitCompare, whiteBalance } from './image';
import type { RasterImage } from '../types';

const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

describe('rotate (arbitrary angle)', () => {
  it('is ~identity at 0° and preserves the centre pixel', () => {
    const img = createImage(3, 3, [200, 100, 50, 255]);
    const out = rotate(img, 0);
    expect([out.width, out.height]).toEqual([3, 3]);
    expect(px(out, 1, 1)).toEqual([200, 100, 50, 255]);
  });

  it('expands the canvas for a 45° rotation and leaves the corners transparent', () => {
    const img = createImage(10, 10, [255, 255, 255, 255]);
    const out = rotate(img, 45);
    expect(out.width).toBeGreaterThan(10); // diagonal is larger
    expect(px(out, 0, 0)[3]).toBe(0); // corner outside the rotated square
    expect(px(out, Math.floor(out.width / 2), Math.floor(out.height / 2))[3]).toBe(255); // centre covered
  });
});

describe('whiteBalance', () => {
  it('warms (more red, less blue) for positive temperature', () => {
    const img = createImage(1, 1, [100, 100, 100, 255]);
    const out = whiteBalance(img, 100, 0);
    const [r, g, b] = px(out, 0, 0);
    expect(r).toBeGreaterThan(100);
    expect(g).toBe(100);
    expect(b).toBeLessThan(100);
  });
});

describe('seamlessTile', () => {
  it('makes the left and right edges wrap-continuous', () => {
    const grad = linearGradient(8, 1, [0, 0, 0, 255], [255, 255, 255, 255], true);
    const out = seamlessTile(grad, 1);
    // Edge pixels come from the half-offset copy, whose wrapped neighbours are
    // adjacent source pixels — so |left - right| is small (was maximal before).
    const left = px(out, 0, 0)[0];
    const right = px(out, 7, 0)[0];
    expect(Math.abs(left - right)).toBeLessThan(60);
    expect([out.width, out.height]).toEqual([8, 1]);
  });
});

describe('splitCompare', () => {
  it('shows A on the left and B on the right of the split', () => {
    const a = createImage(4, 1, [255, 0, 0, 255]);
    const b = createImage(4, 1, [0, 0, 255, 255]);
    const out = splitCompare(a, b, 0.5, false);
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]); // A side
    expect(px(out, 3, 0)).toEqual([0, 0, 255, 255]); // B side
  });

  it('resizes B to match A', () => {
    const a = createImage(4, 4, [10, 10, 10, 255]);
    const b = createImage(2, 2, [20, 20, 20, 255]);
    const out = splitCompare(a, b, 0, false); // all B
    expect([out.width, out.height]).toEqual([4, 4]);
    expect(px(out, 3, 3)).toEqual([20, 20, 20, 255]);
  });
});
