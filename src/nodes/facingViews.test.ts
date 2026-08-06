import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { facingViewsNode, facingViewOptionsFromConfig, describeFacingViews } from './facingViews';
import { getNodeDef } from '../engine/registry';
import { createImage } from '../lib/image';
import {
  coverScale,
  facingEyePositions,
  facingViewCount,
  facingViewSize,
  renderFacingViews,
  type FacingViewOptions,
} from '../lib/facingViews';
import type { ComputeContext, DataValue, RasterImage, SequenceValue } from '../types';

const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

/** Config that renders fast: a small sheet raster and few views. */
const config = (over: Record<string, unknown> = {}) => ({
  ...facingViewsNode.defaultConfig(),
  viewPx: 32,
  views: 3,
  ...over,
});

const options = (over: Partial<FacingViewOptions> = {}): FacingViewOptions => ({
  layout: '1d',
  views: 3,
  grid: 3,
  gridY: 3,
  widthMm: 100,
  heightMm: 75,
  widthPx: 32,
  viewDistanceMm: 400,
  coneDeg: 53,
  follow: 1,
  ...over,
});

/** A left-to-right ramp, so a sample's value says where in the picture it came from. */
function rampX(width = 64, height = 48): RasterImage {
  const img = createImage(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = Math.round((x / (width - 1)) * 255);
      const i = (y * width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
  return img;
}

/** …and the same top-to-bottom, for the vertical pivot. */
function rampY(width = 64, height = 48): RasterImage {
  const img = createImage(width, height, [0, 0, 0, 255]);
  for (let y = 0; y < height; y++) {
    const v = Math.round((y / (height - 1)) * 255);
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    }
  }
  return img;
}

const grey = (img: RasterImage, x: number, y: number) => img.data[(y * img.width + x) * 4];
const mid = (img: RasterImage) => grey(img, img.width >> 1, img.height >> 1);

describe('facing eye positions', () => {
  it('runs left to right for a 1D run, and dead level', () => {
    const eyes = facingEyePositions(options({ views: 3 }));
    expect(eyes).toHaveLength(3);
    expect(eyes[0].x).toBeLessThan(0);
    expect(eyes[1].x).toBeCloseTo(0, 6);
    expect(eyes[2].x).toBeGreaterThan(0);
    expect(eyes.every((e) => e.y === 0)).toBe(true);
  });

  it('runs row-major from Left · Up for a grid, oblong or not', () => {
    const eyes = facingEyePositions(options({ layout: '2d', grid: 2, gridY: 3 }));
    expect(eyes).toHaveLength(6);
    // Row 0 is `Up`: the eye is above the sheet, so +y — the order Lens Grid
    // Print names its cells in.
    expect(eyes[0].x).toBeLessThan(0);
    expect(eyes[0].y).toBeGreaterThan(0);
    expect(eyes[2].y).toBeCloseTo(0, 6); // the centre row of three
    expect(eyes[5].y).toBeLessThan(0);
    expect(facingViewCount(options({ layout: '2d', grid: 2, gridY: 3 }))).toBe(6);
  });
});

describe('the picture plane', () => {
  it('enlarges the picture by just enough to cover the sheet from every view', () => {
    // Turning the plane pulls its far side away from the eye, so the rays
    // through the sheet's far corners reach past where a sheet-sized picture
    // would end — and that corner is what decides the enlargement.
    const scale = coverScale(options());
    expect(scale).toBeGreaterThan(1);
    expect(scale).toBeCloseTo(1.05, 2);
    // A wider cone turns further and so needs more picture; no turn needs none.
    expect(coverScale(options({ coneDeg: 90 }))).toBeGreaterThan(scale);
    expect(coverScale(options({ follow: 0 }))).toBe(1);
    // A grid turns both ways, so it reaches past both edges.
    expect(coverScale(options({ layout: '2d', grid: 3 }))).toBeGreaterThan(scale);
  });

  it('covers the sheet in every view, and by no more than it has to', () => {
    // A white picture inside a black rim: the rim is the picture's own edge, so
    // it shows up on a view exactly when that view has reached the end of the
    // picture. With a little margin over the cover scale, no view does…
    const rim = createImage(64, 48, [255, 255, 255, 255]);
    for (let y = 0; y < 48; y++) {
      for (let x = 0; x < 64; x++) {
        if (x < 2 || y < 2 || x > 61 || y > 45) {
          const i = (y * 64 + x) * 4;
          rim.data[i] = rim.data[i + 1] = rim.data[i + 2] = 0;
        }
      }
    }
    const o = options({ layout: '2d', grid: 3, widthPx: 24 });
    const darkestEdge = (views: RasterImage[]) =>
      Math.min(
        ...views.flatMap((v) => {
          const edges: number[] = [];
          for (let x = 0; x < v.width; x++) edges.push(grey(v, x, 0), grey(v, x, v.height - 1));
          for (let y = 0; y < v.height; y++) edges.push(grey(v, 0, y), grey(v, v.width - 1, y));
          return edges;
        }),
      );
    expect(darkestEdge(renderFacingViews(rim, { ...o, zoom: 1.25 }).views)).toBeGreaterThan(200);
    // …and with none, the worst corner sits right on the picture's edge, which
    // is what "just enough" means: any less and that corner would run off it.
    expect(darkestEdge(renderFacingViews(rim, o).views)).toBeLessThan(200);
  });

  it('pivots about the centre of the picture, which stays put on the sheet', () => {
    // The plane passes through the sheet centre, so the ray through that point
    // is the one ray the turn cannot move: every view shows the same pixel
    // there, and everything else swings around it.
    const { views } = renderFacingViews(rampX(), options({ views: 5 }));
    const centres = views.map(mid);
    for (const c of centres) expect(Math.abs(c - centres[2])).toBeLessThanOrEqual(1);
  });

  it('is centred head-on, and slides its window as it turns', () => {
    const { views } = renderFacingViews(rampX(), options({ views: 3 }));
    const [left, head, right] = views;
    const w = head.width - 1;
    const row = head.height >> 1;
    // Head-on the plane is square to the sheet, so the window is the middle of
    // the picture — nearly all of it, and symmetric about the centre.
    expect(grey(head, 0, row) + grey(head, w, row)).toBeCloseTo(255, -1);
    expect(grey(head, 0, row)).toBeLessThan(20);
    // From the right, the window on the picture slides right and narrows: both
    // edges of the sheet now show ground that was further right head-on, and
    // the far edge no longer reaches the end of the picture.
    expect(grey(right, 0, row)).toBeGreaterThan(grey(head, 0, row));
    expect(grey(right, w, row)).toBeLessThan(grey(head, w, row));
    // …and from the left, the mirror image of that.
    expect(grey(left, w, row)).toBeLessThan(grey(head, w, row));
    expect(grey(left, 0, row)).toBeGreaterThan(grey(head, 0, row));
  });

  it('pivots up and down as well once the layout is a grid', () => {
    const { views } = renderFacingViews(rampY(), options({ layout: '2d', grid: 3 }));
    const col = views[0].width >> 1;
    const bottom = views[0].height - 1;
    const head = views[4]; // centre cell of a 3×3
    // The top row of views is seen from above, so their window on the picture
    // slides up: the top edge of the sheet shows what was lower down head-on.
    expect(grey(views[1], col, 0)).toBeGreaterThan(grey(head, col, 0));
    expect(grey(views[1], col, bottom)).toBeLessThan(grey(head, col, bottom));
  });

  it('turns nothing at all at follow 0, and prints the same picture every time', () => {
    const { views, turnXDeg } = renderFacingViews(rampX(), options({ views: 3, follow: 0 }));
    expect(turnXDeg).toBe(0);
    for (const v of views) expect([...v.data]).toEqual([...views[0].data]);
  });

  it('turns further the further off-axis the view is', () => {
    const wide = renderFacingViews(rampX(), options({ coneDeg: 90 }));
    const narrow = renderFacingViews(rampX(), options({ coneDeg: 20 }));
    expect(wide.turnXDeg).toBeGreaterThan(narrow.turnXDeg);
    // Half the cone, at the outermost view, and no more: the picture faces the
    // eye rather than overshooting it.
    expect(narrow.turnXDeg).toBeCloseTo(10, 1);
    expect(renderFacingViews(rampX(), options({ coneDeg: 20, follow: 0.5 })).turnXDeg).toBeCloseTo(5, 1);
  });

  it('zooms in past the minimum crop when asked, and never out', () => {
    const base = renderFacingViews(rampX(), options());
    const { views, scale, headOnFraction } = renderFacingViews(rampX(), options({ zoom: 2 }));
    expect(scale).toBeCloseTo(base.scale * 2, 6);
    expect(headOnFraction).toBeCloseTo(1 / (scale * scale), 6);
    // Twice the picture puts the sheet over the middle half of it, so the
    // head-on view runs from about a quarter of the way in to three quarters.
    const head = views[1];
    const row = head.height >> 1;
    expect(grey(head, 0, row)).toBeCloseTo(67, -1);
    expect(grey(head, head.width - 1, row)).toBeCloseTo(188, -1);
    // Zoom can only crop in: the cover scale is a floor, not a suggestion.
    expect(renderFacingViews(rampX(), options({ zoom: 0.1 })).scale).toBeCloseTo(base.scale, 6);
  });

  it('covers the sheet whatever aspect the picture arrived in', () => {
    // A 2:1 picture on a 4:3 sheet: matched by height, and the sides cropped,
    // so no view has a blank edge to fill.
    const wide = rampX(80, 40);
    const { views } = renderFacingViews(wide, options({ views: 1, widthMm: 100, heightMm: 75 }));
    const row = views[0].height >> 1;
    expect(grey(views[0], 0, row)).toBeGreaterThan(40); // not the picture's own edge
    expect(grey(views[0], views[0].width - 1, row)).toBeLessThan(215);
  });

  it('renders at the sheet’s aspect, not the picture’s', () => {
    expect(facingViewSize(options({ widthPx: 100, widthMm: 100, heightMm: 75 }))).toEqual({
      width: 100,
      height: 75,
    });
    const { views } = renderFacingViews(rampX(80, 40), options({ views: 1, widthPx: 40 }));
    expect(views[0].width).toBe(40);
    expect(views[0].height).toBe(30);
  });
});

describe('Image → Facing Views node', () => {
  it('is registered, takes a picture and hands back a sequence', async () => {
    expect(getNodeDef('facingViews')).toBe(facingViewsNode);
    const out = await facingViewsNode.compute(ctx({ image: rampX() }, config({ views: 4 })));
    const views = out.views as SequenceValue;
    expect(views.kind).toBe('sequence');
    expect(views.frames).toHaveLength(4);
    expect(views.frames[0].width).toBe(32);
    expect((out.centre as RasterImage).width).toBe(32);
  });

  it('needs a picture', async () => {
    await expect(facingViewsNode.compute(ctx({}, config()))).rejects.toThrow(/Connect a picture/);
  });

  it('sends the run out right-eye-first for the lens, and a grid in cell order', async () => {
    const image = rampX();
    const forLens = await facingViewsNode.compute(ctx({ image }, config({ views: 3 })));
    const raw = await facingViewsNode.compute(ctx({ image }, config({ views: 3, mirrorViews: false })));
    const first = (o: Record<string, DataValue | undefined>) => (o.views as SequenceValue).frames[0];
    const last = (o: Record<string, DataValue | undefined>) => {
      const f = (o.views as SequenceValue).frames;
      return f[f.length - 1];
    };
    expect([...first(forLens).data]).toEqual([...last(raw).data]);
    // A grid is never reversed: Lens Grid Print reads cell order and inverts it
    // itself.
    const grid = await facingViewsNode.compute(ctx({ image }, config({ layout: '2d', grid: 2, gridY: 3 })));
    expect((grid.views as SequenceValue).frames).toHaveLength(6);
  });

  it('reads its settings out of config, clamped', () => {
    const o = facingViewOptionsFromConfig({ layout: '2d', grid: 2, gridY: 5, follow: 2, zoom: 0 });
    expect(o).toMatchObject({ layout: '2d', grid: 2, gridY: 5, follow: 1, zoom: 1 });
    expect(facingViewOptionsFromConfig({ follow: -1 }).follow).toBe(0);
    // A graph saved with only `grid` means a square grid, as everywhere else.
    expect(facingViewOptionsFromConfig({ grid: 4 }).gridY).toBe(4);
    expect(facingViewOptionsFromConfig({}).layout).toBe('1d');
  });

  it('reports the turn, the crop and the picture it is spending', () => {
    const cfg = config({ views: 3 });
    const o = facingViewOptionsFromConfig(cfg);
    const image = rampX(2000, 1500);
    const render = renderFacingViews(image, o);
    const text = describeFacingViews(cfg, o, render, image);
    expect(text).toContain('3 views across the cone');
    expect(text).toMatch(/Turns ±\d+\.\d° across/);
    expect(text).toContain('about the centre of the picture, which stays put');
    expect(text).toMatch(/Picture printed 1\.05× the sheet .* 90% window on it head-on/);
    // The source is not sampled at more resolution than the sheet can print.
    expect(render.sourcePx.width).toBe(34);
    expect(text).toContain('Source 2000×1500 px, sampled at 34×26');
  });

  it('says so when nothing will move', () => {
    const cfg = config({ follow: 0 });
    const o = facingViewOptionsFromConfig(cfg);
    const image = rampX();
    const text = describeFacingViews(cfg, o, renderFacingViews(image, o), image);
    expect(text).toMatch(/⚠ Follow is 0/);
  });

  it('says so when the crop is hard, or the source too small for it', () => {
    const cfg = config({ zoom: 3 });
    const o = facingViewOptionsFromConfig(cfg);
    const small = rampX(16, 12);
    const text = describeFacingViews(cfg, o, renderFacingViews(small, o), small);
    expect(text).toMatch(/Only 10% of the picture is on the sheet head-on/);
    expect(text).toMatch(/⚠ The picture prints 101 px across but the source is only 16/);
  });
});
