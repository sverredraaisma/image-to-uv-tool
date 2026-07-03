import { describe, it, expect } from 'vitest';
import {
  applyMask,
  boxBlur,
  brightnessContrast,
  createImage,
  crop,
  extractChannel,
  grayscale,
  maskCombine,
  morphology,
  posterize,
  threshold,
  transform,
} from './image';
import type { RasterImage } from '../types';

const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};
function set(img: RasterImage, x: number, y: number, rgba: number[]) {
  img.data.set(rgba, (y * img.width + x) * 4);
}
// 2x2 with four distinct colours: A B / C D
function grid(): RasterImage {
  const img = createImage(2, 2);
  set(img, 0, 0, [10, 0, 0, 255]); // A
  set(img, 1, 0, [20, 0, 0, 255]); // B
  set(img, 0, 1, [30, 0, 0, 255]); // C
  set(img, 1, 1, [40, 0, 0, 255]); // D
  return img;
}

describe('grayscale', () => {
  it('sets rgb to luminance', () => {
    const out = grayscale(createImage(1, 1, [255, 0, 0, 255]));
    expect(px(out, 0, 0)).toEqual([76, 76, 76, 255]); // round(0.299*255)
  });
});

describe('brightnessContrast', () => {
  it('brightness +100 pushes to white, keeps alpha', () => {
    const out = brightnessContrast(createImage(1, 1, [100, 100, 100, 128]), 100, 0);
    expect(px(out, 0, 0)).toEqual([255, 255, 255, 128]);
  });
});

describe('threshold', () => {
  it('binarises by luminance', () => {
    const light = threshold(createImage(1, 1, [200, 200, 200, 255]), 128);
    const dark = threshold(createImage(1, 1, [50, 50, 50, 255]), 128);
    expect(px(light, 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px(dark, 0, 0)).toEqual([0, 0, 0, 255]);
  });
  it('invert flips the result', () => {
    const out = threshold(createImage(1, 1, [200, 200, 200, 255]), 128, true);
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe('crop', () => {
  it('extracts a sub-rectangle, clamped to bounds', () => {
    const out = crop(grid(), 1, 0, 1, 2);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    expect(px(out, 0, 0)).toEqual([20, 0, 0, 255]); // B
    expect(px(out, 0, 1)).toEqual([40, 0, 0, 255]); // D
  });
});

describe('transform', () => {
  it('rotates 90° clockwise', () => {
    // A B / C D  ->  C A / D B
    const out = transform(grid(), 'rotate90');
    expect(px(out, 0, 0)).toEqual([30, 0, 0, 255]); // C
    expect(px(out, 1, 0)).toEqual([10, 0, 0, 255]); // A
    expect(px(out, 0, 1)).toEqual([40, 0, 0, 255]); // D
    expect(px(out, 1, 1)).toEqual([20, 0, 0, 255]); // B
  });
  it('flips horizontally', () => {
    const out = transform(grid(), 'flipH');
    expect(px(out, 0, 0)).toEqual([20, 0, 0, 255]); // B
    expect(px(out, 1, 0)).toEqual([10, 0, 0, 255]); // A
  });
});

describe('applyMask', () => {
  it('multiplies mask luminance into alpha', () => {
    const img = createImage(2, 1, [255, 255, 255, 255]);
    const mask = createImage(2, 1, [0, 0, 0, 255]);
    mask.data.set([255, 255, 255, 255], 0); // left white, right black
    const out = applyMask(img, mask);
    expect(px(out, 0, 0)[3]).toBe(255);
    expect(px(out, 1, 0)[3]).toBe(0);
  });
});

describe('extractChannel', () => {
  it('extracts a single channel as greyscale', () => {
    const img = createImage(1, 1, [10, 20, 30, 40]);
    expect(px(extractChannel(img, 'r'), 0, 0)).toEqual([10, 10, 10, 255]);
    expect(px(extractChannel(img, 'a'), 0, 0)).toEqual([40, 40, 40, 255]);
  });
});

describe('maskCombine', () => {
  // A = [white, black], B = [white, white]
  const maskA = () => {
    const m = createImage(2, 1, [0, 0, 0, 255]);
    set(m, 0, 0, [255, 255, 255, 255]);
    return m;
  };
  const maskB = () => createImage(2, 1, [255, 255, 255, 255]);
  const on = (m: ReturnType<typeof maskA>, x: number) => px(m, x, 0)[0] === 255;

  it('AND keeps the intersection', () => {
    const r = maskCombine(maskA(), maskB(), 'and');
    expect([on(r, 0), on(r, 1)]).toEqual([true, false]);
  });
  it('OR keeps the union', () => {
    const r = maskCombine(maskA(), maskB(), 'or');
    expect([on(r, 0), on(r, 1)]).toEqual([true, true]);
  });
  it('subtract removes B from A', () => {
    const r = maskCombine(maskA(), maskB(), 'subtract');
    expect([on(r, 0), on(r, 1)]).toEqual([false, false]);
  });
  it('XOR keeps the symmetric difference', () => {
    const r = maskCombine(maskA(), maskB(), 'xor');
    expect([on(r, 0), on(r, 1)]).toEqual([false, true]);
  });
});

describe('posterize', () => {
  it('snaps channels to the nearest of N levels (2 = black/white)', () => {
    expect(px(posterize(createImage(1, 1, [100, 200, 10, 128]), 2), 0, 0)).toEqual([0, 255, 0, 128]);
  });
  it('keeps a channel that already sits on a level', () => {
    expect(px(posterize(createImage(1, 1, [255, 0, 128, 255]), 3), 0, 0)).toEqual([255, 0, 128, 255]);
  });
});

describe('morphology', () => {
  it('dilate grows a white pixel into its neighbourhood', () => {
    const img = createImage(5, 5); // transparent black
    set(img, 2, 2, [255, 255, 255, 255]);
    const out = morphology(img, 1, 'dilate');
    expect(px(out, 2, 2)).toEqual([255, 255, 255, 255]);
    expect(px(out, 1, 1)).toEqual([255, 255, 255, 255]); // within radius 1
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]); // distance 2 untouched
  });

  it('erode shrinks a white block to its core', () => {
    const img = createImage(5, 5);
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) set(img, x, y, [255, 255, 255, 255]);
    const out = morphology(img, 1, 'erode');
    expect(px(out, 2, 2)).toEqual([255, 255, 255, 255]); // core survives
    expect(px(out, 1, 1)[0]).toBe(0); // edge eaten away
  });

  it('radius 0 is a no-op copy', () => {
    const img = createImage(2, 2, [1, 2, 3, 4]);
    expect([...morphology(img, 0, 'dilate').data]).toEqual([...img.data]);
  });
});

describe('boxBlur', () => {
  it('leaves a uniform image unchanged and preserves size', () => {
    const img = createImage(5, 5, [100, 100, 100, 255]);
    const out = boxBlur(img, 2);
    expect(out.width).toBe(5);
    expect(px(out, 2, 2)).toEqual([100, 100, 100, 255]);
  });
  it('radius 0 is a no-op copy', () => {
    const img = createImage(3, 3, [1, 2, 3, 4]);
    const out = boxBlur(img, 0);
    expect(out).not.toBe(img);
    expect([...out.data]).toEqual([...img.data]);
  });
});
