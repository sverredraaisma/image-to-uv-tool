import { describe, it, expect } from 'vitest';
import { renderSplatViews, splatEyeOffsets, toCameraSpace, type SplatViewOptions } from './render';
import { cameraAxes, cloudBounds, decimate, framingCamera } from './cloud';
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
  nearClipMm: 1,
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
  it('puts a splat on the sheet plane in the middle of every view', () => {
    // A splat exactly D in front of the camera lands on the sheet, and the
    // sheet plane is common to every view — that is the whole window camera.
    const cloud = cloudOf([[0, 0, -400, 4, 0, 0, 0, 255]]);
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
    const cloud = cloudOf([[0, 0, -(400 + backMm), 4, 0, 0, 0, 255]]);
    const o = options({ views: 2, coneDeg: 20 });
    const { views, offsetsMm } = renderSplatViews(cloud, o);
    const left = centroid(views[0]);
    const right = centroid(views[1]);
    const pxPerMm = o.widthPx / o.widthMm;
    const step = Math.abs(offsetsMm[1] - offsetsMm[0]);
    const expected = disparityAtDepth(step, -backMm, o.viewDistanceMm, 1).mm * pxPerMm;
    expect(Math.abs(right.x - left.x)).toBeCloseTo(expected, 0);
  });

  it('moves a splat in front of the sheet the other way', () => {
    // In front of the sheet the parallax reverses sign — the pop-out case.
    const front = cloudOf([[0, 0, -380, 4, 0, 0, 0, 255]]);
    const behind = cloudOf([[0, 0, -420, 4, 0, 0, 0, 255]]);
    const o = options({ views: 2, coneDeg: 20 });
    const f = renderSplatViews(front, o).views;
    const b = renderSplatViews(behind, o).views;
    const dFront = centroid(f[1]).x - centroid(f[0]).x;
    const dBehind = centroid(b[1]).x - centroid(b[0]).x;
    expect(Math.sign(dFront)).toBe(-Math.sign(dBehind));
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

  it('respects the near clip rather than smearing a floater across the frame', () => {
    const cloud = cloudOf([
      [0, 0, -400, 4, 0, 0, 0, 255],
      [0, 0, -1, 4, 0, 0, 0, 255], // 1 mm from the eye
    ]);
    const near = renderSplatViews(cloud, options({ views: 1, nearClipMm: 50 }));
    const noClip = renderSplatViews(cloud, options({ views: 1, nearClipMm: 0.1 }));
    expect(near.drawn).toBe(1);
    expect(noClip.drawn).toBe(2);
    expect(centroid(noClip.views[0]).mass).toBeGreaterThan(centroid(near.views[0]).mass);
  });

  it('reports where the cloud sits relative to the sheet', () => {
    const cloud = cloudOf([
      [0, 0, -450, 4, 0, 0, 0, 255],
      [0, 0, -600, 4, 0, 0, 0, 255],
    ]);
    const r = renderSplatViews(cloud, options({ views: 1 }));
    // Behind the sheet is positive, as everywhere else in the tool.
    expect(r.nearMm).toBeCloseTo(50, 0);
    expect(r.farMm).toBeCloseTo(200, 0);
  });

  it('hands back a depth map with white nearest', () => {
    const cloud = cloudOf([
      [-25, 0, -450, 8, 0, 0, 0, 255],
      [25, 0, -900, 8, 0, 0, 0, 255],
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
      Array.from({ length: 100 }, (_, i) => [(i % 10) * 4 - 20, Math.floor(i / 10) * 4 - 20, -400, 2, 0, 0, 0, 255]),
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

  it('thins by an even stride and says how many went', () => {
    const many = cloudOf(Array.from({ length: 10 }, (_, i) => [i, 0, 0, 1, 0, 0, 0, 255]));
    const few = decimate(many, 5);
    expect(few.count).toBe(5);
    expect(few.droppedCount).toBe(5);
    expect([...few.positions.filter((_, i) => i % 3 === 0)]).toEqual([0, 2, 4, 6, 8]);
    // Under the cap it is the same object, not a copy.
    expect(decimate(many, 20)).toBe(many);
  });

  it('gives a camera that frames the whole cloud from in front of it', () => {
    const t = framingCamera(cloud, 100, 400);
    // Looking down −Z, so it stands on the +Z side of the scene's centre.
    expect(t.position[2]).toBeGreaterThan(cloudBounds(cloud).centre[2]);
    expect(t.rotationDeg).toEqual([0, 0, 0]);
    expect(t.scale).toBeGreaterThan(0);
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
