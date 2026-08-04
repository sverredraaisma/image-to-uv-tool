import { describe, it, expect } from 'vitest';
import {
  describePlacementOf,
  renderSplatViews,
  splatEyeOffsets,
  toCameraSpace,
  type SplatViewOptions,
} from './render';
import { cameraAxes, cloudBounds, framingCamera } from './cloud';
import { disparityAtDepth } from '../render3d';
import type { RasterImage, SplatValue, TransformValue } from '../../types';

/** A cloud from a list of [x, y, z, radius, r, g, b, a] splats, unrotated. */
function cloudOf(splats: number[][]): SplatValue {
  const n = splats.length;
  const c: SplatValue = {
    kind: 'splat',
    count: n,
    positions: new Float32Array(n * 3),
    scales: new Float32Array(n * 3),
    rotations: new Float32Array(n * 4),
    colours: new Uint8ClampedArray(n * 4),
  };
  splats.forEach(([x, y, z, r, cr, cg, cb, ca], i) => {
    c.positions.set([x, y, z], i * 3);
    c.scales.set([r, r, r], i * 3);
    c.rotations.set([0, 0, 0, 1], i * 4);
    c.colours.set([cr, cg, cb, ca ?? 255], i * 4);
  });
  return c;
}

/** A camera at the origin looking down −Z, one scene unit per mm. */
const camera = (over: Partial<TransformValue> = {}): TransformValue => ({
  kind: 'transform',
  position: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: 1,
  ...over,
});

const options = (over: Partial<SplatViewOptions> = {}): SplatViewOptions => ({
  camera: camera(),
  widthMm: 100,
  heightMm: 100,
  widthPx: 64,
  viewDistanceMm: 400,
  coneDeg: 60,
  layout: '1d',
  views: 3,
  grid: 3,
  background: [255, 255, 255],
  supersample: 1,
  frontMarginMm: 0,
  ...over,
});

/** Round, and fold −0 into 0 so an axis reads as the vector it is. */
const round0 = (v: number) => Math.round(v) + 0;

const at = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

/** Centre of mass of everything darker than the paper, in px. */
function centroid(img: RasterImage): { x: number; y: number; mass: number } {
  let sx = 0,
    sy = 0,
    m = 0;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const w = 255 - at(img, x, y)[0];
      sx += x * w;
      sy += y * w;
      m += w;
    }
  }
  return { x: sx / (m || 1), y: sy / (m || 1), mass: m };
}

describe('splat view rendering', () => {
  it('puts a splat at the camera position dead centre in every view', () => {
    // The camera stands on the sheet, so a splat level with it lands on the
    // sheet — and the sheet plane is common to every view. This is both halves
    // of the window camera in one assertion.
    const cloud = cloudOf([[0, 0, 0, 4, 0, 0, 0, 255]]);
    const { views } = renderSplatViews(cloud, options({ views: 3 }));
    for (const v of views) {
      const c = centroid(v);
      expect(c.mass).toBeGreaterThan(0);
      expect(c.x).toBeCloseTo(31.5, 0);
      expect(c.y).toBeCloseTo(31.5, 0);
    }
  });

  it('slides a splat behind the sheet by exactly the disparity the optics predict', () => {
    // A modest cone and a shallow scene on purpose: at the 60° a real lens
    // spans, a splat 200 mm back moves 98 px, which is off a 64 px sheet
    // entirely — which is itself the parallax limit the print nodes warn about.
    const backMm = 20;
    const cloud = cloudOf([[0, 0, -backMm, 4, 0, 0, 0, 255]]);
    const o = options({ views: 2, coneDeg: 20 });
    const { views, offsetsMm } = renderSplatViews(cloud, o);
    const left = centroid(views[0]);
    const right = centroid(views[1]);
    const pxPerMm = o.widthPx / o.widthMm;
    const step = Math.abs(offsetsMm[1] - offsetsMm[0]);
    const expected = disparityAtDepth(step, -backMm, o.viewDistanceMm, 1).mm * pxPerMm;
    expect(Math.abs(right.x - left.x)).toBeCloseTo(expected, 0);
  });

  it('holds whatever the camera stands on perfectly still — that is what focus is', () => {
    // A lenticular print is sharp exactly where the parallax is zero. The
    // camera position is the sheet, so a splat there must not move by a pixel
    // across the run, while one behind it must.
    const o = options({ views: 5, coneDeg: 40 });
    const atCamera = renderSplatViews(cloudOf([[0, 0, 0, 4, 0, 0, 0, 255]]), o);
    const xs = atCamera.views.map((v) => centroid(v).x);
    // Exactly still by the algebra — at z = 0 the projection is X = e + 1·(x −
    // e) = x, and the eye drops out. What is left is a few thousandths of a
    // pixel of raster noise, because the *ellipse* still shears with the eye
    // even though its centre does not: a splat on the sheet has depth extent
    // like any other.
    for (const x of xs) expect(Math.abs(x - xs[0])).toBeLessThan(0.05);

    const behind = renderSplatViews(cloudOf([[0, 0, -30, 4, 0, 0, 0, 255]]), o);
    const moved = behind.views.map((v) => centroid(v).x);
    expect(Math.abs(moved[4] - moved[0])).toBeGreaterThan(1);
  });

  it('draws the nearer splat over the farther one', () => {
    const cloud = cloudOf([
      [0, 0, -500, 20, 255, 0, 0, 255], // red, far
      [0, 0, -400, 20, 0, 0, 255, 255], // blue, on the sheet
    ]);
    const { views } = renderSplatViews(cloud, options({ views: 1 }));
    const [r, , b] = at(views[0], 32, 32);
    expect(b).toBeGreaterThan(r);
  });

  it('shows the paper wherever the cloud is thin, and does not where it is not', () => {
    const cloud = cloudOf([[0, 0, -400, 2, 0, 0, 0, 255]]);
    const { views } = renderSplatViews(cloud, options({ views: 1, background: [255, 0, 0] }));
    // A corner nothing reaches is pure paper.
    expect(at(views[0], 0, 0)).toEqual([255, 0, 0]);
    expect(at(views[0], 32, 32)[0]).toBeLessThan(255);
  });

  it('drops everything in front of the sheet, because a print cannot show it', () => {
    const cloud = cloudOf([
      [0, 0, -50, 4, 0, 0, 0, 255], // behind the sheet: printable
      [0, 0, 0, 4, 0, 0, 0, 255], // on the sheet: printable
      [0, 0, 30, 4, 0, 0, 0, 255], // in front of it: would come out of the page
      [0, 0, 200, 4, 0, 0, 0, 255], // further out still
    ]);
    const r = renderSplatViews(cloud, options({ views: 1 }));
    expect(r.considered).toBe(2);
    expect(r.culled).toBe(2);
    // And nothing drawn is in front of the sheet.
    expect(r.nearMm).toBeGreaterThanOrEqual(0);
  });

  it('pushes the cull plane deeper when asked', () => {
    const cloud = cloudOf([
      [0, 0, -5, 4, 0, 0, 0, 255],
      [0, 0, -50, 4, 0, 0, 0, 255],
      [0, 0, -200, 4, 0, 0, 0, 255],
    ]);
    expect(renderSplatViews(cloud, options({ views: 1 })).considered).toBe(3);
    // 20 mm behind the sheet: the splat 5 mm back no longer qualifies.
    expect(renderSplatViews(cloud, options({ views: 1, frontMarginMm: 20 })).considered).toBe(2);
    expect(renderSplatViews(cloud, options({ views: 1, frontMarginMm: 100 })).considered).toBe(1);
  });

  it('survives a camera with the whole scene behind it', () => {
    // Everything culled: blank paper and an honest count, not a crash.
    const cloud = cloudOf([[0, 0, 100, 4, 0, 0, 0, 255]]);
    const r = renderSplatViews(cloud, options({ views: 2 }));
    expect(r.considered).toBe(0);
    expect(r.culled).toBe(1);
    expect(r.views).toHaveLength(2);
    expect(at(r.views[0], 32, 32)).toEqual([255, 255, 255]);
    expect(describePlacementOf(r)).toMatch(/Nothing survived/);
  });

  it('reports where the cloud sits relative to the sheet', () => {
    const cloud = cloudOf([
      [0, 0, -50, 4, 0, 0, 0, 255],
      [0, 0, -200, 4, 0, 0, 0, 255],
    ]);
    const r = renderSplatViews(cloud, options({ views: 1 }));
    // Behind the sheet is positive, as everywhere else in the tool.
    expect(r.nearMm).toBeCloseTo(50, 0);
    expect(r.farMm).toBeCloseTo(200, 0);
  });

  it('hands back a depth map with white nearest', () => {
    const cloud = cloudOf([
      [-25, 0, -50, 8, 0, 0, 0, 255],
      [25, 0, -500, 8, 0, 0, 0, 255],
    ]);
    const { depth } = renderSplatViews(cloud, options({ views: 1 }));
    const nearPx = at(depth, 16, 32)[0];
    const farPx = at(depth, 48, 32)[0];
    expect(nearPx).toBeGreaterThan(farPx);
  });

  it('lays a grid out in gridCells order, up-left first', () => {
    const eyes = splatEyeOffsets(options({ layout: '2d', grid: 3 }));
    expect(eyes).toHaveLength(9);
    // Row 0 is `Up`: the eye is above the sheet, so +y.
    expect(eyes[0].x).toBeLessThan(0);
    expect(eyes[0].y).toBeGreaterThan(0);
    expect(eyes[4].x).toBeCloseTo(0, 6);
    expect(eyes[4].y).toBeCloseTo(0, 6);
    expect(eyes[8].x).toBeGreaterThan(0);
    expect(eyes[8].y).toBeLessThan(0);
  });

  it('renders a grid layout as grid² views', () => {
    const cloud = cloudOf([[0, 0, -400, 6, 0, 0, 0, 255]]);
    const { views } = renderSplatViews(cloud, options({ layout: '2d', grid: 3, widthPx: 24 }));
    expect(views).toHaveLength(9);
  });

  it('turns the camera, and the scene turns the other way', () => {
    const cloud = cloudOf([[0, 0, -400, 4, 0, 0, 0, 255]]);
    const straight = renderSplatViews(cloud, options({ views: 1 }));
    const turned = renderSplatViews(
      cloud,
      options({ views: 1, camera: camera({ rotationDeg: [0, 5, 0] }) }),
    );
    // Yawing left (+Y) moves what was ahead to the right of frame.
    expect(centroid(turned.views[0]).x).toBeGreaterThan(centroid(straight.views[0]).x);
  });

  it('scale converts scene units to millimetres of paper', () => {
    // Same scene twice the size, at twice the scale, is the same picture.
    const small = cloudOf([[0, 0, -400, 4, 0, 0, 0, 255]]);
    const big = cloudOf([[0, 0, -800, 8, 0, 0, 0, 255]]);
    const a = renderSplatViews(small, options({ views: 1 }));
    const b = renderSplatViews(big, options({ views: 1, camera: camera({ scale: 2 }) }));
    expect(centroid(b.views[0]).mass).toBeCloseTo(centroid(a.views[0]).mass, -3);
  });

  it('takes the splat budget as a thinning, not a truncation', () => {
    const cloud = cloudOf(
      Array.from({ length: 100 }, (_, i) => [(i % 10) * 4 - 20, Math.floor(i / 10) * 4 - 20, -40, 2, 0, 0, 0, 255]),
    );
    const cam = toCameraSpace(cloud, options(), 20);
    expect(cam.count).toBe(20);
    // A stride, so the sample spans the whole cloud rather than its first fifth.
    const ys = new Set(Array.from({ length: 20 }, (_, i) => Math.round(cam.xyz[i * 3 + 1])));
    expect(ys.size).toBeGreaterThan(3);
  });
});

describe('splat cloud helpers', () => {
  const cloud = cloudOf([
    [-1, -2, -3, 1, 0, 0, 0, 255],
    [3, 2, 1, 1, 0, 0, 0, 255],
  ]);

  it('measures a cloud', () => {
    const b = cloudBounds(cloud);
    expect(b.min).toEqual([-1, -2, -3]);
    expect(b.max).toEqual([3, 2, 1]);
    expect(b.centre).toEqual([1, 0, -1]);
    expect(b.radius).toBeCloseTo(Math.hypot(4, 4, 4) / 2, 6);
  });

  it('keeps an empty cloud from producing infinities', () => {
    expect(cloudBounds(cloudOf([])).radius).toBe(0);
  });

  it('frames the whole cloud with the sheet on its near face', () => {
    const t = framingCamera(cloud, 100, 400);
    // Looking down −Z, so it stands on the +Z side of the scene's centre — far
    // enough forward that the sheet plane touches the front of the scene
    // rather than cutting through the middle of it.
    const b = cloudBounds(cloud);
    expect(t.position[2]).toBeCloseTo(b.centre[2] + b.radius, 6);
    expect(t.rotationDeg).toEqual([0, 0, 0]);
    expect(t.scale).toBeCloseTo((b.radius * 2) / 100, 6);
  });

  it('frames without culling anything — which is the whole point of framing there', () => {
    // The default framing and the front-of-sheet cull have to agree, or opening
    // the editor on a fresh cloud would throw half of it away.
    const scene = cloudOf(
      Array.from({ length: 40 }, (_, i) => [
        (i % 5) - 2,
        Math.floor(i / 5) - 4,
        -(i % 7),
        0.2,
        0,
        0,
        0,
        255,
      ]),
    );
    const r = renderSplatViews(scene, options({ views: 1, camera: framingCamera(scene, 100, 400) }));
    expect(r.culled).toBe(0);
    expect(r.considered).toBe(scene.count);
    expect(r.coverage).toBeGreaterThan(0);
  });

  it('flies along the axes it is facing', () => {
    const straight = cameraAxes([0, 0, 0]);
    expect(straight.forward.map(round0)).toEqual([0, 0, -1]);
    expect(straight.right.map(round0)).toEqual([1, 0, 0]);
    expect(straight.up.map(round0)).toEqual([0, 1, 0]);
    // Yaw 90° faces −X, and yaw is about the world's up axis whatever the
    // pitch, so the horizon cannot drift.
    const yawed = cameraAxes([0, 90, 0]);
    expect(yawed.forward.map(round0)).toEqual([-1, 0, 0]);
    const pitched = cameraAxes([-90, 0, 0]);
    expect(pitched.forward.map(round0)).toEqual([0, -1, 0]);
  });
});

describe('the budget is spent on what is in frame', () => {
  /**
   * Half the splats sit on the sheet in front of the camera; the other half are
   * the same distance off to the side, far outside the paper. A budget should
   * buy density in the half you can see and nothing at all in the half you
   * cannot.
   */
  const halfInFrame = () =>
    cloudOf([
      ...Array.from({ length: 200 }, (_, i) => [(i % 20) - 10, Math.floor(i / 20) - 5, -20, 0.5, 0, 0, 0, 255]),
      ...Array.from({ length: 200 }, (_, i) => [900 + (i % 20), Math.floor(i / 20), -20, 0.5, 0, 0, 0, 255]),
    ]);

  it('drops what cannot land on the sheet in any view', () => {
    const r = renderSplatViews(halfInFrame(), options({ views: 3 }));
    expect(r.offSheet).toBe(200);
    expect(r.considered).toBe(200);
    expect(r.culled).toBe(0);
  });

  it('spends the whole budget on the visible half', () => {
    // 100 splats of budget against a cloud that is half out of frame. Thinning
    // first would give 50 visible ones; culling first gives 100 — twice the
    // density on the paper for the same work.
    const o = options({ views: 1, splatBudget: 100 });
    const cam = toCameraSpace(halfInFrame(), o, 100);
    expect(cam.count).toBe(100);
    expect(cam.thinned).toBe(100);
    // Every one of them is on the sheet, not one from the group off to the side.
    for (let i = 0; i < cam.count; i++) expect(Math.abs(cam.xyz[i * 3])).toBeLessThan(50);
    // Nothing the budget spent was invisible: the culls ran first.
    expect(cam.culled + cam.offSheet + cam.thinned + cam.count).toBe(cam.scanned);
  });

  it('keeps everything when there is no budget', () => {
    const r = renderSplatViews(halfInFrame(), options({ views: 1 }));
    expect(r.thinned).toBe(0);
    expect(r.considered).toBe(200);
    expect(r.scanned).toBe(400);
  });

  it('never drops a splat that reaches onto the sheet from outside it', () => {
    // Centre outside the paper, but wide enough to reach in: the frame test is
    // widened by the splat's own extent precisely so this survives.
    const wide = cloudOf([[60, 0, -20, 30, 0, 0, 0, 255]]);
    expect(renderSplatViews(wide, options({ views: 1 })).offSheet).toBe(0);
    // The same splat, small, is genuinely outside and goes.
    const small = cloudOf([[60, 0, -20, 0.5, 0, 0, 0, 255]]);
    expect(renderSplatViews(small, options({ views: 1 })).offSheet).toBe(1);
  });

  it('keeps what only the outermost eye of the run can see', () => {
    // Just off the paper head-on, but a wide cone swings it into frame — the
    // cull spans every eye, so it is kept for the views that need it.
    const cloud = cloudOf([[0, 0, -200, 1, 0, 0, 0, 255]]);
    // 100 units off-axis: at a third of the way to the sheet plane that lands
    // 67 mm out, past the 50 mm edge of the paper.
    const off = { ...options({ views: 3, coneDeg: 0 }), camera: camera({ position: [100, 0, 0] }) };
    expect(renderSplatViews(cloud, off).offSheet).toBe(1);
    expect(renderSplatViews(cloud, { ...off, coneDeg: 120 }).offSheet).toBe(0);
  });
});
