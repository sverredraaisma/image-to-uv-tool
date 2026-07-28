import { describe, it, expect } from 'vitest';
import { createImage } from './image';
import {
  MAX_OUTPUT_PIXELS,
  calibrationValues,
  depthPreview,
  describeGeometry,
  lensGeometry,
  outputSize,
  renderLenticular,
  withCalibrationValue,
  type LenticularSettings,
} from './lenticular';
import type { RasterImage } from '../types';

/** Small, fast test settings: 100 px wide, 10 px per lenticule. */
const settings = (over: Partial<LenticularSettings> = {}): LenticularSettings => ({
  widthMm: 25.4,
  ppi: 100,
  lpi: 10,
  phase: 0,
  heightMm: 5,
  ri: 1.5,
  orientationDeg: 0,
  ...over,
});

const solid = (color: [number, number, number], w = 20, h = 20): RasterImage =>
  createImage(w, h, [...color, 255]);

const RED = solid([255, 0, 0]);
const BLUE = solid([0, 0, 255]);
const GREEN = solid([0, 255, 0]);

const pixelAt = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const depthAt = (r: { depth: Uint16Array; width: number }, x: number, y: number) => r.depth[y * r.width + x];
/** Spread-free max — these buffers are millions of entries long. */
const maxOf = (values: Uint16Array) => values.reduce((m, v) => (v > m ? v : m), 0);

describe('lensGeometry', () => {
  it('focuses exactly on the artwork for a feasible height', () => {
    const g = lensGeometry(settings({ lpi: 45, heightMm: 0.9, ri: 1.5 }));
    expect(g.feasible).toBe(true);
    // The whole design constraint: focus distance === total gloss height.
    expect(g.focusMm).toBeCloseTo(0.9, 6);
    expect(g.totalMm).toBeCloseTo(0.9, 6);
    expect(g.baseMm).toBeCloseTo(0.9 - g.sagMm, 6);
  });

  it('picks the printable (minor-arc) root, never a past-hemisphere lens', () => {
    const g = lensGeometry(settings({ lpi: 45, heightMm: 0.9 }));
    expect(g.sagMm).toBeGreaterThan(0);
    expect(g.sagMm).toBeLessThan(g.pitchMm / 2);
    expect(g.sagMm).toBeLessThan(g.radiusMm);
  });

  it('derives the radius from the sag and the chord', () => {
    const g = lensGeometry(settings({ lpi: 45, heightMm: 1.2 }));
    const half = g.pitchMm / 2;
    expect(g.radiusMm).toBeCloseTo((g.sagMm * g.sagMm + half * half) / (2 * g.sagMm), 9);
  });

  it('reports the pitch in mm and printer pixels', () => {
    const g = lensGeometry(settings({ lpi: 45, ppi: 1440 }));
    expect(g.pitchMm).toBeCloseTo(25.4 / 45, 9);
    expect(g.pitchPx).toBeCloseTo(32, 9);
  });

  it('flags an unreachable height and falls back to a hemisphere', () => {
    const g = lensGeometry(settings({ lpi: 45, heightMm: 0.4, ri: 1.5 }));
    expect(g.feasible).toBe(false);
    expect(g.sagMm).toBeCloseTo(g.pitchMm / 2, 9); // hemisphere = strongest lens
    expect(g.focusMm).toBeGreaterThan(0.4); // still can't reach the artwork
    expect(g.minHeightMm).toBeCloseTo((1.5 * g.pitchMm) / (2 * 0.5), 9);
  });

  it('reports the minimum feasible height as the exact feasibility boundary', () => {
    const min = lensGeometry(settings({ lpi: 45, heightMm: 0.9 })).minHeightMm;
    expect(lensGeometry(settings({ lpi: 45, heightMm: min * 1.001 })).feasible).toBe(true);
    expect(lensGeometry(settings({ lpi: 45, heightMm: min * 0.999 })).feasible).toBe(false);
  });

  it('needs less height as LPI rises (finer lenses focus shorter)', () => {
    const coarse = lensGeometry(settings({ lpi: 20 }));
    const fine = lensGeometry(settings({ lpi: 60 }));
    expect(fine.minHeightMm).toBeLessThan(coarse.minHeightMm);
  });

  it('needs less height as RI rises (stronger refraction)', () => {
    const low = lensGeometry(settings({ ri: 1.4 }));
    const high = lensGeometry(settings({ ri: 1.7 }));
    expect(high.minHeightMm).toBeLessThan(low.minHeightMm);
  });

  it('reports a plausible viewing cone', () => {
    const g = lensGeometry(settings({ lpi: 45, heightMm: 0.9, ri: 1.5 }));
    expect(g.viewAngleDeg).toBeGreaterThan(20);
    expect(g.viewAngleDeg).toBeLessThan(90);
  });
});

describe('outputSize', () => {
  it('takes width from mm × PPI and height from the frame aspect', () => {
    const size = outputSize(settings({ widthMm: 100, ppi: 1440 }), createImage(400, 300));
    expect(size.width).toBe(Math.round((100 / 25.4) * 1440));
    expect(size.height).toBe(Math.round((size.width * 300) / 400));
  });

  it('ignores the aspect of every frame but the first', () => {
    const a = outputSize(settings(), createImage(100, 50));
    const b = outputSize(settings(), createImage(100, 50));
    expect(a).toEqual(b);
  });
});

describe('renderLenticular — interlacing', () => {
  it('gives each frame an equal slice of every lenticule', () => {
    const r = renderLenticular([RED, BLUE], settings());
    expect(r.width).toBe(100);
    // 10 px per lenticule, 2 frames → 5 px each, repeating.
    for (let x = 0; x < 5; x++) expect(pixelAt(r.interlaced, x, 0)).toEqual([255, 0, 0]);
    for (let x = 5; x < 10; x++) expect(pixelAt(r.interlaced, x, 0)).toEqual([0, 0, 255]);
    expect(pixelAt(r.interlaced, 10, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(r.interlaced, 95, 0)).toEqual([0, 0, 255]);
  });

  it('splits three frames across the lenticule', () => {
    const r = renderLenticular([RED, GREEN, BLUE], settings());
    expect(pixelAt(r.interlaced, 0, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(r.interlaced, 4, 0)).toEqual([0, 255, 0]);
    expect(pixelAt(r.interlaced, 8, 0)).toEqual([0, 0, 255]);
  });

  it('phase shifts the strips within the lenticule', () => {
    const r = renderLenticular([RED, BLUE], settings({ phase: 0.5 }));
    expect(pixelAt(r.interlaced, 0, 0)).toEqual([0, 0, 255]);
    expect(pixelAt(r.interlaced, 5, 0)).toEqual([255, 0, 0]);
  });

  it('wraps a phase outside 0–1 instead of drifting', () => {
    const a = renderLenticular([RED, BLUE], settings({ phase: 0.25 }));
    const b = renderLenticular([RED, BLUE], settings({ phase: 2.25 }));
    expect(b.interlaced.data).toEqual(a.interlaced.data);
  });

  it('runs the strips along y when the orientation is 90°', () => {
    const r = renderLenticular([RED, BLUE], settings({ orientationDeg: 90 }));
    // Constant across a row, alternating down the column.
    expect(pixelAt(r.interlaced, 0, 0)).toEqual(pixelAt(r.interlaced, 37, 0));
    expect(pixelAt(r.interlaced, 0, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(r.interlaced, 0, 5)).toEqual([0, 0, 255]);
  });

  it('samples the lenticule centre, so every strip shows the same spot', () => {
    // A horizontal ramp: each lenticule must be flat (one colour), because all
    // its strips sample the lenticule's centre, just from different frames.
    const ramp = createImage(100, 4);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 100; x++) {
        const i = (y * 100 + x) * 4;
        ramp.data[i] = x * 2;
        ramp.data[i + 3] = 255;
      }
    }
    const r = renderLenticular([ramp, ramp], settings());
    const first = pixelAt(r.interlaced, 0, 0)[0];
    for (let x = 1; x < 10; x++) expect(pixelAt(r.interlaced, x, 0)[0]).toBe(first);
    // …and the next lenticule steps to a new value.
    expect(pixelAt(r.interlaced, 10, 0)[0]).toBeGreaterThan(first);
  });

  it('refuses fewer than two frames', () => {
    expect(() => renderLenticular([RED], settings())).toThrow(/at least 2 images/);
    expect(() => renderLenticular([], settings())).toThrow(/at least 2 images/);
  });

  it('refuses a render above the pixel budget', () => {
    expect(() => renderLenticular([RED, BLUE], settings({ widthMm: 5000, ppi: 1440 }))).toThrow(
      /Reduce Width/,
    );
    expect(MAX_OUTPUT_PIXELS).toBeGreaterThan(30_000_000);
  });
});

describe('renderLenticular — gloss depth map', () => {
  it('peaks at the lenticule centre and bottoms out at its edge', () => {
    const r = renderLenticular([RED, BLUE], settings());
    const edge = depthAt(r, 0, 0);
    const centre = depthAt(r, 5, 0);
    expect(centre).toBeGreaterThan(edge);
    for (let x = 1; x <= 4; x++) expect(depthAt(r, x, 0)).toBeGreaterThan(depthAt(r, x - 1, 0));
    for (let x = 6; x < 10; x++) expect(depthAt(r, x, 0)).toBeLessThan(depthAt(r, x - 1, 0));
  });

  it('repeats identically for every lenticule', () => {
    const r = renderLenticular([RED, BLUE], settings());
    for (let x = 0; x < 10; x++) expect(depthAt(r, x + 30, 0)).toBe(depthAt(r, x, 0));
  });

  it('scales 65535 to the full stack and never dips below the flat base', () => {
    const s = settings({ lpi: 45, ppi: 1440, heightMm: 0.9, ri: 1.5 });
    const g = lensGeometry(s);
    const r = renderLenticular([RED, BLUE], s);
    expect(r.depthScaleMm).toBeCloseTo(g.totalMm, 9);
    expect(maxOf(r.depth)).toBeGreaterThan(65000); // apex reaches the top

    // The trough of a lenticule is the flat base — the sample sits half a pixel
    // in from the true edge, so it lands just above it, never below.
    const baseRatio = g.baseMm / g.totalMm;
    const pitchPx = Math.round(g.pitchPx);
    const row = [...r.depth.slice(0, pitchPx)].map((v) => v / 65535);
    const trough = Math.min(...row);
    expect(trough).toBeGreaterThanOrEqual(baseRatio);
    expect(trough).toBeLessThan(baseRatio + 0.05);
  });

  it('follows the orientation along with the interlace', () => {
    const r = renderLenticular([RED, BLUE], settings({ orientationDeg: 90 }));
    expect(depthAt(r, 0, 0)).toBe(depthAt(r, 63, 0));
    expect(depthAt(r, 0, 5)).toBeGreaterThan(depthAt(r, 0, 0));
  });

  it('previews as an 8-bit greyscale image of the same size', () => {
    const r = renderLenticular([RED, BLUE], settings());
    const preview = depthPreview(r);
    expect(preview.width).toBe(r.width);
    expect(preview.height).toBe(r.height);
    const i = (0 * r.width + 5) * 4;
    expect(preview.data[i]).toBe(r.depth[5] >>> 8);
    expect(preview.data[i]).toBe(preview.data[i + 1]);
    expect(preview.data[i + 3]).toBe(255);
  });
});

describe('calibration sheets', () => {
  it('spreads band values evenly from min to max', () => {
    expect(calibrationValues({ param: 'lpi', min: 40, max: 50, bands: 6 })).toEqual([40, 42, 44, 46, 48, 50]);
  });

  it('tolerates a reversed range and a degenerate band count', () => {
    expect(calibrationValues({ param: 'ri', min: 1.6, max: 1.4, bands: 3 })).toEqual([1.4, 1.5, 1.6]);
    expect(calibrationValues({ param: 'ri', min: 1, max: 2, bands: 1 })).toEqual([1, 2]);
  });

  it('overrides exactly one setting per band', () => {
    const base = settings();
    expect(withCalibrationValue(base, 'height', 1.2)).toEqual({ ...base, heightMm: 1.2 });
    expect(withCalibrationValue(base, 'ri', 1.7)).toEqual({ ...base, ri: 1.7 });
    expect(withCalibrationValue(base, 'lpi', 60)).toEqual({ ...base, lpi: 60 });
  });

  it('renders one band per value, each with its own geometry', () => {
    const r = renderLenticular([RED, BLUE], settings(), {
      calibration: { param: 'lpi', min: 10, max: 20, bands: 2 },
    });
    expect(r.bands).toHaveLength(2);
    expect(r.bands[0].value).toBe(10);
    expect(r.bands[1].value).toBe(20);
    expect(r.bands[1].geometry.pitchPx).toBeCloseTo(5, 9);
  });

  it('varies the printed lens between bands', () => {
    const r = renderLenticular([RED, BLUE], settings(), {
      calibration: { param: 'lpi', min: 10, max: 20, bands: 2 },
    });
    // Band 0 (top half) has 10 px lenticules, band 1 (bottom half) has 5 px:
    // the peak of band 1's second lenticule lands where band 0 has a trough.
    const topEdge = depthAt(r, 0, 5);
    const bottomEdge = depthAt(r, 0, r.height - 5);
    expect(depthAt(r, 5, 5)).toBeGreaterThan(topEdge);
    expect(depthAt(r, 5, r.height - 5)).toBeCloseTo(bottomEdge, -2);
  });

  it('normalises every band against the tallest stack on the sheet', () => {
    const r = renderLenticular([RED, BLUE], settings({ heightMm: 1 }), {
      calibration: { param: 'height', min: 1, max: 3, bands: 2 },
    });
    expect(r.depthScaleMm).toBeCloseTo(3, 6);
    // The shorter band must not reach full white — that comparability is the
    // whole point of a height calibration sheet.
    const shortBandPeak = maxOf(r.depth.slice(0, r.width * 20));
    expect(shortBandPeak).toBeLessThan(65535 * 0.45);
  });

  it('leaves a blank gutter between bands', () => {
    const r = renderLenticular([RED, BLUE], settings(), {
      calibration: { param: 'lpi', min: 10, max: 20, bands: 2 },
      bandGapPx: 3,
    });
    expect(depthAt(r, 5, 0)).toBe(0);
    expect(pixelAt(r.interlaced, 5, 0)).toEqual([255, 255, 255]);
    expect(depthAt(r, 5, 4)).toBeGreaterThan(0);
  });
});

describe('describeGeometry', () => {
  const size = { width: 5669, height: 4252 };

  it('summarises pitch, sag, base and viewing angle', () => {
    const s = settings({ lpi: 45, ppi: 1440, heightMm: 0.9 });
    const text = describeGeometry(s, lensGeometry(s), 2, size);
    expect(text).toContain('2 frames');
    expect(text).toContain('5669×4252 px @ 1440 PPI');
    expect(text).toContain('16.00 px per frame strip');
    expect(text).not.toContain('⚠');
  });

  it('warns when the lens cannot focus in the given height', () => {
    const s = settings({ lpi: 45, ppi: 1440, heightMm: 0.4 });
    expect(describeGeometry(s, lensGeometry(s), 2, size)).toContain('cannot focus');
  });

  it('warns when a frame strip is too thin to print', () => {
    const s = settings({ lpi: 100, ppi: 300 });
    expect(describeGeometry(s, lensGeometry(s), 4, size)).toContain('per frame strip — raise PPI');
  });
});
