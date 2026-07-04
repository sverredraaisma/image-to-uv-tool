import { describe, it, expect } from 'vitest';
import { createImage } from './image';
import { magicWandMask, selectRegion } from './magicWand';
import type { RasterImage } from '../types';

// 4x1 image: [red, red, blue, blue]
function halfImage(): RasterImage {
  const img = createImage(4, 1, [0, 0, 0, 255]);
  img.data.set([255, 0, 0, 255], 0);
  img.data.set([255, 0, 0, 255], 4);
  img.data.set([0, 0, 255, 255], 8);
  img.data.set([0, 0, 255, 255], 12);
  return img;
}

describe('selectRegion', () => {
  it('selects a contiguous same-colour region', () => {
    const sel = selectRegion(halfImage(), [{ x: 0, y: 0 }], 10);
    expect([...sel]).toEqual([1, 1, 0, 0]);
  });
  it('a high tolerance selects everything contiguous', () => {
    const sel = selectRegion(halfImage(), [{ x: 0, y: 0 }], 255);
    expect([...sel]).toEqual([1, 1, 1, 1]);
  });
  it('multiple seeds union their selections', () => {
    const sel = selectRegion(
      halfImage(),
      [
        { x: 0, y: 0 },
        { x: 3, y: 0 },
      ],
      10,
    );
    expect([...sel]).toEqual([1, 1, 1, 1]);
  });
  it('ignores out-of-bounds seeds', () => {
    const sel = selectRegion(halfImage(), [{ x: 99, y: 99 }], 255);
    expect([...sel]).toEqual([0, 0, 0, 0]);
  });
});

describe('magicWandMask', () => {
  it('produces a white/black opaque mask', () => {
    const mask = magicWandMask(halfImage(), [{ x: 0, y: 0 }], 10);
    expect([...mask.data.slice(0, 4)]).toEqual([255, 255, 255, 255]); // selected -> white
    expect([...mask.data.slice(8, 12)]).toEqual([0, 0, 0, 255]); // unselected -> black
  });
});
