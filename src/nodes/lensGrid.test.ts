import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { lensGridNode, gridSettingsFromConfig } from './lensGrid';
import {
  lensGridCellInputs,
  lensGridCellSlots,
  lensGridInputs,
  nodePorts,
  summariseMissing,
} from '../engine/ports';
import { packingAlignsRows } from '../lib/lenticular';
import { getNodeDef } from '../engine/registry';
import { EXAMPLES } from '../components/examples';
import { createImage } from '../lib/image';
import {
  describeGridGeometry,
  gridAxisLabel,
  gridCellCounts,
  gridCellLabel,
  gridCells,
  gridInterlacedSize,
  gridSwitchViews,
  lensGeometry,
  outputSize,
  renderGridDepthMap,
  renderGridInterlaced,
  type LensGridSettings,
} from '../lib/lenticular';
import type { ComputeContext, DataValue, RasterImage, SavedGraph } from '../types';

const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

/**
 * Config that renders a fast artwork on a 100 px lens map. `grid` on its own
 * means a square one, as it did when that was the only shape there was; pass
 * `gridY` too for an oblong grid.
 */
const config = (over: Record<string, unknown> = {}) => {
  const grid = 'grid' in over ? over.grid : 2;
  return {
    ...lensGridNode.defaultConfig(),
    grid,
    gridY: grid,
    widthMm: 25.4,
    ppi: 100,
    lpi: 10,
    heightMm: 5,
    ...over,
  };
};

const settings = (over: Partial<LensGridSettings> = {}): LensGridSettings => ({
  ...gridSettingsFromConfig(config()),
  // `grid` alone means a square grid here too.
  ...(over.grid !== undefined && over.gridY === undefined ? { gridY: over.grid } : {}),
  ...over,
});

/** The square-packed lattice, where a cell is one pitch on both axes. */
const square = (over: Partial<LensGridSettings> = {}): LensGridSettings =>
  settings({ packing: 'square', ...over });

const solid = (color: [number, number, number], w = 20, h = 20): RasterImage =>
  createImage(w, h, [...color, 255]);

const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

// Four solid views in port order: Left·Up, Right·Up, Left·Down, Right·Down.
const LU = solid([255, 0, 0]);
const RU = solid([0, 255, 0]);
const LD = solid([0, 0, 255]);
const RD = solid([255, 255, 0]);
const QUAD = [LU, RU, LD, RD];
const fourInputs = { c0r0: LU, c1r0: RU, c0r1: LD, c1r1: RD };

/** Six distinguishable views, in the cell order of a 2 across × 3 down grid. */
const SIX = [
  [255, 0, 0],
  [0, 255, 0],
  [0, 0, 255],
  [255, 255, 0],
  [255, 0, 255],
  [0, 255, 255],
].map((rgb) => solid(rgb as [number, number, number]));

/** The colour a view was made of, for comparing against a sampled pixel. */
const colour = (view: RasterImage) => [view.data[0], view.data[1], view.data[2]];

describe('grid cell naming', () => {
  it('names a 2-wide axis with no centre', () => {
    expect([0, 1].map((i) => gridAxisLabel(i, 2, 'x'))).toEqual(['Left', 'Right']);
    expect([0, 1].map((i) => gridAxisLabel(i, 2, 'y'))).toEqual(['Up', 'Down']);
  });

  it('gives an odd axis a centre', () => {
    expect([0, 1, 2].map((i) => gridAxisLabel(i, 3, 'x'))).toEqual(['Left', 'Centre', 'Right']);
    expect([0, 1, 2].map((i) => gridAxisLabel(i, 3, 'y'))).toEqual(['Up', 'Centre', 'Down']);
  });

  it('reaches for "Far" at 4 and 5 wide, and numbers beyond that', () => {
    expect([0, 1, 2, 3].map((i) => gridAxisLabel(i, 4, 'x'))).toEqual([
      'Far left',
      'Left',
      'Right',
      'Far right',
    ]);
    expect([0, 1, 2, 3, 4].map((i) => gridAxisLabel(i, 5, 'y'))).toEqual([
      'Far up',
      'Up',
      'Centre',
      'Down',
      'Far down',
    ]);
    expect([0, 2, 5].map((i) => gridAxisLabel(i, 6, 'x'))).toEqual(['Left 3', 'Left 1', 'Right 3']);
  });

  it('combines both axes, and calls the middle of an odd grid neutral', () => {
    expect(gridCellLabel(0, 0, 2)).toBe('Left · Up');
    expect(gridCellLabel(1, 1, 2)).toBe('Right · Down');
    expect(gridCellLabel(1, 1, 3)).toBe('Centre (neutral)');
    // A cell centred on one axis is named by the other alone.
    expect(gridCellLabel(1, 0, 3)).toBe('Up');
    expect(gridCellLabel(0, 1, 3)).toBe('Left');
  });

  it('lists cells row-major from the top-left, with stable ids', () => {
    expect(gridCells(2).map((c) => c.id)).toEqual(['c0r0', 'c1r0', 'c0r1', 'c1r1']);
    expect(gridCells(2).map((c) => c.label)).toEqual([
      'Left · Up',
      'Right · Up',
      'Left · Down',
      'Right · Down',
    ]);
    expect(gridCells(3)).toHaveLength(9);
  });

  it('clamps the grid to a printable range', () => {
    expect(gridCells(1)).toHaveLength(4); // floor of 2×2
    expect(gridCells(99)).toHaveLength(225); // ceiling of 15×15
    expect(gridCells(2, 99)).toHaveLength(30); // …on each axis separately
  });

  it('names an oblong grid by each axis’ own count', () => {
    // 2 across has no centre column; 3 down has a centre row, so the middle
    // cells are named by the axis that is off-centre alone.
    expect(gridCells(2, 3).map((c) => c.label)).toEqual([
      'Left · Up',
      'Right · Up',
      'Left',
      'Right',
      'Left · Down',
      'Right · Down',
    ]);
    expect(gridCells(2, 3).map((c) => c.id)).toEqual(['c0r0', 'c1r0', 'c0r1', 'c1r1', 'c0r2', 'c1r2']);
  });

  it('numbers the ranks once a grid is too wide for words', () => {
    // Left/Right and Far left/Far right run out at 5 across; beyond that the
    // distance from head-on is a number, and the middle is still the neutral.
    expect(gridCellLabel(0, 0, 15)).toBe('Left 7 · Up 7');
    expect(gridCellLabel(7, 7, 15)).toBe('Centre (neutral)');
    expect(gridCellLabel(8, 7, 15)).toBe('Right 1');
  });
});

describe('Lens Grid node ports', () => {
  it('derives one input per cell from the config, after the sequence port', () => {
    const ports = nodePorts({ type: 'lensGrid', config: { grid: 3 } }, getNodeDef('lensGrid'));
    expect(ports.inputs).toHaveLength(10); // 9 cells + the whole grid on one wire
    expect(ports.inputs[0]).toMatchObject({ id: 'views', type: 'sequence' });
    expect(ports.inputs.slice(1).every((p) => p.type === 'image')).toBe(true);
    expect(ports.inputs[5].label).toBe('Centre (neutral)');
    expect(ports.outputs.map((p) => p.id)).toEqual(['interlaced', 'depth', 'info']);
  });

  it('follows the grid setting', () => {
    expect(lensGridCellInputs({ grid: 2 })).toHaveLength(4);
    expect(lensGridCellInputs({ grid: 4 })).toHaveLength(16);
    expect(lensGridCellInputs({})).toHaveLength(9); // default 3×3
    expect(lensGridCellInputs({ grid: '2' })).toHaveLength(4); // config values can be strings
    expect(lensGridInputs({ grid: 2 })).toHaveLength(5);
  });

  it('takes the two axes separately, and a lone grid as square', () => {
    expect(lensGridCellInputs({ grid: 2, gridY: 3 })).toHaveLength(6);
    expect(lensGridCellInputs({ grid: 2, gridY: 3 })[2].label).toBe('Left');
    // A graph saved before the grid could be oblong carries no gridY at all,
    // and it meant a square grid — which is what falling back to `grid` gives.
    expect(lensGridCellInputs({ grid: 4 })).toHaveLength(16);
  });

  it('stops offering a port per cell past 4×4, leaving the sequence alone', () => {
    // 25 handles on one node is not a way anyone would wire a print; 225 is not
    // a node at all. The whole set comes down the one wire instead.
    expect(lensGridCellInputs({ grid: 5 })).toHaveLength(0);
    expect(lensGridInputs({ grid: 15 })).toEqual([
      { id: 'views', label: 'All views (sequence)', type: 'sequence' },
    ]);
    // …but every cell still exists, in order, for the sequence to fill.
    expect(lensGridCellSlots({ grid: 15 })).toHaveLength(225);
    expect(lensGridCellSlots({ grid: 15 })[0].label).toBe('Left 7 · Up 7');
    // The limit is the number of handles, so an oblong grid is judged on its
    // cell count: 2×8 is as many wires to drag as 4×4, and 2×15 is thirty.
    expect(lensGridCellInputs({ grid: 2, gridY: 8 })).toHaveLength(16);
    expect(lensGridCellInputs({ grid: 2, gridY: 15 })).toHaveLength(0);
    expect(lensGridCellSlots({ grid: 2, gridY: 15 })).toHaveLength(30);
  });

  it('keeps a missing-view list readable', () => {
    expect(summariseMissing(['a', 'b'])).toBe('a, b');
    expect(summariseMissing(['a', 'b', 'c'], 2)).toBe('a, b … and 1 more');
  });
});

describe('renderGridInterlaced', () => {
  it('splits every cell into a grid of view tiles', () => {
    const s = square();
    const img = renderGridInterlaced(QUAD, s, { interlacedSize: { width: 40, height: 40 } });
    expect(img.width).toBe(40);
    // 4 px per cell, 2 px per tile. Mirrored, so the top-left tile of a cell
    // carries the view seen from the bottom-right.
    expect(px(img, 0, 0)).toEqual([255, 255, 0]); // Right · Down
    expect(px(img, 2, 0)).toEqual([0, 0, 255]); // Left · Down
    expect(px(img, 0, 2)).toEqual([0, 255, 0]); // Right · Up
    expect(px(img, 2, 2)).toEqual([255, 0, 0]); // Left · Up
    // …and the pattern repeats every cell.
    expect(px(img, 4, 4)).toEqual(px(img, 0, 0));
  });

  it('places views un-mirrored when the lens inversion is turned off', () => {
    const img = renderGridInterlaced(QUAD, square({ mirrorViews: false }), {
      interlacedSize: { width: 40, height: 40 },
    });
    expect(px(img, 0, 0)).toEqual([255, 0, 0]); // Left · Up, straight through
    expect(px(img, 2, 2)).toEqual([255, 255, 0]); // Right · Down
  });

  it('shifts the tiles with each axis’ own phase', () => {
    const size = { width: 40, height: 40 };
    const x = renderGridInterlaced(QUAD, square({ phase: 0.5 }), { interlacedSize: size });
    expect(px(x, 0, 0)).toEqual([0, 0, 255]); // stepped one column
    const y = renderGridInterlaced(QUAD, square({ phaseY: 0.5 }), { interlacedSize: size });
    expect(px(y, 0, 0)).toEqual([0, 255, 0]); // stepped one row
  });

  it('offsets alternate rows of tiles when the lenslets pack hexagonally', () => {
    const img = renderGridInterlaced(QUAD, settings(), { interlacedSize: { width: 40, height: 40 } });
    // 4 px pitch, so hex rows are 3.46 px apart and shifted 2 px sideways: the
    // tile pattern of the row below is the row above, moved half a pitch.
    expect(px(img, 0, 0)).toEqual(px(img, 2, 4));
    expect(px(img, 2, 0)).toEqual(px(img, 0, 4));
    // Two rows down is 6.93 px, and the lattice lines up with itself again.
    expect(px(img, 0, 7)).toEqual(px(img, 0, 0));
  });

  it('cuts the cell into its own number of columns and rows', () => {
    // 2 across × 3 down on a 60 px raster: a 6 px cell, so 3 px per tile
    // column and 2 px per tile row. Mirrored, as always.
    const img = renderGridInterlaced(SIX, square({ grid: 2, gridY: 3 }), {
      interlacedSize: { width: 60, height: 60 },
    });
    expect(px(img, 0, 0)).toEqual(colour(SIX[5])); // Right · Down
    expect(px(img, 3, 0)).toEqual(colour(SIX[4])); // Left · Down — one tile across
    expect(px(img, 0, 3)).toEqual(colour(SIX[3])); // Right (centre row)
    expect(px(img, 0, 5)).toEqual(colour(SIX[1])); // Right · Up — the third tile row
    // …and the whole pattern repeats every cell, 6 px on.
    expect(px(img, 6, 6)).toEqual(px(img, 0, 0));
  });

  it('insists on exactly grid² views', () => {
    expect(() => renderGridInterlaced([LU, RU, LD], settings())).toThrow(/2×2 lens grid needs 4 images/);
    expect(() => renderGridDepthMap([LU, RU, LD], settings())).toThrow(/2×2 lens grid needs 4 images/);
    expect(() => renderGridInterlaced([...QUAD, LU], settings())).toThrow(/got 5/);
    expect(() => renderGridInterlaced(QUAD, settings({ grid: 3 }))).toThrow(/3×3 lens grid needs 9/);
  });
});

describe('gridInterlacedSize', () => {
  it('needs grid tiles per cell, not just frames per lenticule', () => {
    // 10 cells across × grid × 2 samples.
    expect(gridInterlacedSize(square(), QUAD).width).toBe(40);
    expect(gridInterlacedSize(square({ grid: 3 }), QUAD).width).toBe(60);
  });

  it('sizes an oblong grid on whichever axis asks for more', () => {
    // The raster keeps the sheet's aspect, so the axis with more views is what
    // sets the width: 2×6 needs the same 10 cells × 6 tiles × 2 samples as 6×2.
    const s = { ppi: 1000 }; // clear of the press cap, so the floor shows
    expect(gridInterlacedSize(square({ ...s, grid: 2, gridY: 6 }), Array(12).fill(LU)).width).toBe(120);
    expect(gridInterlacedSize(square({ ...s, grid: 6, gridY: 2 }), Array(12).fill(LU)).width).toBe(120);
    // …and neither is charged for views it does not have: a 2×2 wants 40.
    expect(gridInterlacedSize(square({ ...s, grid: 2 }), QUAD).width).toBe(40);
  });

  it('adds the hex row spacing back, so a tile keeps its samples down too', () => {
    // 40 ÷ √3/2 = 47 px of floor, then rounded up to a whole number of pixels
    // per cell — 6 across 10 cells, which is 3 per tile column.
    const s = settings({ ppi: 1000 }); // clear of the cap, so the floor shows
    expect(gridInterlacedSize(s, QUAD).width).toBe(60);
    // 70 px of floor at grid 3, rounded up to 9 px per cell: 3 per tile again.
    expect(gridInterlacedSize({ ...s, grid: 3, gridY: 3 }, QUAD).width).toBe(90);
  });

  it('leaves diagonal tile edges on the small raster rather than jumping to PPI', () => {
    // Staggered rows put every tile edge on a diagonal, which more pixels would
    // place better — but that is a choice (raise the samples), not a jump from
    // 60 px to the 100 px lens raster behind the user's back.
    expect(gridInterlacedSize(settings(), QUAD).width).toBe(60);
    // 93 px of floor at four samples, rounded up to 10 px per cell.
    expect(gridInterlacedSize(settings({ stripSamples: 4 }), QUAD).width).toBe(100);
    // A turned square array is just as diagonal, and treated the same way.
    expect(gridInterlacedSize(square({ orientationDeg: 23 }), QUAD).width).toBe(40);
    // …as is one on the axes, where every tile edge already lands on a pixel.
    expect(gridInterlacedSize(square(), QUAD).width).toBe(40);
    expect(gridInterlacedSize(square({ orientationDeg: -90 }), QUAD).width).toBe(40);
  });

  it('caps the artwork at the raster the press can actually print', () => {
    // A grid runs into the ceiling quickly: 10 cells × 6 tiles × 2 samples is
    // 120 px of interlace on a sheet the press prints 100 px wide.
    expect(gridInterlacedSize(square({ grid: 6 }), Array(36).fill(LU)).width).toBe(100);
    // …and a source finer than the press is capped just the same.
    const big = solid([0, 0, 0], 500, 500);
    expect(gridInterlacedSize(square(), [big, RU, LD, RD]).width).toBe(100);
  });

  it('still keeps the highest-resolution view, up to that cap', () => {
    const big = solid([0, 0, 0], 500, 500);
    const s = { ppi: 1000 }; // a 1000 px sheet: room for the 500 px source
    expect(gridInterlacedSize(square(s), [big, RU, LD, RD]).width).toBe(500);
    expect(gridInterlacedSize(settings(s), [big, RU, LD, RD]).width).toBe(500);
  });
});

describe('renderGridDepthMap', () => {
  it('domes each cell, peaking at its centre', () => {
    const map = renderGridDepthMap(QUAD, square());
    const at = (x: number, y: number) => map.depth[y * map.width + x];
    // 10 px per cell on the 100 px lens raster, so the apex is near (5, 5).
    expect(at(5, 5)).toBeGreaterThan(at(2, 5));
    expect(at(5, 5)).toBeGreaterThan(at(5, 2));
    expect(at(5, 5)).toBeGreaterThan(at(2, 2));
    expect(at(5, 5)).toBe(Math.max(...[...map.depth.slice(0, map.width * 10)]));
  });

  it('leaves the cell corners flat at base height', () => {
    const s = square();
    const map = renderGridDepthMap(QUAD, s);
    const at = (x: number, y: number) => map.depth[y * map.width + x];
    // The corner of a cell is outside the inscribed cap: base height exactly,
    // and lower than the edge midpoint, which is still on the cap.
    expect(at(0, 0)).toBeLessThan(at(5, 0));
    expect(at(0, 0)).toBe(at(9, 9));
    const geometry = map.bands[0].geometry;
    expect(at(0, 0) / 65535).toBeCloseTo(geometry.baseMm / map.scaleMm, 4);
  });

  it('repeats identically in both axes', () => {
    const map = renderGridDepthMap(QUAD, square());
    const at = (x: number, y: number) => map.depth[y * map.width + x];
    expect(at(23, 47)).toBe(at(3, 7));
  });

  it('offsets alternate rows of caps and pulls them closer together', () => {
    const hex = renderGridDepthMap(QUAD, settings());
    const sq = renderGridDepthMap(QUAD, square());
    const at = (map: typeof hex, x: number, y: number) => map.depth[y * map.width + x];
    // 10 px pitch, so hex rows are 8.66 px apart: apexes along y ≈ 4, then
    // y ≈ 13 — and half a pitch over, which is what a square array doesn't do.
    expect(at(hex, 5, 4)).toBeGreaterThan(at(hex, 0, 4));
    expect(at(hex, 5, 4)).toBeGreaterThan(at(hex, 5, 9)); // 9 falls between rows
    expect(at(hex, 10, 13)).toBeGreaterThan(at(hex, 5, 13));
    expect(at(sq, 5, 13)).toBeGreaterThan(at(sq, 10, 13));
  });

  it('leaves less of the sheet flat than a square array does', () => {
    const flat = (s: LensGridSettings) => {
      const map = renderGridDepthMap(QUAD, s);
      const base = Math.min(...map.depth);
      return [...map.depth].filter((v) => v === base).length / map.depth.length;
    };
    // The whole point of hex packing: 1 − π/4 = 21.5% of a square array is flat
    // base, against 1 − π/2√3 = 9.3% here. (Measured a little under each, since
    // a 10 px cell can't resolve the very corners.)
    expect(flat(square())).toBeCloseTo(1 - Math.PI / 4, 1);
    expect(flat(settings())).toBeCloseTo(1 - Math.PI / (2 * Math.sqrt(3)), 1);
    expect(flat(settings())).toBeLessThan(flat(square()) * 0.5);
  });
});

describe('gridSwitchViews', () => {
  it('checkerboards the grid so either axis flips it', () => {
    expect(gridSwitchViews(2).map((v) => v.data[0])).toEqual([255, 0, 0, 255]);
  });

  it('keeps the neutral centre view white', () => {
    expect(gridSwitchViews(3)[4].data[0]).toBe(255); // centre of a 3×3
    expect(gridSwitchViews(3)).toHaveLength(9);
  });
});

describe('Lens Grid node', () => {
  it('is manual-run with its own editor', () => {
    expect(lensGridNode.autoRun).toBe(false);
    expect(lensGridNode.customEditor).toBe('lensGrid');
    expect(lensGridNode.defaultConfig().grid).toBe(3);
    expect(lensGridNode.defaultConfig().mirrorViews).toBe(true);
    expect(lensGridNode.defaultConfig().packing).toBe('hex');
  });

  it('interlaces the grid and reports both rasters', async () => {
    const out = await lensGridNode.compute(ctx(fourInputs, config()));
    const interlaced = out.interlaced as RasterImage;
    // The interlace needs 47 px; the lens map is on the printer's own 100.
    expect(interlaced.width).toBe(60); // 6 whole px per cell, 3 per tile column
    expect((out.depth as RasterImage).width).toBe(100);
    if (out.info?.kind === 'text') {
      expect(out.info.text).toContain('2×2 grid = 4 views');
      expect(out.info.text).toContain('Hexagonal lenslet packing — 90.7% of the sheet under a cap');
      expect(out.info.text).toContain('Artwork on the minimal raster: 60 px of the 100 px');
      expect(out.info.text).toContain('staggered view-tile edges');
      // Closer rows, so a hex sheet fits 12 rows of lenslets where it fits 10
      // columns — the packing gain, spent on vertical resolution.
      expect(out.info.text).toContain('Each view resolves to 10×12 px');
    } else throw new Error('expected a text info output');
  });

  it('lines the lenslets up in rows and columns when told to', async () => {
    const out = await lensGridNode.compute(ctx(fourInputs, config({ packing: 'square' })));
    expect((out.interlaced as RasterImage).width).toBe(40);
    if (out.info?.kind === 'text') {
      expect(out.info.text).toContain('Square lenslet packing — 78.5% of the sheet under a cap');
      expect(out.info.text).toContain('Artwork on the minimal raster');
      expect(out.info.text).toContain('Each view resolves to 10×10 px');
    } else throw new Error('expected a text info output');
  });

  it('names the cells that are still unconnected', async () => {
    await expect(lensGridNode.compute(ctx({ c0r0: LU, c1r1: RD }, config()))).rejects.toThrow(
      /Missing: Right · Up, Left · Down/,
    );
  });

  it('prints a big grid off the sequence alone', async () => {
    // 6×6 = 36 views, none of which has a port to wire.
    const frames = Array.from({ length: 36 }, (_, i) => solid([i * 7, 0, 255 - i * 7]));
    const out = await lensGridNode.compute(
      ctx({ views: { kind: 'sequence', frames } }, config({ grid: 6, packing: 'square' })),
    );
    // 10 cells × 6 tiles × 2 px wants 120, which a 100 px press cannot print.
    expect((out.interlaced as RasterImage).width).toBe(100);
    if (out.info?.kind === 'text') expect(out.info.text).toContain('6×6 grid = 36 views');
    else throw new Error('expected a text info output');
  });

  it('says so when the artwork lands at the PPI cap', async () => {
    // A 6×6 hex grid wants 10 cells × 6 tiles × 2 samples ÷ √3/2 = 139 px on a
    // sheet the press prints 100 px wide, so the cap is what decides it.
    const frames = Array.from({ length: 36 }, () => solid([9, 9, 9], 4, 4));
    const out = await lensGridNode.compute(ctx({ views: { kind: 'sequence', frames } }, config({ grid: 6 })));
    expect((out.interlaced as RasterImage).width).toBe(100);
    if (out.info?.kind === 'text') {
      expect(out.info.text).toContain('Artwork at the 100 PPI cap: 100 px is every dot the press can place');
      expect(out.info.text).toContain('within one printed dot');
    } else throw new Error('expected a text info output');
  });

  it('says where the views have to come from when the grid has no cell ports', async () => {
    await expect(lensGridNode.compute(ctx({}, config({ grid: 15 })))).rejects.toThrow(
      /needs all 225 views.*and 219 more\. A grid this big has no per-cell inputs/s,
    );
  });

  it('warns when the view tiles are finer than the print can lay down', async () => {
    // 15 tiles across a lenslet that is only 10 printed dots wide: 0.67 dots
    // each, so nothing switches. At the node's real defaults — 1440 PPI, 45 LPI,
    // 32 dots to a lenslet — the same 15×15 sits just over two dots and passes.
    const frames = Array.from({ length: 225 }, () => solid([10, 20, 30], 4, 4));
    const out = await lensGridNode.compute(
      ctx({ views: { kind: 'sequence', frames } }, config({ grid: 15, packing: 'square' })),
    );
    if (out.info?.kind === 'text') {
      expect(out.info.text).toMatch(/⚠ A view tile lands on only 0\.\d+ printed dots/);
    } else throw new Error('expected a text info output');
  });

  it('passes a 15×15 at the node’s own defaults — which is what caps it there', () => {
    const s = gridSettingsFromConfig({ ...lensGridNode.defaultConfig(), grid: 15, gridY: 15 });
    const view = solid([0, 0, 0], 8, 8);
    const text = describeGridGeometry(
      s,
      lensGeometry(s),
      outputSize(s, view),
      gridInterlacedSize(s, [view]),
      gridCellCounts(s, view),
    );
    expect(text).not.toContain('printed dots');
  });

  it('prints an oblong grid, and says which way round it is', async () => {
    const out = await lensGridNode.compute(
      ctx({ views: { kind: 'sequence', frames: SIX } }, config({ grid: 2, gridY: 3 })),
    );
    expect((out.interlaced as RasterImage).width).toBeGreaterThan(0);
    if (out.info?.kind === 'text') expect(out.info.text).toContain('2×3 grid = 6 views');
    else throw new Error('expected a text info output');
  });

  it('asks for the cells an oblong grid is actually missing', async () => {
    await expect(lensGridNode.compute(ctx({}, config({ grid: 2, gridY: 3 })))).rejects.toThrow(
      /A 2×3 lens grid needs all 6 views/,
    );
  });

  it('reads the grid-only settings out of config', () => {
    const s = gridSettingsFromConfig({ grid: 4, phaseY: 0.25, mirrorViews: false, packing: 'square' });
    expect(s).toMatchObject({ grid: 4, phaseY: 0.25, mirrorViews: false, packing: 'square' });
    // …and inherits the shared print settings.
    expect(s.ppi).toBe(1440);
    expect(gridSettingsFromConfig({}).grid).toBe(3);
    // Each axis is its own setting, and a config with only `grid` — every graph
    // saved before the grid could be oblong — is square.
    expect(gridSettingsFromConfig({ grid: 2, gridY: 5 })).toMatchObject({ grid: 2, gridY: 5 });
    expect(gridSettingsFromConfig({ grid: 4 }).gridY).toBe(4);
    expect(gridSettingsFromConfig({}).gridY).toBe(3);
    // Only an explicit 'square' opts out of hex — including in graphs saved
    // before the setting existed, which carry no `packing` at all.
    expect(gridSettingsFromConfig({}).packing).toBe('hex');
    expect(gridSettingsFromConfig({ packing: 'nonsense' }).packing).toBe('hex');
  });
});

describe('the loading-spinner example', () => {
  const example = EXAMPLES.find((e) => e.name.includes('spinner'))!;
  const graph = example.graph as SavedGraph;

  /** Run the example's source chain the way the auto-run scheduler would. */
  async function runSources(): Promise<Record<string, RasterImage>> {
    const outputs: Record<string, RasterImage> = {};
    const input = (id: string, handle: string) => {
      const e = graph.edges.find((edge) => edge.target === id && edge.targetHandle === handle);
      return e ? outputs[e.source] : undefined;
    };
    for (const id of ['ring', 'sweep', 'ticks', 's0', 'r90', 'r180', 'r270']) {
      const node = graph.nodes.find((n) => n.id === id)!;
      const def = getNodeDef(node.type);
      const inputs =
        node.type === 'combine' ? { a: input(id, 'a'), b: input(id, 'b') } : { in: input(id, 'in') };
      const result = await def.compute(ctx(inputs, node.config));
      outputs[id] = result.out as RasterImage;
    }
    return outputs;
  }

  /** Brightness at `deg` clockwise from 12 o'clock, on the ring itself. */
  const onRing = (img: RasterImage, deg: number) => {
    const r = (img.width / 2) * 0.69; // between the 0.56 and 0.82 radii
    const rad = (deg * Math.PI) / 180;
    const x = Math.round(img.width / 2 + r * Math.sin(rad));
    const y = Math.round(img.height / 2 - r * Math.cos(rad));
    return px(img, x, y)[0];
  };

  /** Angle of the brightest point on the ring — where the tail is. */
  const tailAngle = (img: RasterImage) => {
    let best = -1;
    let bestDeg = 0;
    for (let deg = 0; deg < 360; deg += 2) {
      const v = onRing(img, deg);
      if (v > best) {
        best = v;
        bestDeg = deg;
      }
    }
    return { deg: bestDeg, value: best };
  };

  it('builds a hollow ring, not a disc', async () => {
    const out = await runSources();
    expect(px(out.s0, 256, 256)[0]).toBe(0); // hole in the middle
    expect(px(out.s0, 4, 4)[0]).toBe(0); // and dark outside
    expect(tailAngle(out.s0).value).toBe(255); // …and the tail reaches full white
  });

  it('graduates the ring into ticks that ramp once around', async () => {
    const out = await runSources();
    // The conic sweep rises clockwise from the seam at 12 o'clock…
    expect(onRing(out.s0, 30)).toBeLessThan(onRing(out.s0, 150));
    expect(onRing(out.s0, 150)).toBeLessThan(onRing(out.s0, 270));
    // …so the tail is brightest just anticlockwise of 12, i.e. "up".
    expect(onRing(out.s0, 350)).toBeGreaterThan(200);
    // Posterize means discrete steps, not a smooth ramp: neighbouring samples
    // inside one tick are identical.
    expect(onRing(out.s0, 182)).toBe(onRing(out.s0, 186));
  });

  it('turns the tail a quarter turn per rotation', async () => {
    const out = await runSources();
    const base = tailAngle(out.s0).deg;
    const turned = (img: RasterImage) => (tailAngle(img).deg - base + 720) % 360;
    // Within a tick's width (30°) of a clean quarter, half and three-quarter turn.
    expect(turned(out.r90)).toBeGreaterThan(75);
    expect(turned(out.r90)).toBeLessThan(105);
    expect(turned(out.r180)).toBeGreaterThan(165);
    expect(turned(out.r180)).toBeLessThan(195);
    expect(turned(out.r270)).toBeGreaterThan(255);
    expect(turned(out.r270)).toBeLessThan(285);
    // The tail is "up" to start with, so the four states read up/right/down/left.
    expect(base).toBeGreaterThan(330);
  });

  it('points each view’s tail the way that view is seen from', async () => {
    const out = await runSources();
    const wiredTo = (handle: string) =>
      graph.edges.find((e) => e.target === 'grid' && e.targetHandle === handle)!.source;
    expect(wiredTo('c0r0')).toBe('s0'); // Left · Up    → tail up
    expect(wiredTo('c1r0')).toBe('r90'); // Right · Up   → tail right
    expect(wiredTo('c1r1')).toBe('r180'); // Right · Down → tail down
    expect(wiredTo('c0r1')).toBe('r270'); // Left · Down  → tail left

    // All four states differ, so the spin never stalls.
    const views = ['c0r0', 'c1r0', 'c0r1', 'c1r1'].map((h) => out[wiredTo(h)]);
    expect(new Set(views.map((v) => v.data.join(','))).size).toBe(4);
  });

  it('prints at the node’s default optics, on a 2×2 grid', () => {
    const node = graph.nodes.find((n) => n.id === 'grid')!;
    const defaults = getNodeDef('lensGrid').defaultConfig();
    // Only the grid size is the example's own choice — it supplies four views.
    expect(node.config).toEqual({ ...defaults, grid: 2, gridY: 2 });
  });

  it('renders a printable pair of sheets', async () => {
    const out = await runSources();
    const node = graph.nodes.find((n) => n.id === 'grid')!;
    const result = await getNodeDef('lensGrid').compute(
      // Rendered on a smaller, coarser sheet than the example ships: at the
      // default 100 mm and 1440 PPI the lens map is 32 MP, too slow to sit in a
      // unit test. Only those two settings change — the lens itself (45 LPI
      // pitch, 0.9 mm of varnish at RI 1.5, 2×2, mirrored) is the example's, so
      // fewer pixels land under each lenslet but the optics being solved are the
      // shipped ones. That the example ships the defaults is asserted above.
      ctx(
        { c0r0: out.s0, c1r0: out.r90, c1r1: out.r180, c0r1: out.r270 },
        {
          ...node.config,
          widthMm: 50,
          ppi: 600,
        },
      ),
    );
    const interlaced = result.interlaced as RasterImage;
    expect((result.depth as RasterImage).width).toBe(1181); // 50 mm at 600 PPI
    // The artwork sizes itself: the 512 px sources and the interlace floor are
    // both under the 1181 px the press can print. 512 is not a whole number of
    // pixels per cell, so it rounds up to the nearest that is — every cell then
    // divides into views at the same offsets and the sheet switches as one.
    expect(interlaced.width).toBe(531);
    // Whole pixels per cell, to within the rounding of the total width — which
    // is under one pixel across the whole sheet however many cells it holds.
    const cells = (50 * 45) / 25.4;
    const perCell = Math.round(interlaced.width / cells);
    expect(Math.abs(interlaced.width - cells * perCell)).toBeLessThan(1);
    if (result.info?.kind === 'text') expect(result.info.text).not.toContain('⚠');
    else throw new Error('expected a text info output');
  });
});

describe('every lenslet on the same pixel grid', () => {
  const cellsOf = (s: LensGridSettings) => (s.widthMm * s.lpi) / 25.4;

  it('gives every cell the same whole number of pixels across', () => {
    for (const s of [
      settings({ ppi: 1000 }),
      settings({ ppi: 1000, grid: 3 }),
      square({ ppi: 1000 }),
      settings({ ppi: 1000, stripSamples: 3 }),
    ]) {
      const width = gridInterlacedSize(s, QUAD).width;
      const cells = cellsOf(s);
      const perCell = Math.round(width / cells);
      // Whole, to within the rounding of the total width — which is under one
      // pixel across the sheet however many cells it holds.
      expect(Math.abs(width - cells * perCell)).toBeLessThan(1);
    }
  });

  it('gives every tile column an equal share of the cell when the press allows', () => {
    for (const grid of [2, 3, 4]) {
      const s = settings({ ppi: 4000, grid });
      const width = gridInterlacedSize(s, QUAD).width;
      const perCell = Math.round(width / cellsOf(s));
      expect(perCell % grid).toBe(0);
    }
  });

  it('rounds up rather than throwing detail away', () => {
    const s = settings({ ppi: 1000 });
    const floorPx = Math.ceil((cellsOf(s) * 2 * 2) / (Math.sqrt(3) / 2));
    expect(gridInterlacedSize(s, QUAD).width).toBeGreaterThanOrEqual(floorPx);
  });

  it('never goes past the press', () => {
    const s = settings({ ppi: 100 }); // a 100 px sheet
    expect(gridInterlacedSize(s, QUAD).width).toBeLessThanOrEqual(100);
    const big = createImage(4000, 4000);
    expect(gridInterlacedSize(s, [big, big, big, big]).width).toBeLessThanOrEqual(100);
  });

  it('can only align the rows of a square array, and says so', () => {
    // Square rows sit a whole pitch apart, so aligning across aligns down for
    // free. Hex rows sit √3/2 of a pitch apart, and √3/2 is irrational — no
    // whole column pitch has a whole row pitch, ever. That is a proof, not a
    // tolerance, and Square packing is the way out of it.
    expect(packingAlignsRows('square')).toBe(true);
    expect(packingAlignsRows('hex')).toBe(false);
    for (let perCell = 1; perCell <= 200; perCell++) {
      const rowPitch = perCell * (Math.sqrt(3) / 2);
      expect(Math.abs(rowPitch - Math.round(rowPitch))).toBeGreaterThan(1e-6);
    }
  });
});
