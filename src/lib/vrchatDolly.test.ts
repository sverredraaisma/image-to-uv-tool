import { describe, it, expect } from 'vitest';
import {
  DEFAULT_FILE_FIELDS,
  MAX_STEP_LENSLETS,
  blurLenslets,
  cameraBasis,
  coneDegrees,
  cropFilter,
  dollyFile,
  dollyPoints,
  legSeconds,
  maxViewsForLens,
  parallaxAt,
  quaternionFromYawPitch,
  reportFor,
  rotate,
  viewTimestamps,
  viewsForDepth,
  type DollyOptions,
  type PrintTarget,
} from './vrchatDolly';
import { lensGeometry } from './lenticular';
import { eyeOffsetsMm } from './render3d';

const options = (over: Partial<DollyOptions> = {}): DollyOptions => ({
  views: 5,
  cone: { kind: 'manual', coneDeg: 60 },
  anchor: { x: 0, y: 1, z: 0 },
  distanceM: 4,
  headingDeg: 0,
  pitchDeg: 0,
  durationSeconds: 20,
  zoom: 50,
  aperture: 15,
  ...over,
});

const target: PrintTarget = {
  lpi: 45,
  printWidthMm: 100,
  fovDeg: 60,
  fps: 60,
  ppi: 1440,
  stripSamples: 2,
};

const dot = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }) =>
  a.x * b.x + a.y * b.y + a.z * b.z;

describe('the camera never rotates', () => {
  it('gives every stop on a run the same rotation', () => {
    const points = dollyPoints(options({ views: 9 }));
    for (const p of points) expect(p.rotation).toEqual(points[0].rotation);
  });

  it('holds it through a turned sweep too', () => {
    const points = dollyPoints(options({ views: 16, headingDeg: 137, pitchDeg: -8 }));
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
    const o = options({ views: 7, headingDeg: 41, pitchDeg: -12 });
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
      expect(dot(toAnchor, right)).toBeCloseTo(-p.offsetM, 9);
      expect(dot(toAnchor, up)).toBeCloseTo(0, 9);
    }
  });

  it('spaces them exactly as the renderer spaces its eyes', () => {
    const o = options({ views: 6 });
    const points = dollyPoints(o);
    const expected = eyeOffsetsMm(6, 60, o.distanceM * 1000).map((mm) => mm / 1000);
    expect(points.map((p) => p.offsetM)).toEqual(expected);
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

describe('the sweep', () => {
  it('runs left eye first, as the renderer hands its views over', () => {
    const points = dollyPoints(options({ views: 4 }));
    expect(points[0].offsetM).toBeLessThan(0);
    expect(points[3].offsetM).toBeGreaterThan(0);
    expect(points.map((p) => p.label)).toEqual(['View 1/4', 'View 2/4', 'View 3/4', 'View 4/4']);
  });

  it('puts every view at a known moment of the recording', () => {
    const o = options({ views: 5, durationSeconds: 20 });
    const points = dollyPoints(o);
    // Equal legs, so view k is k × leg into the sweep — which is what makes
    // the frames pullable by timestamp instead of by hand.
    expect(points.map((p) => p.timeSeconds)).toEqual([0, 5, 10, 15, 20]);
    expect(legSeconds(o)).toBe(5);
    expect(points[points.length - 1].timeSeconds).toBeCloseTo(o.durationSeconds, 9);
  });

  it('never holds anywhere: every leg is the same length of time', () => {
    const o = options({ views: 9, durationSeconds: 12 });
    const file = dollyFile(dollyPoints(o), o);
    expect(new Set(file.map((p) => p.Duration)).size).toBe(1);
    expect(file[0].Duration).toBeCloseTo(12 / 8, 9);
  });
});

describe('pulling the views back out of a recording', () => {
  it('puts the views at the same times the path does', () => {
    const o = options({ views: 5, durationSeconds: 20 });
    expect(viewTimestamps(o.views, o.durationSeconds)).toEqual(dollyPoints(o).map((p) => p.timeSeconds));
  });

  it('crops to the sheet without needing to know the recording size', () => {
    // iw/ih are ffmpeg's own, so nothing here has to probe the video first.
    const filter = cropFilter(4 / 3);
    expect(filter).toContain('min(iw');
    expect(filter).toContain('(iw-out_w)/2');
    // The commas inside min() are escaped, or ffmpeg reads them as the end of
    // the filter and the crop silently becomes something else.
    expect(filter).toContain(String.raw`min(iw\,ih*`);
    expect(filter.replace(/\\,/g, '')).not.toContain(',');
  });

  it('zooms and offsets the crop', () => {
    expect(cropFilter(1, 2)).toContain(')/2:');
    const moved = cropFilter(1, 1, { x: 0.25, y: -0.1 });
    expect(moved).toContain('+iw*0.25');
    expect(moved).toContain('+ih*-0.1');
  });
});

describe('the file', () => {
  it('carries the path settings on every point', () => {
    const o = options({ views: 5, durationSeconds: 10, zoom: 70, aperture: 8, focus: 3 });
    const file = dollyFile(dollyPoints(o), o);
    expect(file).toHaveLength(5);
    for (const point of file) {
      expect(point.Duration).toBeCloseTo(2.5, 9);
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
    const o = options({ views: 12, distanceM: 4 });
    const budget = reportFor(o, target).depthBudgetM(MAX_STEP_LENSLETS);
    expect(parallaxAt(o, target, budget.behind)).toBeCloseTo(MAX_STEP_LENSLETS, 6);
    // …and a shallower scene stays under it.
    expect(parallaxAt(o, target, budget.behind / 2)).toBeLessThan(MAX_STEP_LENSLETS);
  });

  it('costs less depth in front of the plane than behind it', () => {
    const budget = reportFor(options({ views: 8 }), target).depthBudgetM(1);
    expect(budget.inFront).toBeLessThan(budget.behind);
  });

  it('says how many shots a given scene depth needs, and means it', () => {
    const o = options({ views: 12, distanceM: 3 });
    const zoomed: PrintTarget = { ...target, fovDeg: 40 };
    const needed = viewsForDepth(o, zoomed, 2);
    expect(needed).toBeGreaterThan(12);
    // Take that many and the parallax really does land inside the budget.
    const enough = options({ ...o, views: needed });
    expect(parallaxAt(enough, zoomed, 2)).toBeLessThanOrEqual(MAX_STEP_LENSLETS);
    // One fewer and it does not.
    const short = options({ ...o, views: needed - 1 });
    expect(parallaxAt(short, zoomed, 2)).toBeGreaterThan(MAX_STEP_LENSLETS * 0.98);
  });

  it('caps the views at what a lenticule can carry', () => {
    // 1440 PPI over 45 LPI is 32 printed dots per lenticule; at two dots a
    // strip that is 16 frames, however many the recording could give you.
    expect(maxViewsForLens(target)).toBe(16);
    expect(maxViewsForLens({ ...target, stripSamples: 1 })).toBe(32);
    expect(maxViewsForLens({ ...target, ppi: 720 })).toBe(8);
  });

  it('measures the smear inside one recorded frame, and how to shrink it', () => {
    const o = options({ views: 16, durationSeconds: 20, distanceM: 4 });
    const blur = blurLenslets(o, target, 1);
    expect(blur).toBeGreaterThan(0);
    // A recorded frame is a slice of the sweep, so it smears by a fraction of
    // the step between views — 60 fps over a 1.33 s leg is 80 frames a view.
    expect(blur).toBeLessThan(parallaxAt(o, target, 1));
    // Both ways out cost nothing but time, and both work.
    expect(blurLenslets(options({ ...o, durationSeconds: 40 }), target, 1)).toBeCloseTo(blur / 2, 6);
    expect(blurLenslets(o, { ...target, fps: 120 }, 1)).toBeCloseTo(blur / 2, 6);
  });

  it('reports the sweep as something to record', () => {
    const o = options({ views: 16, durationSeconds: 20, distanceM: 4 });
    const report = reportFor(o, target);
    expect(report.durationS).toBeCloseTo(20, 9);
    expect(report.legS).toBeCloseTo(20 / 15, 9);
    expect(report.framesPerView).toBeCloseTo((20 / 15) * 60, 9);
    expect(report.sweepM).toBeCloseTo(2 * report.outerM, 9);
    // The camera is fastest at the ends, so the quoted movement per recorded
    // frame is the widest leg's, not the average.
    expect(report.metresPerRecordedFrame).toBeCloseTo(report.stepM / report.framesPerView, 9);
  });

  it('buys shots back by framing wider, not by walking about', () => {
    // A wider frame gives each lenslet more of the world to cover, so the same
    // camera step crosses fewer of them. Zooming in is the expensive direction.
    const o = options({ views: 12, distanceM: 4 });
    const wide = viewsForDepth(o, { ...target, fovDeg: 60 }, 2);
    const tight = viewsForDepth(o, { ...target, fovDeg: 20 }, 2);
    expect(wide).toBeLessThan(tight / 2);
    // Standing somewhere else barely moves it by comparison.
    const closer = viewsForDepth(options({ ...o, distanceM: 2 }), target, 2);
    expect(Math.abs(closer - wide)).toBeLessThan(tight - wide);
  });
});
