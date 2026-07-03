import { describe, it, expect } from 'vitest';
import {
  alphaCleanup,
  combine,
  createImage,
  distanceToOpaque,
  hexToRgba,
  invert,
  outline,
  resize,
} from './image';
import type { RasterImage } from '../types';

function solid(w: number, h: number, rgba: [number, number, number, number]): RasterImage {
  return createImage(w, h, rgba);
}
const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

describe('createImage / hexToRgba', () => {
  it('fills every pixel', () => {
    const img = solid(2, 2, [10, 20, 30, 40]);
    expect([...img.data.slice(0, 4)]).toEqual([10, 20, 30, 40]);
    expect(img.data.length).toBe(2 * 2 * 4);
  });
  it('parses hex colours', () => {
    expect(hexToRgba('#ff0000')).toEqual([255, 0, 0, 255]);
    expect(hexToRgba('#00ff0080')).toEqual([0, 255, 0, 128]);
    expect(hexToRgba('#abc')).toEqual([170, 187, 204, 255]);
  });
});

describe('invert', () => {
  it('inverts only selected channels', () => {
    const img = solid(1, 1, [10, 20, 30, 40]);
    const out = invert(img, { r: true, g: false, b: true, a: false });
    expect(px(out, 0, 0)).toEqual([245, 20, 225, 40]);
  });
});

describe('combine', () => {
  it('multiply darkens', () => {
    const a = solid(1, 1, [255, 128, 0, 255]);
    const b = solid(1, 1, [128, 128, 128, 255]);
    const out = combine([a, b], 'multiply');
    expect(px(out, 0, 0)).toEqual([128, 64, 0, 255]);
  });
  it('max lightens', () => {
    const out = combine([solid(1, 1, [10, 200, 0, 255]), solid(1, 1, [50, 50, 50, 255])], 'max');
    expect(px(out, 0, 0)).toEqual([50, 200, 50, 255]);
  });
  it('A over B respects alpha (opaque A fully covers B)', () => {
    const a = solid(1, 1, [255, 0, 0, 255]);
    const b = solid(1, 1, [0, 0, 255, 255]);
    const out = combine([a, b], 'over');
    expect(px(out, 0, 0)).toEqual([255, 0, 0, 255]);
  });
  it('transparent A shows B through', () => {
    const a = solid(1, 1, [255, 0, 0, 0]);
    const b = solid(1, 1, [0, 0, 255, 255]);
    const out = combine([a, b], 'over');
    expect(px(out, 0, 0)).toEqual([0, 0, 255, 255]);
  });
  it('min darkens per channel', () => {
    const out = combine([solid(1, 1, [10, 200, 0, 255]), solid(1, 1, [50, 50, 50, 255])], 'min');
    expect(px(out, 0, 0)).toEqual([10, 50, 0, 255]);
  });
  it('add clamps at 255', () => {
    const out = combine([solid(1, 1, [100, 200, 0, 255]), solid(1, 1, [200, 100, 0, 255])], 'add');
    expect(px(out, 0, 0)).toEqual([255, 255, 0, 255]);
  });
  it('subtract clamps at 0 (per channel, incl. alpha)', () => {
    const out = combine([solid(1, 1, [100, 50, 0, 255]), solid(1, 1, [30, 80, 10, 255])], 'subtract');
    expect(px(out, 0, 0)).toEqual([70, 0, 0, 0]);
  });
  it('difference is the absolute per-channel delta', () => {
    const out = combine([solid(1, 1, [100, 50, 255, 255]), solid(1, 1, [30, 80, 10, 255])], 'difference');
    expect(px(out, 0, 0)).toEqual([70, 30, 245, 0]);
  });
  it('average is the per-channel mean', () => {
    const out = combine([solid(1, 1, [100, 0, 200, 100]), solid(1, 1, [200, 100, 0, 50])], 'average');
    expect(px(out, 0, 0)).toEqual([150, 50, 100, 75]);
  });
  it('screen with black leaves A unchanged', () => {
    const out = combine([solid(1, 1, [100, 200, 50, 255]), solid(1, 1, [0, 0, 0, 0])], 'screen');
    expect(px(out, 0, 0)).toEqual([100, 200, 50, 255]);
  });
  it('B over A puts the second image on top', () => {
    const a = solid(1, 1, [255, 0, 0, 0]); // transparent red
    const b = solid(1, 1, [0, 0, 255, 255]); // opaque blue
    expect(px(combine([a, b], 'under'), 0, 0)).toEqual([0, 0, 255, 255]);
  });
  it('resizes mismatched inputs to the first image', () => {
    const a = solid(2, 2, [0, 0, 0, 255]);
    const b = solid(4, 4, [255, 255, 255, 255]);
    const out = combine([a, b], 'max');
    expect(out.width).toBe(2);
    expect(out.height).toBe(2);
  });
});

describe('resize', () => {
  it('nearest-neighbour up/down scales', () => {
    const img = solid(1, 1, [7, 7, 7, 255]);
    const up = resize(img, 3, 3);
    expect(up.width).toBe(3);
    expect(px(up, 2, 2)).toEqual([7, 7, 7, 255]);
  });
});

describe('alphaCleanup', () => {
  it('makes faint pixels transparent', () => {
    const img = solid(1, 1, [100, 100, 100, 10]);
    const out = alphaCleanup(img, 128, 'transparent');
    expect(px(out, 0, 0)[3]).toBe(0);
  });
  it('snaps faint pixels to opaque black', () => {
    const img = solid(1, 1, [100, 100, 100, 10]);
    const out = alphaCleanup(img, 128, 'black');
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]);
  });
  it('leaves strong pixels untouched', () => {
    const img = solid(1, 1, [100, 100, 100, 200]);
    const out = alphaCleanup(img, 128, 'transparent');
    expect(px(out, 0, 0)).toEqual([100, 100, 100, 200]);
  });
});

describe('distanceToOpaque / outline', () => {
  it('computes zero distance on opaque pixels', () => {
    const img = createImage(3, 3);
    // center opaque
    const i = (1 * 3 + 1) * 4;
    img.data[i + 3] = 255;
    const dist = distanceToOpaque(img);
    expect(dist[1 * 3 + 1]).toBe(0);
    expect(dist[0]).toBeGreaterThan(0);
  });
  it('draws an outline around the opaque center pixel', () => {
    const img = createImage(5, 5);
    const c = (2 * 5 + 2) * 4;
    img.data[c] = 255;
    img.data[c + 3] = 255; // opaque red center
    const out = outline(img, 1, [0, 255, 0, 255]);
    // a neighbouring (originally transparent) pixel is now green
    expect(px(out, 1, 2)).toEqual([0, 255, 0, 255]);
    // center keeps original colour
    expect(px(out, 2, 2)).toEqual([255, 0, 0, 255]);
  });
});
