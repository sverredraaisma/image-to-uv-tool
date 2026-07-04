import { describe, it, expect } from 'vitest';
import {
  applyMask,
  boxBlur,
  brightnessContrast,
  colorKeyMask,
  createImage,
  crop,
  downscaleToMax,
  extractChannel,
  flatten,
  gradientMap,
  grayscale,
  hueSaturation,
  levels,
  linearGradient,
  maskCombine,
  morphology,
  normalize,
  opacity,
  pad,
  pixelate,
  posterize,
  removeColor,
  sharpen,
  sobel,
  threshold,
  tint,
  transform,
  vignette,
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

describe('pad', () => {
  it('adds a transparent border and centres the original', () => {
    const out = pad(createImage(1, 1, [255, 0, 0, 255]), 1);
    expect([out.width, out.height]).toEqual([3, 3]);
    expect(px(out, 1, 1)).toEqual([255, 0, 0, 255]); // original at centre
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 0]); // transparent border
  });
  it('amount 0 is a no-op copy', () => {
    const img = createImage(2, 2, [1, 2, 3, 4]);
    expect([...pad(img, 0).data]).toEqual([...img.data]);
  });
});

describe('crop', () => {
  it('extracts a sub-rectangle', () => {
    const out = crop(grid(), 1, 0, 1, 2);
    expect(out.width).toBe(1);
    expect(out.height).toBe(2);
    expect(px(out, 0, 0)).toEqual([20, 0, 0, 255]); // B
    expect(px(out, 0, 1)).toEqual([40, 0, 0, 255]); // D
  });

  it('clamps an over-sized rectangle without reading past the buffer', () => {
    const out = crop(grid(), 1, 1, 100, 100); // grid is 2×2; only D remains
    expect([out.width, out.height]).toEqual([1, 1]);
    expect(px(out, 0, 0)).toEqual([40, 0, 0, 255]); // D (bottom-right)
    expect([...out.data].some(Number.isNaN)).toBe(false);
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
  it('rotates 180°', () => {
    // A B / C D  ->  D C / B A
    const out = transform(grid(), 'rotate180');
    expect(px(out, 0, 0)).toEqual([40, 0, 0, 255]); // D
    expect(px(out, 1, 0)).toEqual([30, 0, 0, 255]); // C
    expect(px(out, 0, 1)).toEqual([20, 0, 0, 255]); // B
    expect(px(out, 1, 1)).toEqual([10, 0, 0, 255]); // A
  });
  it('rotates 270° clockwise', () => {
    // A B / C D  ->  B D / A C
    const out = transform(grid(), 'rotate270');
    expect(px(out, 0, 0)).toEqual([20, 0, 0, 255]); // B
    expect(px(out, 1, 0)).toEqual([40, 0, 0, 255]); // D
    expect(px(out, 0, 1)).toEqual([10, 0, 0, 255]); // A
    expect(px(out, 1, 1)).toEqual([30, 0, 0, 255]); // C
  });
  it('flips vertically', () => {
    // A B / C D  ->  C D / A B
    const out = transform(grid(), 'flipV');
    expect(px(out, 0, 0)).toEqual([30, 0, 0, 255]); // C
    expect(px(out, 1, 0)).toEqual([40, 0, 0, 255]); // D
    expect(px(out, 0, 1)).toEqual([10, 0, 0, 255]); // A
    expect(px(out, 1, 1)).toEqual([20, 0, 0, 255]); // B
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

describe('colorKeyMask', () => {
  it('whitens pixels within tolerance of the target colour', () => {
    const img = createImage(2, 1, [0, 0, 0, 255]);
    set(img, 0, 0, [0, 255, 0, 255]); // green
    set(img, 1, 0, [255, 0, 0, 255]); // red
    const mask = colorKeyMask(img, [0, 255, 0], 40);
    expect(px(mask, 0, 0)).toEqual([255, 255, 255, 255]); // green matched
    expect(px(mask, 1, 0)).toEqual([0, 0, 0, 255]); // red not matched
  });
});

describe('downscaleToMax', () => {
  it('scales the longest side down to the cap, preserving aspect', () => {
    const out = downscaleToMax(createImage(100, 50), 50);
    expect([out.width, out.height]).toEqual([50, 25]);
  });
  it('leaves small images and maxDim<=0 unchanged', () => {
    expect(downscaleToMax(createImage(40, 30), 100).width).toBe(40);
    expect(downscaleToMax(createImage(200, 200), 0).width).toBe(200);
  });
});

describe('flatten', () => {
  it('transparent pixels take the background; opaque pixels are unchanged, all opaque', () => {
    const bg: [number, number, number] = [200, 200, 200];
    expect(px(flatten(createImage(1, 1, [100, 50, 25, 0]), bg), 0, 0)).toEqual([200, 200, 200, 255]);
    expect(px(flatten(createImage(1, 1, [100, 50, 25, 255]), bg), 0, 0)).toEqual([100, 50, 25, 255]);
  });
});

describe('pixelate', () => {
  it('collapses each block to one colour (4px row, block 2)', () => {
    const img = createImage(4, 1, [0, 0, 0, 255]);
    set(img, 0, 0, [10, 0, 0, 255]);
    set(img, 1, 0, [20, 0, 0, 255]);
    set(img, 2, 0, [30, 0, 0, 255]);
    set(img, 3, 0, [40, 0, 0, 255]);
    const out = pixelate(img, 2);
    expect([px(out, 0, 0)[0], px(out, 1, 0)[0], px(out, 2, 0)[0], px(out, 3, 0)[0]]).toEqual([
      10, 10, 30, 30,
    ]);
  });
  it('block size <= 1 is a no-op copy', () => {
    const img = createImage(2, 2, [5, 6, 7, 8]);
    expect([...pixelate(img, 1).data]).toEqual([...img.data]);
  });
});

describe('vignette', () => {
  it('strength 0 is unchanged; strength 1 blacks the corners but keeps the centre', () => {
    const img = createImage(3, 3, [200, 200, 200, 255]);
    expect(px(vignette(img, 0), 0, 0)).toEqual([200, 200, 200, 255]);
    const v = vignette(img, 1);
    expect(px(v, 1, 1)).toEqual([200, 200, 200, 255]); // centre untouched
    expect(px(v, 0, 0)).toEqual([0, 0, 0, 255]); // corner darkened to black
  });
});

describe('removeColor', () => {
  it('makes near-colour pixels transparent, leaves others opaque', () => {
    const white = px(removeColor(createImage(1, 1, [250, 250, 250, 255]), [255, 255, 255], 30), 0, 0);
    expect(white[3]).toBe(0); // within tolerance -> transparent
    const black = px(removeColor(createImage(1, 1, [0, 0, 0, 255]), [255, 255, 255], 30), 0, 0);
    expect(black).toEqual([0, 0, 0, 255]); // far -> unchanged
  });
});

describe('tint', () => {
  it('multiplies channels by the colour (white→colour, grey scaled)', () => {
    expect(px(tint(createImage(1, 1, [255, 255, 255, 255]), [255, 0, 0]), 0, 0)).toEqual([255, 0, 0, 255]);
    expect(px(tint(createImage(1, 1, [200, 200, 200, 255]), [128, 128, 128]), 0, 0)).toEqual([
      100, 100, 100, 255,
    ]);
  });
});

describe('linearGradient', () => {
  it('interpolates between the two colours across the axis', () => {
    const black: [number, number, number, number] = [0, 0, 0, 255];
    const white: [number, number, number, number] = [255, 255, 255, 255];
    const h = linearGradient(3, 1, black, white, true);
    expect([px(h, 0, 0)[0], px(h, 1, 0)[0], px(h, 2, 0)[0]]).toEqual([0, 128, 255]);
    const v = linearGradient(1, 3, black, white, false);
    expect([px(v, 0, 0)[0], px(v, 0, 1)[0], px(v, 0, 2)[0]]).toEqual([0, 128, 255]);
  });
});

describe('opacity', () => {
  it('scales alpha and clamps the factor', () => {
    expect(px(opacity(createImage(1, 1, [10, 20, 30, 200]), 0.5), 0, 0)).toEqual([10, 20, 30, 100]);
    expect(px(opacity(createImage(1, 1, [10, 20, 30, 200]), 0), 0, 0)[3]).toBe(0);
    expect(px(opacity(createImage(1, 1, [10, 20, 30, 200]), 1), 0, 0)[3]).toBe(200);
  });
});

describe('normalize', () => {
  it('stretches each channel to the full range; leaves constant channels alone', () => {
    const img = createImage(3, 1, [0, 100, 100, 255]);
    set(img, 0, 0, [50, 100, 100, 255]);
    set(img, 1, 0, [100, 100, 100, 255]);
    set(img, 2, 0, [150, 100, 100, 255]);
    const out = normalize(img);
    expect([px(out, 0, 0)[0], px(out, 1, 0)[0], px(out, 2, 0)[0]]).toEqual([0, 127, 255]);
    expect(px(out, 1, 0)[1]).toBe(100); // constant green channel unchanged
  });
});

describe('sharpen', () => {
  it('leaves a uniform image unchanged (nothing to enhance)', () => {
    expect(px(sharpen(createImage(3, 3, [120, 120, 120, 255]), 1), 1, 1)).toEqual([120, 120, 120, 255]);
  });
  it('amount 0 is a no-op copy', () => {
    const img = createImage(2, 2, [1, 2, 3, 4]);
    expect([...sharpen(img, 0).data]).toEqual([...img.data]);
  });
});

describe('sobel', () => {
  it('a uniform image has no edges', () => {
    expect(px(sobel(createImage(3, 3, [128, 128, 128, 255])), 1, 1)).toEqual([0, 0, 0, 255]);
  });
  it('a hard boundary yields bright edge pixels', () => {
    const img = createImage(3, 3, [0, 0, 0, 255]);
    for (let y = 0; y < 3; y++) set(img, 2, y, [255, 255, 255, 255]); // white right column
    expect(px(sobel(img), 1, 1)[0]).toBeGreaterThan(0);
  });
});

describe('gradientMap', () => {
  it('maps luminance to the low/high colours', () => {
    const white = px(gradientMap(createImage(1, 1, [255, 255, 255, 255]), [0, 0, 0], [255, 0, 0]), 0, 0);
    const black = px(gradientMap(createImage(1, 1, [0, 0, 0, 200]), [0, 0, 0], [255, 0, 0]), 0, 0);
    expect(white).toEqual([255, 0, 0, 255]); // luminance 255 -> high
    expect(black).toEqual([0, 0, 0, 200]); // luminance 0 -> low, alpha kept
  });
});

describe('levels', () => {
  it('is identity with default black/white/gamma', () => {
    expect(px(levels(createImage(1, 1, [10, 128, 240, 55]), 0, 255, 1), 0, 0)).toEqual([10, 128, 240, 55]);
  });
  it('stretches contrast between black and white points', () => {
    // black=0, white=128: 64 -> 128, 128 -> 255, 200 -> clamped 255
    expect(px(levels(createImage(1, 1, [64, 128, 200, 255]), 0, 128, 1), 0, 0)).toEqual([128, 255, 255, 255]);
  });
});

describe('hueSaturation', () => {
  it('shifts red 120° to green', () => {
    expect(px(hueSaturation(createImage(1, 1, [255, 0, 0, 255]), 120, 1), 0, 0)).toEqual([0, 255, 0, 255]);
  });
  it('saturation 0 desaturates to grey (alpha kept)', () => {
    const out = px(hueSaturation(createImage(1, 1, [255, 0, 0, 200]), 0, 0), 0, 0);
    expect(out[0]).toBe(out[1]);
    expect(out[1]).toBe(out[2]);
    expect(out[3]).toBe(200);
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
  it('averages values across a non-uniform row', () => {
    // [0,60,120] blurred r=1 (clamped edges): centre = (0+60+120)/3 = 60.
    const img = createImage(3, 1, [0, 0, 0, 255]);
    set(img, 1, 0, [60, 60, 60, 255]);
    set(img, 2, 0, [120, 120, 120, 255]);
    expect(px(boxBlur(img, 1), 1, 0)[0]).toBe(60);
  });
  it('does not bleed transparent pixels’ hidden RGB into visible neighbours', () => {
    // Two opaque white pixels beside a transparent-black pixel. A straight-alpha
    // blur would darken the visible edge toward the hidden black (halo); the
    // premultiplied blur keeps the colour pure and only feathers alpha.
    const img = createImage(3, 1, [0, 0, 0, 0]); // px2 transparent black
    set(img, 0, 0, [255, 255, 255, 255]);
    set(img, 1, 0, [255, 255, 255, 255]);
    const [r, g, b, a] = px(boxBlur(img, 1), 1, 0);
    expect([r, g, b]).toEqual([255, 255, 255]); // colour unpolluted
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(255); // alpha feathered toward the transparent side
  });
});
