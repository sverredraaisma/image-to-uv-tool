import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FILE_FIELDS,
  MAX_STEP_LENSLETS,
  cameraBasis,
  coneDegrees,
  dollyFile,
  dollyPoints,
  parallaxAt,
  quaternionFromYawPitch,
  reportFor,
  rotate,
  viewsForDepth,
  type DollyOptions,
  type PrintTarget,
} from './vrchatDolly';
import { gridCells, lensGeometry } from './lenticular';
import { eyeOffsetsMm } from './render3d';

const options = (over: Partial<DollyOptions> = {}): DollyOptions => ({
  layout: { kind: 'sequence', views: 5 },
  cone: { kind: 'manual', coneDeg: 60 },
  anchor: { x: 0, y: 1, z: 0 },
  distanceM: 4,
  headingDeg: 0,
  pitchDeg: 0,
  holdSeconds: 4,
  zoom: 50,
  aperture: 15,
  ...over,
});

const target: PrintTarget = { lpi: 45, printWidthMm: 100, fovDeg: 60 };

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

describe('the camera never rotates', () => {
  it('gives every stop on a run the same rotation', () => {
    const points = dollyPoints(options({ layout: { kind: 'sequence', views: 9 } }));
    for (const p of points) expect(p.rotation).toEqual(points[0].rotation);
  });

  it('gives every stop on a grid the same rotation, too', () => {
    const points = dollyPoints(options({ layout: { kind: 'grid', grid: 4 }, headingDeg: 137 }));
    expect(points).toHaveLength(16);
    for (const p of points) expect(p.rotation).toEqual(points[0].rotation);
  });

  it('never asks the camera to look at anything', () => {
    // LookAtMe would turn the camera per shot, which is the one thing that
    // cannot be undone in the print.
    const o = options();
    const file = dollyFile(dollyPoints(o), o, { LookAtMe: true, Nonsense: 1 });
    for (const point of file) expect(point.LookAtMe).toBe(false);
  });
});

describe('where the stops stand', () => {
  it('lays them on a plane square to the camera, at the viewing distance', () => {
    const o = options({ layout: { kind: 'sequence', views: 7 }, headingDeg: 41, pitchDeg: -12 });
    const { forward, right, up } = cameraBasis(quaternionFromYawPitch(o.headingDeg, o.pitchDeg));
    for (const p of dollyPoints(o)) {
      const toAnchor = {
        x: o.anchor.x - p.position.x,
        y: o.anchor.y - p.position.y,
        z: o.anchor.z - p.position.z,
      };
      // Every stop is exactly `distance` along its own forward from the plane
      // through the anchor, and only sideways/up from the centre line.
      expect(dot(toAnchor, forward)).toBeCloseTo(o.distanceM, 9);
      expect(dot(toAnchor, right)).toBeCloseTo(-p.offsetM.right, 9);
      expect(dot(toAnchor, up)).toBeCloseTo(-p.offsetM.up, 9);
    }
  });

  it('spaces them exactly as the renderer spaces its eyes', () => {
    const o = options({ layout: { kind: 'sequence', views: 6 }, coneDeg: undefined } as never);
    const points = dollyPoints(o);
    const expected = eyeOffsetsMm(6, 60, o.distanceM * 1000).map((mm) => mm / 1000);
    expect(points.map((p) => p.offsetM.right)).toEqual(expected);
    // Tan-spaced, so the outer gap is wider than the middle one — that is what
    // spans the cone evenly in angle rather than in position.
    const gaps = expected.slice(1).map((v, i) => v - expected[i]);
    expect(gaps[0]).toBeGreaterThan(gaps[Math.floor(gaps.length / 2)]);
  });

  it('takes its cone from the lens, like the print does', () => {
    const cone = coneDegrees({ kind: 'lens', lpi: 45, heightMm: 0.9, ri: 1.5 });
    const solved = lensGeometry({
      widthMm: 100,
      ppi: 1440,
      lpi: 45,
      phase: 0,
      heightMm: 0.9,
      ri: 1.5,
      orientationDeg: 0,
      stripSamples: 2,
    });
    expect(cone).toBeCloseTo(solved.viewAngleDeg, 12);
  });

  it('builds an orthonormal basis at any heading and pitch', () => {
    const q = quaternionFromYawPitch(-73, 21);
    const { right, up, forward } = cameraBasis(q);
    for (const v of [right, up, forward]) expect(Math.hypot(v.x, v.y, v.z)).toBeCloseTo(1, 12);
    expect(dot(right, up)).toBeCloseTo(0, 12);
    expect(dot(right, forward)).toBeCloseTo(0, 12);
    expect(dot(up, forward)).toBeCloseTo(0, 12);
    // Yaw 180° turns the camera round: a half-turn about Y.
    expect(rotate(quaternionFromYawPitch(180, 0), { x: 0, y: 0, z: 1 }).z).toBeCloseTo(-1, 12);
  });
});

describe('capture order', () => {
  it('walks a grid in the order the print node names its cells', () => {
    const points = dollyPoints(options({ layout: { kind: 'grid', grid: 3 } }));
    expect(points.map((p) => p.label)).toEqual(gridCells(3).map((c) => c.label));
  });

  it('puts the Up row above and the Left column to the camera’s left', () => {
    const points = dollyPoints(options({ layout: { kind: 'grid', grid: 3 } }));
    const byLabel = (label: string) => points.find((p) => p.label === label)!;
    expect(byLabel('Left · Up').offsetM.up).toBeGreaterThan(0);
    expect(byLabel('Left · Up').offsetM.right).toBeLessThan(0);
    expect(byLabel('Right · Down').offsetM.up).toBeLessThan(0);
    expect(byLabel('Right · Down').offsetM.right).toBeGreaterThan(0);
    expect(byLabel('Centre (neutral)').offsetM.right).toBeCloseTo(0, 12);
    expect(byLabel('Centre (neutral)').offsetM.up).toBeCloseTo(0, 12);
  });

  it('runs a 1D path left eye first, as the renderer hands its views over', () => {
    const points = dollyPoints(options({ layout: { kind: 'sequence', views: 4 } }));
    expect(points[0].offsetM.right).toBeLessThan(0);
    expect(points[3].offsetM.right).toBeGreaterThan(0);
    expect(points.map((p) => p.label)).toEqual(['View 1/4', 'View 2/4', 'View 3/4', 'View 4/4']);
  });
});

describe('the file', () => {
  it('carries the path settings on every point', () => {
    const o = options({ holdSeconds: 2.5, zoom: 70, aperture: 8, focus: 3 });
    const file = dollyFile(dollyPoints(o), o);
    expect(file).toHaveLength(5);
    for (const point of file) {
      expect(point.Duration).toBe(2.5);
      expect(point.Zoom).toBe(70);
      expect(point.Aperture).toBe(8);
      expect(point.Focus).toBe(3);
    }
    expect(file[0].Position.x).toBeCloseTo(dollyPoints(o)[0].position.x, 5);
    expect(Object.keys(file[0])[0]).toBe('Position');
  });

  it('focuses on the sharp plane unless told otherwise', () => {
    const o = options({ distanceM: 6 });
    expect(dollyFile(dollyPoints(o), o)[0].Focus).toBe(6);
  });

  it('keeps unknown fields from a path exported by the client', () => {
    // The client's own format is the authority; anything it carries that this
    // does not know about rides along untouched.
    const o = options();
    const file = dollyFile(dollyPoints(o), o, { ...DEFAULT_FILE_FIELDS, SomeNewField: 42 });
    expect(file[0].SomeNewField).toBe(42);
  });
});

describe('what it is worth as a print', () => {
  it('reports the framing that ties metres to lenslets', () => {
    const o = options({ distanceM: 4 });
    const report = reportFor(o, target);
    // 60° across at 4 m is 4.62 m of world in frame; 100 mm at 45 LPI is 177
    // lenslets, so a lenslet is 26 mm of subject.
    expect(report.frameWidthM).toBeCloseTo(2 * 4 * Math.tan(Math.PI / 6), 9);
    expect(report.lensletsAcross).toBeCloseTo((100 * 45) / 25.4, 9);
    expect(report.metresPerLenslet).toBeCloseTo(report.frameWidthM / report.lensletsAcross, 12);
  });

  it('agrees with the parallax it predicts at that depth', () => {
    const o = options({ layout: { kind: 'sequence', views: 12 }, distanceM: 4 });
    const budget = reportFor(o, target).depthBudgetM(MAX_STEP_LENSLETS);
    expect(parallaxAt(o, target, budget.behind)).toBeCloseTo(MAX_STEP_LENSLETS, 6);
    // …and a shallower scene stays under it.
    expect(parallaxAt(o, target, budget.behind / 2)).toBeLessThan(MAX_STEP_LENSLETS);
  });

  it('costs less depth in front of the plane than behind it', () => {
    const budget = reportFor(options({ layout: { kind: 'sequence', views: 8 } }), target).depthBudgetM(1);
    expect(budget.inFront).toBeLessThan(budget.behind);
  });

  it('says how many shots a given scene depth needs, and means it', () => {
    const o = options({ layout: { kind: 'sequence', views: 12 }, distanceM: 3 });
    const zoomed: PrintTarget = { ...target, fovDeg: 40 };
    const needed = viewsForDepth(o, zoomed, 2);
    expect(needed).toBeGreaterThan(12);
    // Take that many and the parallax really does land inside the budget.
    const enough = options({ ...o, layout: { kind: 'sequence', views: needed } });
    expect(parallaxAt(enough, zoomed, 2)).toBeLessThanOrEqual(MAX_STEP_LENSLETS);
    // One fewer and it does not.
    const short = options({ ...o, layout: { kind: 'sequence', views: needed - 1 } });
    expect(parallaxAt(short, zoomed, 2)).toBeGreaterThan(MAX_STEP_LENSLETS * 0.98);
  });

  it('buys shots back by framing wider, not by walking about', () => {
    // A wider frame gives each lenslet more of the world to cover, so the same
    // camera step crosses fewer of them. Zooming in is the expensive direction.
    const o = options({ layout: { kind: 'sequence', views: 12 }, distanceM: 4 });
    const wide = viewsForDepth(o, { ...target, fovDeg: 60 }, 2);
    const tight = viewsForDepth(o, { ...target, fovDeg: 20 }, 2);
    expect(wide).toBeLessThan(tight / 2);
    // Standing somewhere else barely moves it by comparison.
    const closer = viewsForDepth(options({ ...o, distanceM: 2 }), target, 2);
    expect(Math.abs(closer - wide)).toBeLessThan(tight - wide);
  });
});
