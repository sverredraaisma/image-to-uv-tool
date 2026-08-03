import { describe, it, expect } from 'vitest';
import {
  depthViewChunks,
  prepareDepth,
  renderDepthViews,
  shiftLut,
  workingSize,
  type DepthViewOptions,
} from './depthViews';
import { disparityAtDepth, eyeOffsetsMm } from './render3d';
import { createImage } from './image';
import type { RasterImage } from '../types';

const options = (over: Partial<DepthViewOptions> = {}): DepthViewOptions => ({
  views: 3,
  widthMm: 100,
  viewDistanceMm: 400,
  depthMm: 10,
  setbackMm: 0,
  coneDeg: 60,
  depthBlurPx: 0,
  ...over,
});

/** Fill an image from a per-pixel callback returning [r,g,b,a]. */
function paint(width: number, height: number, at: (x: number, y: number) => number[]): RasterImage {
  const img = createImage(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = at(x, y);
      const i = (y * width + x) * 4;
      img.data[i] = r;
      img.data[i + 1] = g;
      img.data[i + 2] = b;
      img.data[i + 3] = a;
    }
  }
  return img;
}

/** A flat grey card at one depth level everywhere. */
const flatDepth = (w: number, h: number, level: number) =>
  paint(w, h, () => [level, level, level, 255]);

/** Distinct colour per column, so a shift is readable straight off the pixels. */
const ramp = (w: number, h: number) => paint(w, h, (x) => [x, 0, 0, 255]);

const red = (img: RasterImage, x: number, y = 0) => img.data[(y * img.width + x) * 4];

describe('depth → view warp', () => {
  it('leaves the head-on view exactly as it found it', () => {
    // The centre of an odd run is the eye dead ahead, and X = X₀ there for
    // every depth — the source image *is* that view, which is the property the
    // whole method rests on.
    const src = ramp(32, 4);
    const depth = paint(32, 4, (x) => {
      const v = x * 8;
      return [v, v, v, 255];
    });
    const { views } = renderDepthViews(src, depth, options({ views: 3 }));
    expect([...views[1].data]).toEqual([...src.data]);
  });

  it('slides a plane behind the sheet with the eye, and one on the sheet not at all', () => {
    const src = ramp(64, 2);
    const D = 400;
    const o = options({ views: 2, coneDeg: 60, viewDistanceMm: D, depthMm: 20, setbackMm: 0 });

    // White (level 255) is the near plane, at setback 0 — the sheet itself.
    const onSheet = renderDepthViews(src, flatDepth(64, 2, 255), o);
    expect([...onSheet.views[0].data]).toEqual([...src.data]);

    // Black is 20 mm behind it, and moves.
    const behind = renderDepthViews(src, flatDepth(64, 2, 0), o);
    const eye = eyeOffsetsMm(2, 60, D)[0]; // the left eye, negative
    const expected = (disparityAtDepth(Math.abs(eye), -20, D, 1).mm * 64) / 100;
    // Left eye, background behind the sheet: it slides left with the head.
    const shifted = behind.views[0];
    expect(red(shifted, 32)).toBeCloseTo(32 + Math.round(expected), -0.5);
    expect(Math.round(expected)).toBeGreaterThan(0);
  });

  it('fills what a near edge uncovers from the background, not from the edge', () => {
    // A near bar on a far ground: the bar slides, and the strip it vacates must
    // come back as ground (dark), not as a smear of the bar (bright).
    const w = 64;
    const src = paint(w, 1, (x) => (x >= 24 && x < 40 ? [255, 255, 255, 255] : [20, 20, 20, 255]));
    const depth = paint(w, 1, (x) => {
      const v = x >= 24 && x < 40 ? 255 : 0;
      return [v, v, v, 255];
    });
    const { views, filledFraction, maxHolePx } = renderDepthViews(
      src,
      depth,
      options({ views: 2, depthMm: 30, setbackMm: 0 }),
    );
    const left = views[0];
    // The bar is still a bar: no half-tone smear where it used to be.
    for (let x = 0; x < w; x++) {
      const v = red(left, x);
      expect(v === 255 || v === 20, `x=${x} is ${v}`).toBe(true);
    }
    expect(maxHolePx).toBeGreaterThan(0);
    expect(filledFraction).toBeGreaterThan(0);
    // …and less than a bar's worth of it: only one side of the bar disoccludes.
    expect(maxHolePx).toBeLessThan(16);
  });

  it('does not drag a soft edge into the hole it opens', () => {
    // The case a neighbour-wise fill gets wrong. Real depth maps ramp across a
    // silhouette rather than stepping, and the picture is antialiased over the
    // same pixels, so the colours *on* the edge are a blend of subject and
    // ground — and a fill that reaches for the nearest farther neighbour picks
    // up that blend and stretches it. Nothing between 20 and 255 may appear in
    // the strip the subject uncovers.
    const w = 96;
    const bar = { from: 40, to: 64 };
    const ramp = 3;
    // Depth: a plateau either side of a 3 px ramp. Colour: the same ramp, so
    // the edge pixels are mid-greys that must not survive the warp.
    const level = (x: number) => {
      if (x < bar.from - ramp || x >= bar.to + ramp) return 0;
      if (x >= bar.from && x < bar.to) return 255;
      const t = x < bar.from ? (x - (bar.from - ramp)) / ramp : (bar.to + ramp - x) / ramp;
      return Math.round(t * 255);
    };
    const src = paint(w, 1, (x) => {
      const v = 20 + Math.round((level(x) / 255) * 235);
      return [v, v, v, 255];
    });
    const depth = paint(w, 1, (x) => [level(x), level(x), level(x), 255]);

    // The longest run of mid-tones in a row. The edge itself is allowed a
    // couple — it is a real antialiased silhouette — but a smear is a run.
    const longestSmear = (view: RasterImage) => {
      let longest = 0;
      let run = 0;
      for (let x = 0; x < view.width; x++) {
        const v = red(view, x);
        run = v > 30 && v < 245 ? run + 1 : 0;
        longest = Math.max(longest, run);
      }
      return longest;
    };
    const o = options({ views: 3, depthMm: 25, setbackMm: 0 });
    expect(longestSmear(renderDepthViews(src, depth, o).views[0])).toBeLessThanOrEqual(ramp);

    // And it is the cliff detection doing it: put the threshold out of reach,
    // so every edge reads as a slope, and the blend drags across the hole.
    const noCliffs = renderDepthViews(src, depth, { ...o, edgeJumpPx: 1e9 });
    expect(longestSmear(noCliffs.views[0])).toBeGreaterThan(ramp * 2);
  });

  it('still stretches a gentle slope rather than cutting it into steps', () => {
    // The other half of the trade: a surface receding smoothly is not a
    // silhouette, and its texture must be stretched, not replaced by the pixel
    // at the far end of it.
    const w = 96;
    const src = ramp(w, 1);
    const depth = paint(w, 1, (x) => {
      const v = Math.round((x / (w - 1)) * 255);
      return [v, v, v, 255];
    });
    const { views } = renderDepthViews(src, depth, options({ views: 3, depthMm: 8, setbackMm: 0 }));
    const left = views[0];
    // Monotone, and still spanning most of the source's range: a cliff fill
    // would have flattened whole stretches of it onto one value.
    const distinct = new Set<number>();
    for (let x = 0; x < w; x++) distinct.add(red(left, x));
    expect(distinct.size).toBeGreaterThan(w / 2);
  });

  it('leaves no transparent pixel anywhere, however far the picture slides', () => {
    const src = ramp(48, 3);
    const { views } = renderDepthViews(src, flatDepth(48, 3, 0), options({ views: 5, depthMm: 60 }));
    for (const v of views) {
      for (let i = 3; i < v.data.length; i += 4) expect(v.data[i]).toBe(255);
    }
  });

  it('inverts the map when the heightmap calls white far', () => {
    const d = paint(4, 1, (x) => [x * 60, x * 60, x * 60, 255]);
    const straight = prepareDepth(d, 4, 1, {});
    const flipped = prepareDepth(d, 4, 1, { invertDepth: true });
    expect([...straight.data.filter((_, i) => i % 4 === 0)]).toEqual([0, 60, 120, 180]);
    expect([...flipped.data.filter((_, i) => i % 4 === 0)]).toEqual([255, 195, 135, 75]);
  });

  it('reads the shift straight off disparityAtDepth', () => {
    const o = options({ viewDistanceMm: 500, depthMm: 12, setbackMm: 3, widthMm: 60 });
    const lut = shiftLut(o, 40, 120);
    const pxPerMm = 120 / 60;
    // Level 255 is the near plane (3 mm behind the sheet); level 0 is 15 mm back.
    expect(Math.abs(lut[255])).toBeCloseTo(disparityAtDepth(40, -3, 500, 1).mm * pxPerMm, 6);
    expect(Math.abs(lut[0])).toBeCloseTo(disparityAtDepth(40, -15, 500, 1).mm * pxPerMm, 6);
    // Behind the sheet, the shift takes the sign of the eye offset.
    expect(lut[0]).toBeGreaterThan(0);
    expect(shiftLut(o, -40, 120)[0]).toBeLessThan(0);
  });

  it('sizes the working raster to the requested width, keeping the aspect', () => {
    const img = createImage(400, 300, [0, 0, 0, 255]);
    expect(workingSize(img)).toEqual({ width: 400, height: 300 });
    expect(workingSize(img, 200)).toEqual({ width: 200, height: 150 });
    // Clamped, not honoured literally.
    expect(workingSize(img, 100000).width).toBe(4096);
    expect(workingSize(img, 1).width).toBe(16);
  });

  it('resamples a heightmap that does not match the picture', () => {
    const src = ramp(32, 8);
    const small = flatDepth(8, 2, 0);
    const { views, depth } = renderDepthViews(src, small, options({ views: 2 }));
    expect(depth.width).toBe(32);
    expect(depth.height).toBe(8);
    expect(views[0].width).toBe(32);
  });

  it('reports one chunk per view', () => {
    const gen = depthViewChunks(ramp(16, 2), flatDepth(16, 2, 128), options({ views: 4 }));
    const seen: number[] = [];
    let step = gen.next();
    while (!step.done) {
      expect(step.value.what).toBe('Views');
      expect(step.value.total).toBe(4);
      seen.push(step.value.done);
      step = gen.next();
    }
    expect(seen).toEqual([1, 2, 3, 4]);
    expect(step.value.views).toHaveLength(4);
  });

  it('places the picture where the setback says, and clamps a runaway pop-out', () => {
    const src = ramp(16, 1);
    const a = renderDepthViews(src, flatDepth(16, 1, 255), options({ setbackMm: 7, depthMm: 4 }));
    expect(a.nearMm).toBe(7);
    expect(a.farMm).toBe(11);
    // 25% of the viewing distance is as far in front as the projection means
    // anything; asking for a metre of pop-out gets 100 mm.
    const b = renderDepthViews(src, flatDepth(16, 1, 255), options({ setbackMm: -1000 }));
    expect(b.nearMm).toBe(-100);
  });

  it('spends nothing on depth when the range is zero', () => {
    const src = ramp(24, 2);
    const depth = paint(24, 2, (x) => [x * 10, x * 10, x * 10, 255]);
    const { views, filledFraction } = renderDepthViews(src, depth, options({ views: 3, depthMm: 0 }));
    for (const v of views) expect([...v.data]).toEqual([...src.data]);
    expect(filledFraction).toBe(0);
  });
});
