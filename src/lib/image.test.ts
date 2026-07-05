import { describe, it, expect } from 'vitest';
import {
  alphaCleanup,
  autoThreshold,
  autoThresholdLevel,
  combine,
  createImage,
  despeckle,
  distanceToOpaque,
  extractChannel,
  glossPreview,
  hexToRgba,
  highlightExtract,
  invert,
  morphology,
  outline,
  resize,
  rgbToHsv,
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
  it('parses #rgba shorthand and falls back for invalid hex', () => {
    expect(hexToRgba('#f008')).toEqual([255, 0, 0, 136]); // #rgba -> RRGGBBAA
    expect(hexToRgba('ff0000')).toEqual([255, 0, 0, 255]); // missing #
    expect(hexToRgba('#zzzzzz')).toEqual([0, 0, 0, 255]); // non-hex -> black, not NaN
    expect(hexToRgba('#12')).toEqual([0, 0, 0, 255]); // bad length -> black
    expect([...hexToRgba('#zz')].some(Number.isNaN)).toBe(false);
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
  it('subtract clamps RGB at 0 and keeps the result visible (alpha = coverage)', () => {
    const out = combine([solid(1, 1, [100, 50, 0, 255]), solid(1, 1, [30, 80, 10, 255])], 'subtract');
    expect(px(out, 0, 0)).toEqual([70, 0, 0, 255]); // opaque ⊖ opaque stays opaque
  });
  it('difference is the absolute per-channel delta, still visible', () => {
    const out = combine([solid(1, 1, [100, 50, 255, 255]), solid(1, 1, [30, 80, 10, 255])], 'difference');
    expect(px(out, 0, 0)).toEqual([70, 30, 245, 255]);
  });
  it('average is the per-channel RGB mean; alpha is coverage (max)', () => {
    const out = combine([solid(1, 1, [100, 0, 200, 100]), solid(1, 1, [200, 100, 0, 50])], 'average');
    expect(px(out, 0, 0)).toEqual([150, 50, 100, 100]);
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
  it('snaps faint pixels to opaque white', () => {
    const img = solid(1, 1, [100, 100, 100, 10]);
    const out = alphaCleanup(img, 128, 'white');
    expect(px(out, 0, 0)).toEqual([255, 255, 255, 255]);
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

// ---- Gloss / spot-varnish ops -------------------------------------------

describe('rgbToHsv', () => {
  it('maps primaries and greys', () => {
    expect(rgbToHsv(255, 0, 0)).toEqual([0, 1, 1]); // pure red
    const [h, s, v] = rgbToHsv(128, 128, 128); // grey: no hue/sat
    expect(h).toBe(0);
    expect(s).toBe(0);
    expect(v).toBeCloseTo(128 / 255, 5);
    expect(rgbToHsv(0, 0, 0)).toEqual([0, 0, 0]); // black
  });
});

describe('extractChannel HSV', () => {
  it('extracts saturation and value', () => {
    const red = solid(1, 1, [255, 0, 0, 255]);
    expect(px(extractChannel(red, 'sat'), 0, 0)).toEqual([255, 255, 255, 255]);
    expect(px(extractChannel(red, 'val'), 0, 0)).toEqual([255, 255, 255, 255]);
    // a grey pixel has zero saturation
    expect(px(extractChannel(solid(1, 1, [128, 128, 128, 255]), 'sat'), 0, 0)).toEqual([0, 0, 0, 255]);
  });
});

describe('highlightExtract', () => {
  // A single bright glint on a flat grey field.
  const field = (center: [number, number, number]) => {
    const img = createImage(21, 21, [128, 128, 128, 255]);
    const c = (10 * 21 + 10) * 4;
    img.data[c] = center[0];
    img.data[c + 1] = center[1];
    img.data[c + 2] = center[2];
    return img;
  };

  it('keeps a small local glint but zeroes the flat surround', () => {
    const out = highlightExtract(field([255, 255, 255]), {
      radius: 8,
      satRejection: 0,
      gain: 1,
      bias: 0,
    });
    expect(px(out, 10, 10)[0]).toBeGreaterThan(50); // the glint survives
    expect(px(out, 0, 0)[0]).toBe(0); // flat area scores nothing
  });

  it('rejects a saturated bright pixel when satRejection is on', () => {
    const cyan = field([0, 255, 255]); // bright luminance but fully saturated
    expect(
      highlightExtract(cyan, { radius: 8, satRejection: 0, gain: 1, bias: 0 }).data[(10 * 21 + 10) * 4],
    ).toBeGreaterThan(0);
    expect(
      highlightExtract(cyan, { radius: 8, satRejection: 2, gain: 1, bias: 0 }).data[(10 * 21 + 10) * 4],
    ).toBe(0);
  });
});

describe('autoThreshold', () => {
  it('Otsu finds a valley between two tones', () => {
    // Left half dark (40), right half bright (200).
    const img = createImage(10, 1, [40, 40, 40, 255]);
    for (let x = 5; x < 10; x++) img.data.set([200, 200, 200, 255], x * 4);
    const level = autoThresholdLevel(img, 'otsu', 0);
    expect(level).toBeGreaterThan(40);
    expect(level).toBeLessThan(200);
    const out = autoThreshold(img, { mode: 'otsu', percentile: 0, invert: false });
    expect(px(out, 0, 0)).toEqual([0, 0, 0, 255]); // dark → black
    expect(px(out, 9, 0)).toEqual([255, 255, 255, 255]); // bright → white
  });

  it('percentile keeps the brightest N%', () => {
    const img = createImage(10, 1); // luminance 0,25,…,225
    for (let x = 0; x < 10; x++) img.data.set([25 * x, 25 * x, 25 * x, 255], x * 4);
    expect(autoThresholdLevel(img, 'percentile', 20)).toBe(200);
    const out = autoThreshold(img, { mode: 'percentile', percentile: 20, invert: false });
    let white = 0;
    for (let x = 0; x < 10; x++) if (out.data[x * 4] === 255) white++;
    expect(white).toBe(2); // top 20% of 10 pixels
  });
});

describe('despeckle', () => {
  it('removes a sub-minimum white speck but keeps a large blob', () => {
    const img = createImage(12, 12); // black
    for (let y = 0; y < 4; y++)
      for (let x = 0; x < 4; x++) img.data.set([255, 255, 255, 255], (y * 12 + x) * 4);
    img.data.set([255, 255, 255, 255], (10 * 12 + 10) * 4); // 1-px speck
    img.data.set([255, 255, 255, 255], (10 * 12 + 11) * 4); // makes it 2 px
    const out = despeckle(img, { minArea: 9, minHoleArea: 0, threshold: 128 });
    expect(px(out, 1, 1)).toEqual([255, 255, 255, 255]); // blob (16 px) survives
    expect(px(out, 10, 10)).toEqual([0, 0, 0, 255]); // 2-px speck gone
  });

  it('fills an enclosed pinhole', () => {
    const img = createImage(7, 7, [255, 255, 255, 255]);
    img.data.set([0, 0, 0, 255], (3 * 7 + 3) * 4); // 1-px hole in the middle
    const out = despeckle(img, { minArea: 0, minHoleArea: 4, threshold: 128 });
    expect(px(out, 3, 3)).toEqual([255, 255, 255, 255]); // pinhole filled
  });
});

describe('morphology open/close', () => {
  it('open removes a lone bright speck', () => {
    const img = createImage(5, 5); // black
    img.data.set([255, 255, 255, 255], (2 * 5 + 2) * 4);
    const out = morphology(img, 1, 'open');
    expect(px(out, 2, 2)[0]).toBe(0);
  });
  it('close fills a lone dark hole', () => {
    const img = createImage(5, 5, [255, 255, 255, 255]);
    img.data.set([0, 0, 0, 255], (2 * 5 + 2) * 4);
    const out = morphology(img, 1, 'close');
    expect(px(out, 2, 2)[0]).toBe(255);
  });
});

describe('glossPreview', () => {
  it('returns the art unchanged when the gloss mask is black', () => {
    const art = solid(5, 5, [200, 100, 50, 255]);
    const gloss = solid(5, 5, [0, 0, 0, 255]);
    const { image, coverage } = glossPreview(art, gloss, undefined, {
      azimuth: 135,
      elevation: 45,
      shininess: 32,
      intensity: 1,
      matte: 0,
      heightStrength: 2,
    });
    expect(px(image, 2, 2)).toEqual([200, 100, 50, 255]);
    expect(coverage).toBe(0);
  });

  it('reports coverage of a half-on mask as 50%', () => {
    const art = solid(2, 1, [100, 100, 100, 255]);
    const gloss = createImage(2, 1);
    gloss.data.set([255, 255, 255, 255], 0); // one on, one off
    const { coverage } = glossPreview(art, gloss, undefined, {
      azimuth: 0,
      elevation: 45,
      shininess: 32,
      intensity: 1,
      matte: 0,
      heightStrength: 2,
    });
    expect(coverage).toBe(0.5);
  });

  it('adds a specular highlight where gloss is on', () => {
    const art = solid(1, 1, [100, 100, 100, 255]);
    const gloss = solid(1, 1, [255, 255, 255, 255]);
    const { image } = glossPreview(art, gloss, undefined, {
      azimuth: 0,
      elevation: 90, // light straight on ⇒ flat-normal highlight is full
      shininess: 32,
      intensity: 1,
      matte: 0,
      heightStrength: 2,
    });
    expect(px(image, 0, 0)).toEqual([255, 255, 255, 255]);
  });
});
