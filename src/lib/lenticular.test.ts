import { describe, it, expect } from 'vitest';
import { createImage } from './image';
import {
  MAX_OUTPUT_PIXELS,
  MAX_OVERSIZE_PIXELS,
  OversizeOutputError,
  alignedInterlaceWidth,
  calibrationPixelsPerLens,
  calibrationValues,
  chunkCount,
  chunkRows,
  depthMapChunks,
  drainSync,
  interlaceChunks,
  lenticularChunks,
  depthPreview,
  describeGeometry,
  heightForViewAngle,
  interlacedSize,
  lensGeometry,
  outputSize,
  pixelsPerLens,
  lpiForPixelsPerLens,
  pplFit,
  snapPixelsPerLens,
  renderDepthMap,
  renderInterlaced,
  renderLenticular,
  switchFrames,
  withCalibrationValue,
  type CalibrationParam,
  type ChunkProgress,
  type CalibrationSpec,
  type LenticularSettings,
  type RenderOptions,
} from './lenticular';
import type { RasterImage } from '../types';

/** Small, fast test settings: a 100 px depth raster, 10 px per lenticule. */
const settings = (over: Partial<LenticularSettings> = {}): LenticularSettings => ({
  widthMm: 25.4,
  ppi: 100,
  lpi: 10,
  phase: 0,
  heightMm: 5,
  ri: 1.5,
  orientationDeg: 0,
  stripSamples: 2,
  ...over,
});

const solid = (color: [number, number, number], w = 20, h = 20): RasterImage =>
  createImage(w, h, [...color, 255]);

const RED = solid([255, 0, 0]);
const BLUE = solid([0, 0, 255]);
const GREEN = solid([0, 255, 0]);

/**
 * The artwork sizes itself now, so the interlace tests pin it to the same
 * 100×100 raster as the depth map: 10 px per lenticule, whatever the frame
 * count. {@link interlacedSize} is covered on its own below.
 */
const ART = { width: 100, height: 100 };
const renderAt = (frames: RasterImage[], s: LenticularSettings, options: RenderOptions = {}) =>
  renderLenticular(frames, s, { interlacedSize: ART, ...options });

const pixelAt = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};
const depthAt = (r: { depth: Uint16Array; depthWidth: number }, x: number, y: number) =>
  r.depth[y * r.depthWidth + x];
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

describe('interlacedSize', () => {
  // 25.4 mm at 10 LPI = 10 lenticules, so the interlace floor is
  // 10 × frames × stripSamples pixels wide.
  it('takes the interlace floor when the artwork is small', () => {
    expect(interlacedSize(settings(), [RED, BLUE])).toEqual({ width: 40, height: 40 });
    expect(interlacedSize(settings({ stripSamples: 4 }), [RED, BLUE]).width).toBe(80);
    expect(interlacedSize(settings(), [RED, GREEN, BLUE]).width).toBe(60);
  });

  it('keeps the highest-resolution frame instead of downsampling it', () => {
    const big = solid([1, 2, 3], 900, 900);
    // 25.4 mm at 1000 PPI is a 1000 px sheet, so the 900 px source fits under
    // the cap and is kept whole.
    expect(interlacedSize(settings({ ppi: 1000 }), [RED, big]).width).toBe(900);
    // …but never drops below the interlace floor for it: 500 lenticules × 2
    // frames × 2 samples outvotes the 900 px source.
    expect(interlacedSize(settings({ ppi: 5000, lpi: 500 }), [RED, big]).width).toBe(2000);
  });

  it('never asks for more pixels than the press can place', () => {
    const big = solid([1, 2, 3], 900, 900);
    // The same 900 px source on a 100 px sheet: everything past the printer's
    // own raster would be resampled away on the way to the paper.
    expect(interlacedSize(settings(), [RED, big]).width).toBe(100);
    // The interlace floor is capped too — 500 LPI × 2 frames × 2 samples wants
    // 2000 px, which a 100 PPI press cannot print. (That is the same condition
    // as "too many frames for one lenticule", which the node warns about.)
    expect(interlacedSize(settings({ lpi: 500 }), [RED, BLUE]).width).toBe(100);
    // Raise the press and the cap rises with it.
    expect(interlacedSize(settings({ ppi: 2000 }), [RED, big]).width).toBe(900);
  });

  it('takes its aspect ratio from the first frame only', () => {
    const wide = solid([0, 0, 0], 400, 100);
    const s = settings({ ppi: 1000 }); // room under the cap for a 400 px source
    expect(interlacedSize(s, [wide, RED])).toEqual({ width: 400, height: 100 });
    expect(interlacedSize(s, [RED, wide])).toEqual({ width: 400, height: 400 });
  });

  it('ignores PPI while the strips run along the pixels', () => {
    const a = interlacedSize(settings({ ppi: 300 }), [RED, BLUE]);
    const b = interlacedSize(settings({ ppi: 5000 }), [RED, BLUE]);
    expect(a).toEqual(b);
    expect(outputSize(settings({ ppi: 300 }), RED)).not.toEqual(outputSize(settings({ ppi: 5000 }), RED));
    // 90° turns the strips through a right angle, which is still along them.
    expect(interlacedSize(settings({ orientationDeg: 90 }), [RED, BLUE])).toEqual(a);
    expect(interlacedSize(settings({ orientationDeg: -180 }), [RED, BLUE])).toEqual(a);
  });

  it('leaves diagonal strip edges on the small raster rather than jumping to PPI', () => {
    // Off the axes a strip edge falls between pixels, and more pixels are the
    // only cure — but they are offered, not imposed: a 9× bigger artwork for a
    // finer staircase is the user's call, made by raising the samples.
    const s = settings({ orientationDeg: 23, ppi: 300 });
    expect(interlacedSize(s, [RED, BLUE]).width).toBe(40);
    expect(interlacedSize({ ...s, stripSamples: 8 }, [RED, BLUE]).width).toBe(160);
    // …and spending past the press is what the cap stops: at 40 samples the
    // interlace floor asks for 800 px on a 300 px sheet.
    expect(interlacedSize({ ...s, stripSamples: 40 }, [RED, BLUE]).width).toBe(300);
  });

  it('is what renderLenticular actually rasters the artwork at', () => {
    const s = settings({ ppi: 1440 });
    const r = renderLenticular([RED, BLUE], s);
    expect({ width: r.interlaced.width, height: r.interlaced.height }).toEqual(
      interlacedSize(s, [RED, BLUE]),
    );
    // The depth map keeps the printer's raster, far larger than the artwork.
    expect({ width: r.depthWidth, height: r.depthHeight }).toEqual(outputSize(s, RED));
    expect(r.depthWidth).toBeGreaterThan(r.interlaced.width * 10);
  });

  it('renders the same interlace whatever raster it lands on', () => {
    const s = settings();
    const small = renderInterlaced([RED, BLUE], s); // 40 px, 2 px per strip
    const large = renderInterlaced([RED, BLUE], s, { interlacedSize: ART }); // 100 px
    // Same physical strips, so the same colour at the same fraction across.
    for (const f of [0.05, 0.2, 0.35, 0.55, 0.7, 0.95]) {
      expect(pixelAt(small, Math.floor(f * small.width), 0)).toEqual(
        pixelAt(large, Math.floor(f * large.width), 0),
      );
    }
  });
});

describe('renderLenticular — interlacing', () => {
  it('gives each frame an equal slice of every lenticule', () => {
    const r = renderAt([RED, BLUE], settings());
    expect(r.interlaced.width).toBe(100);
    // 10 px per lenticule, 2 frames → 5 px each, repeating.
    for (let x = 0; x < 5; x++) expect(pixelAt(r.interlaced, x, 0)).toEqual([255, 0, 0]);
    for (let x = 5; x < 10; x++) expect(pixelAt(r.interlaced, x, 0)).toEqual([0, 0, 255]);
    expect(pixelAt(r.interlaced, 10, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(r.interlaced, 95, 0)).toEqual([0, 0, 255]);
  });

  it('splits three frames across the lenticule', () => {
    const r = renderAt([RED, GREEN, BLUE], settings());
    expect(pixelAt(r.interlaced, 0, 0)).toEqual([255, 0, 0]);
    expect(pixelAt(r.interlaced, 4, 0)).toEqual([0, 255, 0]);
    expect(pixelAt(r.interlaced, 8, 0)).toEqual([0, 0, 255]);
  });

  it('phase shifts the strips within the lenticule', () => {
    const r = renderAt([RED, BLUE], settings({ phase: 0.5 }));
    expect(pixelAt(r.interlaced, 0, 0)).toEqual([0, 0, 255]);
    expect(pixelAt(r.interlaced, 5, 0)).toEqual([255, 0, 0]);
  });

  it('wraps a phase outside 0–1 instead of drifting', () => {
    const a = renderAt([RED, BLUE], settings({ phase: 0.25 }));
    const b = renderAt([RED, BLUE], settings({ phase: 2.25 }));
    expect(b.interlaced.data).toEqual(a.interlaced.data);
  });

  it('runs the strips along y when the orientation is 90°', () => {
    const r = renderAt([RED, BLUE], settings({ orientationDeg: 90 }));
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
    const r = renderAt([ramp, ramp], settings());
    const first = pixelAt(r.interlaced, 0, 0)[0];
    for (let x = 1; x < 10; x++) expect(pixelAt(r.interlaced, x, 0)[0]).toBe(first);
    // …and the next lenticule steps to a new value.
    expect(pixelAt(r.interlaced, 10, 0)[0]).toBeGreaterThan(first);
  });

  it('refuses fewer than two frames', () => {
    expect(() => renderLenticular([RED], settings())).toThrow(/at least 2 images/);
    expect(() => renderLenticular([], settings())).toThrow(/at least 2 images/);
    // …and each half refuses on its own terms, so a direct call can't slip past.
    expect(() => renderInterlaced([RED], settings())).toThrow(/at least 2 images/);
    expect(() => renderDepthMap([RED], settings())).toThrow(/at least 2 images/);
  });

  it('stops above the pixel budget and asks, before rendering anything', () => {
    // 254 mm at 1440 PPI on a square frame is 14400², over 200 MP: big enough
    // to be worth a question, small enough to be worth answering yes to.
    const big = settings({ widthMm: 254, ppi: 1440 });
    expect(() => renderLenticular([RED, BLUE], big)).toThrow(
      /Depth map would be .* Reduce Width \(mm\) or PPI/s,
    );
    // …and an artwork too big in its own right is caught on its own terms.
    expect(() => renderLenticular([RED, BLUE], settings({ widthMm: 5000, lpi: 2000 }))).toThrow(
      /Interlaced artwork would be/,
    );
    expect(MAX_OUTPUT_PIXELS).toBeGreaterThan(30_000_000);
  });

  it('throws something the caller can put to the user, not just a string', () => {
    let thrown: unknown;
    try {
      renderLenticular([RED, BLUE], settings({ widthMm: 254, ppi: 1440 }));
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(OversizeOutputError);
    const err = thrown as OversizeOutputError;
    expect(err.what).toBe('Depth map');
    expect(err.pixels).toBe(err.width * err.height);
    expect(err.pixels).toBeGreaterThan(MAX_OUTPUT_PIXELS);
    expect(err.pixels).toBeLessThan(MAX_OVERSIZE_PIXELS);
    // The number the prompt offers: how many chunks the work splits into.
    expect(err.chunks).toBe(chunkCount(err.width, err.height));
    expect(err.chunks).toBeGreaterThan(1);
    expect(err.fix).toMatch(/Reduce Width/);
    expect(err.message).toMatch(/run it anyway, in \d+ chunks/);
  });

  it('goes ahead once the caller says the user agreed', () => {
    // Same sheet, consent given: no longer refused. Pulling the first chunk is
    // enough to prove the budget let it through — this test has no interest in
    // waiting for the other 200 MP.
    const gen = depthMapChunks([RED, BLUE], settings({ widthMm: 254, ppi: 1440 }), {
      allowOversize: true,
    });
    expect(() => gen.next()).not.toThrow();
    gen.return(undefined as never);
  });

  it('refuses outright past what a browser can hold, consent or not', () => {
    const huge = settings({ widthMm: 50_000, ppi: 1440 });
    expect(() => renderDepthMap([RED, BLUE], huge, { allowOversize: true })).toThrow(
      /past what a browser can hold at all/,
    );
    // Not an OversizeOutputError: there is nothing to consent to.
    expect(() => renderDepthMap([RED, BLUE], huge, { allowOversize: true })).not.toThrow(OversizeOutputError);
    expect(MAX_OVERSIZE_PIXELS).toBeGreaterThan(MAX_OUTPUT_PIXELS);
  });
});

describe('chunked rendering', () => {
  // The real chunk is 4 MP; these tests set a tiny one so the same code path
  // splits a 100×100 render into bands, and the suite stays a suite.
  const chunked: RenderOptions = { chunkPixels: 3000 };

  const drain = <T>(gen: Generator<ChunkProgress, T>) => {
    const seen: ChunkProgress[] = [];
    let step = gen.next();
    while (!step.done) {
      seen.push(step.value);
      step = gen.next();
    }
    return { seen, value: step.value };
  };

  it('splits a pass into whole bands of rows', () => {
    expect(chunkRows(1000)).toBe(4000); // 4 MP a chunk at the default
    expect(chunkCount(1000, 4000)).toBe(1);
    expect(chunkCount(1000, 4001)).toBe(2);
    expect(chunkCount(1000, 12_000)).toBe(3);
    // Never zero rows, however wide the raster.
    expect(chunkRows(10_000_000)).toBe(1);
    // 30 rows a chunk at 100 px wide, so a 100-row raster takes four.
    expect(chunkCount(100, 100, 3000)).toBe(4);
  });

  it('reports every chunk, in order, and ends on the last one', () => {
    const s = settings();
    const { seen, value } = drain(depthMapChunks([RED, BLUE], s, chunked));
    expect(seen).toHaveLength(chunkCount(100, 100, 3000));
    expect(seen.map((p) => p.done)).toEqual(seen.map((_, i) => i + 1));
    expect(new Set(seen.map((p) => p.total))).toEqual(new Set([seen.length]));
    expect(seen[0].what).toBe('Depth map');
    // …and the raster it returns is the one the plain call gives.
    expect(value.depth).toEqual(renderDepthMap([RED, BLUE], s).depth);
  });

  it('counts both halves of a whole print as one job', () => {
    const { seen } = drain(lenticularChunks([RED, BLUE], settings(), chunked));
    // One total across the run, counting up without resetting at the handover
    // from artwork to depth map.
    expect(new Set(seen.map((p) => p.total)).size).toBe(1);
    expect(seen.map((p) => p.done)).toEqual(seen.map((_, i) => i + 1));
    expect(seen[seen.length - 1].done).toBe(seen[0].total);
    expect(new Set(seen.map((p) => p.what))).toEqual(new Set(['Interlaced artwork', 'Depth map']));
  });

  it('gives the same pixels chunked as in one pass', () => {
    const s = settings();
    expect(drainSync(interlaceChunks([RED, BLUE], s, chunked)).data).toEqual(
      renderInterlaced([RED, BLUE], s).data,
    );
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
    expect(preview.width).toBe(r.depthWidth);
    expect(preview.height).toBe(r.depthHeight);
    const i = (0 * r.depthWidth + 5) * 4;
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
    const spec = (param: CalibrationParam): CalibrationSpec => ({ param, min: 0, max: 1, bands: 2 });
    expect(withCalibrationValue(base, spec('height'), 1.2)).toEqual({ ...base, heightMm: 1.2 });
    expect(withCalibrationValue(base, spec('ri'), 1.7)).toEqual({ ...base, ri: 1.7 });
    expect(withCalibrationValue(base, spec('lpi'), 60)).toEqual({ ...base, lpi: 60 });
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
    const bottomEdge = depthAt(r, 0, r.depthHeight - 5);
    expect(depthAt(r, 5, 5)).toBeGreaterThan(topEdge);
    expect(depthAt(r, 5, r.depthHeight - 5)).toBeCloseTo(bottomEdge, -2);
  });

  it('normalises every band against the tallest stack on the sheet', () => {
    const r = renderLenticular([RED, BLUE], settings({ heightMm: 1 }), {
      calibration: { param: 'height', min: 1, max: 3, bands: 2 },
    });
    expect(r.depthScaleMm).toBeCloseTo(3, 6);
    // The shorter band must not reach full white — that comparability is the
    // whole point of a height calibration sheet.
    const shortBandPeak = maxOf(r.depth.slice(0, r.depthWidth * 20));
    expect(shortBandPeak).toBeLessThan(65535 * 0.45);
  });

  it('leaves a blank gutter between bands, in millimetres on both rasters', () => {
    // 1 mm of gutter on a 25.4 mm sheet: just under 4 px of the 100 px rasters.
    const r = renderAt([RED, BLUE], settings(), {
      calibration: { param: 'lpi', min: 10, max: 20, bands: 2 },
      bandGapMm: 1,
    });
    expect(depthAt(r, 5, 0)).toBe(0);
    expect(pixelAt(r.interlaced, 5, 0)).toEqual([255, 255, 255]);
    expect(depthAt(r, 5, 4)).toBeGreaterThan(0);
    expect(pixelAt(r.interlaced, 5, 4)).not.toEqual([255, 255, 255]);
  });
});

describe('auto height for an LPI sweep', () => {
  it('solves the height that hits a requested viewing angle', () => {
    const s = settings({ lpi: 45, heightMm: 0.9, ri: 1.5 });
    const g = lensGeometry(s);
    // Round-trip: feed the angle back in and the height comes out again.
    expect(heightForViewAngle(g.pitchMm, s.ri, g.viewAngleDeg)).toBeCloseTo(0.9, 9);
  });

  it('scales the height linearly with pitch, since only the ratio sets the angle', () => {
    const angle = 50;
    const coarse = heightForViewAngle(1, 1.5, angle);
    expect(heightForViewAngle(0.5, 1.5, angle)).toBeCloseTo(coarse / 2, 9);
  });

  it('gives every band of an LPI sweep the same viewing angle', () => {
    const base = settings({ lpi: 45, heightMm: 0.9, ri: 1.5 });
    const target = lensGeometry(base).viewAngleDeg;
    const spec: CalibrationSpec = { param: 'lpi', min: 20, max: 80, bands: 5, autoHeight: true };
    for (const value of calibrationValues(spec)) {
      const band = lensGeometry(withCalibrationValue(base, spec, value));
      expect(band.viewAngleDeg).toBeCloseTo(target, 6);
      expect(band.feasible).toBe(true); // an angle reachable at one LPI is reachable at all
    }
  });

  it('keeps a coarse band focusing, where a fixed height would break it', () => {
    const base = settings({ lpi: 45, heightMm: 0.9, ri: 1.5 });
    const fixed: CalibrationSpec = { param: 'lpi', min: 20, max: 80, bands: 2 };
    const auto: CalibrationSpec = { ...fixed, autoHeight: true };
    // 20 LPI is a 1.27 mm pitch: 0.9 mm of gloss cannot focus it.
    expect(lensGeometry(withCalibrationValue(base, fixed, 20)).feasible).toBe(false);
    expect(lensGeometry(withCalibrationValue(base, auto, 20)).feasible).toBe(true);
  });

  it('leaves height and RI sweeps alone', () => {
    const base = settings();
    const spec = (param: CalibrationParam): CalibrationSpec => ({
      param,
      min: 0,
      max: 1,
      bands: 2,
      autoHeight: true,
    });
    expect(withCalibrationValue(base, spec('height'), 1.2).heightMm).toBe(1.2);
    expect(withCalibrationValue(base, spec('ri'), 1.7)).toEqual({ ...base, ri: 1.7 });
  });

  it('darkens the finer-pitch bands, which need a shorter stack', () => {
    const s = settings({ lpi: 10, heightMm: 5 });
    const r = renderLenticular([RED, BLUE], s, {
      calibration: { param: 'lpi', min: 10, max: 20, bands: 2, autoHeight: true },
    });
    // Coarse band keeps the settings' own height and sets the scale…
    expect(r.depthScaleMm).toBeCloseTo(5, 6);
    expect(maxOf(r.depth.slice(0, r.depthWidth * 40))).toBeGreaterThan(65000);
    // …the 20 LPI band needs half the stack for the same cone, so it tops out
    // at half the depth value.
    const fineBandPeak = maxOf(r.depth.slice(r.depthWidth * 60));
    expect(fineBandPeak / 65535).toBeCloseTo(0.5, 2);
  });
});

describe('switchFrames', () => {
  it('is white then black for two frames', () => {
    const frames = switchFrames(2);
    expect(frames).toHaveLength(2);
    expect([...frames[0].data]).toEqual([255, 255, 255, 255]);
    expect([...frames[1].data]).toEqual([0, 0, 0, 255]);
  });

  it('alternates black and white rather than ramping through grey', () => {
    // The fastest switch the view count allows, so any crosstalk between
    // neighbouring views shows up as a grey that was never printed. A ramp
    // would ask the lens to resolve a gradient — which is what a lens that has
    // failed produces anyway, so the working and broken bands would look alike.
    expect(switchFrames(3).map((f) => f.data[0])).toEqual([255, 0, 255]);
    expect(switchFrames(5).map((f) => f.data[0])).toEqual([255, 0, 255, 0, 255]);
    expect(switchFrames(8).map((f) => f.data[0])).toEqual([255, 0, 255, 0, 255, 0, 255, 0]);
  });

  it('is pure black and white, with nothing in between', () => {
    for (const n of [2, 3, 7, 12]) {
      for (const frame of switchFrames(n)) {
        expect([0, 255]).toContain(frame.data[0]);
      }
    }
  });

  it('never returns fewer than two frames', () => {
    expect(switchFrames(1)).toHaveLength(2);
    expect(switchFrames(0)).toHaveLength(2);
  });

  it('interlaces into a hard black/white switch on the artwork raster', () => {
    const s = settings();
    // The 1×1 switch frames carry no aspect of their own, so the artwork's
    // raster is handed in — that is what makes the two sheets overlay.
    const artwork = createImage(400, 100, [12, 34, 56, 255]);
    const size = interlacedSize(settings({ ppi: 1000 }), [artwork, artwork]);
    const img = renderInterlaced(switchFrames(2), s, { interlacedSize: size });
    expect(img.width).toBe(size.width);
    expect(img.height).toBe(size.height);
    // Each lenticule is half white, half black. 400 px over 10 lenticules.
    for (let x = 0; x < 20; x++) expect(pixelAt(img, x, 0)).toEqual([255, 255, 255]);
    for (let x = 20; x < 40; x++) expect(pixelAt(img, x, 0)).toEqual([0, 0, 0]);
  });
});

describe('describeGeometry', () => {
  const depth = { width: 5669, height: 4252 };
  const art = { width: 1418, height: 1063 };

  it('reports both rasters, and the pitch on each', () => {
    const s = settings({ widthMm: 100, lpi: 45, ppi: 1440, heightMm: 0.9 });
    const text = describeGeometry(s, lensGeometry(s), 2, depth, art);
    expect(text).toContain('2 frames');
    expect(text).toContain('Depth map 5669×4252 px @ 1440 PPI');
    expect(text).toContain('artwork 1418×1063 px');
    expect(text).toContain('32.00 px of lens profile'); // 1440 / 45
    expect(text).toContain('4.00 px per frame strip'); // 1418 px / 177 lenticules / 2
    expect(text).not.toContain('⚠');
  });

  it('warns when the lens cannot focus in the given height', () => {
    const s = settings({ lpi: 45, ppi: 1440, heightMm: 0.4 });
    expect(describeGeometry(s, lensGeometry(s), 2, depth, art)).toContain('cannot focus');
  });

  it('warns when the printer raster is too coarse to shape the lens', () => {
    const s = settings({ lpi: 100, ppi: 300 }); // 3 px per lenticule
    expect(describeGeometry(s, lensGeometry(s), 4, depth, art)).toContain(
      'the printed lens will be terraced',
    );
  });
});

describe('pitch as pixels per lens', () => {
  const at = (ppi: number, lpi: number, widthMm = 100) => ({ ppi, lpi, widthMm });

  it('is PPI over LPI, and inverts exactly', () => {
    // The pairing every lenticular tutorial uses, and the reason 1440/45 is the
    // default in this tool: it is a whole 32 px per lens.
    expect(pixelsPerLens(at(1440, 45))).toBe(32);
    expect(lpiForPixelsPerLens(1440, 32)).toBe(45);
    // Round-trips at values that do not divide, too.
    expect(pixelsPerLens({ ppi: 1440, lpi: lpiForPixelsPerLens(1440, 28.8) })).toBeCloseTo(28.8, 9);
  });

  it('spots a pitch that does not land on the pixel grid', () => {
    const good = pplFit(at(1440, 45));
    expect(good.whole).toBe(true);
    expect(good.parity).toBe('even');
    expect(good.driftPx).toBe(0);

    // 50 LPI at 1440 PPI is 28.8 px: four fifths of a pixel adrift per lens.
    const bad = pplFit(at(1440, 50));
    expect(bad.whole).toBe(false);
    expect(bad.parity).toBeNull();
    // ~197 lenses across 100 mm, each 0.2 px off — the pattern slides right
    // across the sheet, which is the banding the editor warns about.
    expect(bad.lensCount).toBeCloseTo(196.85, 1);
    expect(bad.driftPx).toBeCloseTo(39.4, 1);
  });

  it('reads the parity, which is where the lens axis falls', () => {
    expect(pplFit(at(1440, 45)).parity).toBe('even'); // 32
    expect(pplFit(at(1440, 480)).parity).toBe('odd'); // 3
  });

  it('says whether the views divide the lens evenly', () => {
    // 32 px over 8 views is 4 px each, exactly.
    expect(pplFit(at(1440, 45), 8).pxPerView).toBe(4);
    // Over 12 it is 2.67, so the strips under one lens are not all alike.
    expect(pplFit(at(1440, 45), 12).pxPerView).toBeNull();
    expect(pplFit(at(1440, 45), 0).pxPerView).toBeNull();
  });

  it('snaps to the nearest whole pitch, or the nearest of a parity', () => {
    expect(snapPixelsPerLens(28.8)).toBe(29);
    expect(snapPixelsPerLens(28.8, 'even')).toBe(28);
    expect(snapPixelsPerLens(28.8, 'odd')).toBe(29);
    expect(snapPixelsPerLens(31.4, 'even')).toBe(32);
    expect(snapPixelsPerLens(31.4, 'odd')).toBe(31);
    // Already there: snapping is idempotent.
    expect(snapPixelsPerLens(32, 'even')).toBe(32);
    expect(snapPixelsPerLens(33, 'odd')).toBe(33);
  });

  it('never snaps below a pitch that could show two views', () => {
    // Under 2 px a lenticule cannot carry a flip at all.
    expect(snapPixelsPerLens(0.4)).toBe(2);
    expect(snapPixelsPerLens(1, 'even')).toBe(2);
    expect(snapPixelsPerLens(0.1, 'odd')).toBe(3);
  });

  it('agrees with the geometry the lens is actually solved from', () => {
    // pitchPx and pixelsPerLens must not drift apart — they are the same
    // quantity, and the editor shows both.
    const settings: LenticularSettings = {
      widthMm: 100,
      ppi: 1200,
      lpi: 40,
      phase: 0,
      heightMm: 0.9,
      ri: 1.5,
      orientationDeg: 0,
      stripSamples: 2,
    };
    expect(lensGeometry(settings).pitchPx).toBe(pixelsPerLens(settings));
  });
});

describe('snapping an LPI sweep to whole pixels per lens', () => {
  const spec = (over: Partial<CalibrationSpec> = {}): CalibrationSpec => ({
    param: 'lpi',
    min: 40,
    max: 50,
    bands: 9,
    ppi: 1440,
    snapPpl: true,
    ...over,
  });

  it('lands every band on a whole number of pixels', () => {
    for (const lpi of calibrationValues(spec())) {
      const ppl = 1440 / lpi;
      expect(ppl).toBeCloseTo(Math.round(ppl), 9);
    }
  });

  it('sweeps the whole pitches the range actually contains', () => {
    // 40–50 LPI at 1440 PPI is 36 px down to 28.8 px, so the whole pitches in
    // range are 36 … 29 — eight of them, from nine evenly spaced samples.
    expect(calibrationPixelsPerLens(spec()).map(Math.round)).toEqual([36, 35, 34, 33, 32, 31, 30, 29]);
  });

  it('collapses bands that would print the same pitch twice', () => {
    // A narrow range holds few whole pitches however many bands are asked for;
    // printing one of them twice would measure nothing.
    const narrow = calibrationPixelsPerLens(spec({ min: 44, max: 46, bands: 9 }));
    expect(narrow.map(Math.round)).toEqual([33, 32, 31]);
    expect(new Set(narrow).size).toBe(narrow.length);
  });

  it('leaves the sweep alone when snapping is off, or the raster is unknown', () => {
    const raw = calibrationValues(spec({ snapPpl: false }));
    expect(raw).toHaveLength(9);
    expect(raw[0]).toBe(40);
    expect(raw[8]).toBe(50);
    // Without a PPI there is no raster to snap to, so it cannot silently guess.
    expect(calibrationValues(spec({ ppi: undefined }))).toEqual(raw);
  });

  it('only touches the LPI sweep', () => {
    const height = calibrationValues(spec({ param: 'height', min: 0.6, max: 1.4, bands: 5 }));
    expect(height).toHaveLength(5);
    height.forEach((v, i) => expect(v).toBeCloseTo(0.6 + i * 0.2, 9));
    expect(calibrationPixelsPerLens(spec({ param: 'ri' }))).toEqual([]);
  });

  it('reports the pitches a raw sweep lands on too, fractions and all', () => {
    // Same range unsnapped: 36 px at one end, 28.8 at the other — and nothing
    // in between that a raster can repeat.
    const raw = calibrationPixelsPerLens(spec({ snapPpl: false }));
    expect(raw[0]).toBeCloseTo(36, 9);
    expect(raw[8]).toBeCloseTo(28.8, 9);
    expect(raw.filter((v) => Math.abs(v - Math.round(v)) < 1e-9)).toHaveLength(2);
  });

  it('renders a snapped sweep with one band per distinct pitch', () => {
    const s = settings({ ppi: 1440, widthMm: 25.4, lpi: 45 });
    const calibration = spec({ min: 44, max: 46, bands: 9 });
    const r = renderLenticular([RED, BLUE], s, {
      interlacedSize: ART,
      calibration,
    });
    // Three distinct pitches in that range, so three bands on the sheet.
    expect(r.bands).toHaveLength(3);
    expect(r.bands.map((b) => Math.round(1440 / (b.value ?? 0)))).toEqual([33, 32, 31]);
  });
});

describe('every lens switches at once', () => {
  /**
   * Which frame each pixel of one row takes, read straight off the render by
   * matching the flat colour back to the frame that produced it.
   */
  function stripPattern(art: RasterImage, frames: RasterImage[]): number[] {
    const out: number[] = [];
    for (let x = 0; x < art.width; x++) {
      const [r, g, b] = pixelAt(art, x, Math.floor(art.height / 2));
      let best = 0;
      let bestErr = Infinity;
      frames.forEach((f, i) => {
        const err = Math.abs(f.data[0] - r) + Math.abs(f.data[1] - g) + Math.abs(f.data[2] - b);
        if (err < bestErr) {
          bestErr = err;
          best = i;
        }
      });
      out.push(best);
    }
    return out;
  }

  it('gives every lenticule the same whole number of pixels', () => {
    // A source resolution that divides nothing: the raster grows to the next
    // size that does rather than taking it as-is.
    const odd = solid([9, 9, 9], 905, 905);
    const s = settings({ widthMm: 25.4, ppi: 1000, lpi: 10 });
    const size = interlacedSize(s, [RED, odd]);
    const lenticules = (25.4 * 10) / 25.4;
    expect(size.width / lenticules).toBe(Math.round(size.width / lenticules));
    // …and it went up to reach it, never down past what the sources hold.
    expect(size.width).toBeGreaterThanOrEqual(905);
  });

  it('repeats the strip pattern exactly, lens for lens', () => {
    // The property the whole thing is for: lens 0 and lens 7 must divide into
    // frames at the same pixel offsets, or they flip at different angles and
    // the sheet wipes instead of switching.
    const s = settings({ widthMm: 25.4, ppi: 400, lpi: 10, stripSamples: 3 });
    const frames = [RED, GREEN, BLUE];
    const size = interlacedSize(s, frames);
    const art = renderInterlaced(frames, s, { interlacedSize: size });
    const pattern = stripPattern(art, frames);
    const perLens = size.width / 10;
    expect(perLens).toBe(Math.round(perLens));
    const first = pattern.slice(0, perLens);
    for (let lens = 1; lens < 10; lens++) {
      expect(pattern.slice(lens * perLens, (lens + 1) * perLens)).toEqual(first);
    }
  });

  it('gives every frame an equal share of the lens when the press allows', () => {
    const s = settings({ widthMm: 25.4, ppi: 400, lpi: 10, stripSamples: 3 });
    const frames = [RED, GREEN, BLUE];
    const art = renderInterlaced(frames, s, { interlacedSize: interlacedSize(s, frames) });
    const pattern = stripPattern(art, frames);
    const counts = [0, 0, 0];
    for (const frame of pattern) counts[frame]++;
    expect(counts[0]).toBe(counts[1]);
    expect(counts[1]).toBe(counts[2]);
  });

  it('falls back to whole pixels per lens when equal strips would overrun the press', () => {
    // 32 px per lens over 12 views: 2.67 px a strip, and rounding up to 3 would
    // need 36 px — more than the press has. So the strips come out uneven…
    const lenticules = 100;
    const cap = 3200;
    const width = alignedInterlaceWidth(3200, lenticules, 12, cap);
    expect(width).toBeLessThanOrEqual(cap);
    // …but the pitch is still whole, which is what keeps the sheet switching
    // as one.
    expect(width / lenticules).toBe(Math.round(width / lenticules));
    expect(width / lenticules).toBe(32);
  });

  it('grows to the next whole strip, and stops at the press', () => {
    // 1000 px over 100 lenses is 10 px each, which four views cannot share
    // evenly — so it goes up to 12, the next multiple of 4.
    expect(alignedInterlaceWidth(1000, 100, 4, 1200)).toBe(1200);
    // Already exact: left alone.
    expect(alignedInterlaceWidth(1200, 100, 4, 2000)).toBe(1200);
    expect(alignedInterlaceWidth(800, 100, 4, 2000)).toBe(800);
    // A lenticule the press cannot give one pixel to: capped, and left alone.
    expect(alignedInterlaceWidth(2000, 500, 2, 100)).toBe(100);
  });

  it('keeps the switch sheet on the same grid as the artwork it accompanies', () => {
    // The test print has to have the property it is printed to check for.
    const s = settings({ widthMm: 25.4, ppi: 400, lpi: 10, stripSamples: 3 });
    const frames = [RED, GREEN, BLUE];
    const size = interlacedSize(s, frames);
    const sw = switchFrames(frames.length);
    const sheet = renderInterlaced(sw, s, { interlacedSize: size });
    expect([sheet.width, sheet.height]).toEqual([size.width, size.height]);
    const pattern = stripPattern(sheet, sw);
    const perLens = size.width / 10;
    const first = pattern.slice(0, perLens);
    for (let lens = 1; lens < 10; lens++) {
      expect(pattern.slice(lens * perLens, (lens + 1) * perLens)).toEqual(first);
    }
    // And it is the alternating target, so the strips are pure black and white.
    for (let x = 0; x < sheet.width; x++) {
      expect([0, 255]).toContain(pixelAt(sheet, x, 5)[0]);
    }
  });
});
