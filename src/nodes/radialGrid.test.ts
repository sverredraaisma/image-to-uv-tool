import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { radialGridNode, radialSettingsFromConfig, gatherRadialViews } from './radialGrid';
import { nodePorts, radialInputs, radialViewInputs } from '../engine/ports';
import { getNodeDef } from '../engine/registry';
import { createImage } from '../lib/image';
import {
  clampRadialViews,
  lensGeometry,
  radialInterlacedSize,
  radialSwitchViews,
  radialViewAngleDeg,
  radialViewAt,
  radialViewLabel,
  radialViews,
  renderRadialDepthMap,
  renderRadialInterlaced,
  type RadialSettings,
} from '../lib/lenticular';
import type { ComputeContext, DataValue, RasterImage, TextValue } from '../types';

const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

/** Config that renders a fast artwork on a 100 px lens map. */
const config = (over: Record<string, unknown> = {}) => ({
  ...radialGridNode.defaultConfig(),
  views: 4,
  widthMm: 25.4,
  ppi: 100,
  lpi: 10,
  heightMm: 5,
  packing: 'square',
  ...over,
});

const settings = (over: Partial<RadialSettings> = {}): RadialSettings => ({
  ...radialSettingsFromConfig(config()),
  ...over,
});

const solid = (color: [number, number, number], w = 20, h = 20): RasterImage =>
  createImage(w, h, [...color, 255]);

const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2]];
};

// Four solid views at 0° (right), 90° (up), 180° (left), 270° (down).
const RIGHT = solid([255, 0, 0]);
const UP = solid([0, 255, 0]);
const LEFT = solid([0, 0, 255]);
const DOWN = solid([255, 255, 0]);
const RING = [RIGHT, UP, LEFT, DOWN];
const fourInputs = { a0: RIGHT, a1: UP, a2: LEFT, a3: DOWN };

describe('radial view naming', () => {
  it('names the eight compass bearings and quotes the rest in degrees', () => {
    expect(radialViewLabel(0, 4)).toBe('0° · Right');
    expect(radialViewLabel(1, 4)).toBe('90° · Up');
    expect(radialViewLabel(2, 4)).toBe('180° · Left');
    expect(radialViewLabel(3, 4)).toBe('270° · Down');
    expect(radialViewLabel(1, 8)).toBe('45° · Up-right');
    // Five around a circle lands on 72°, which has no name worth inventing.
    expect(radialViewLabel(1, 5)).toBe('72°');
    expect(radialViewAngleDeg(1, 5)).toBeCloseTo(72, 9);
  });

  it('lists the views in port order, anticlockwise from the right', () => {
    const list = radialViews(6);
    expect(list.map((v) => v.id)).toEqual(['a0', 'a1', 'a2', 'a3', 'a4', 'a5']);
    expect(list.map((v) => Math.round(v.angleDeg))).toEqual([0, 60, 120, 180, 240, 300]);
  });

  it('clamps a nonsense view count into range', () => {
    expect(clampRadialViews(0)).toBe(2);
    expect(clampRadialViews(99)).toBe(12);
    expect(clampRadialViews(6)).toBe(6);
  });
});

describe('which view owns a bearing', () => {
  const s = { orientationDeg: 0, spin: 0, mirrorViews: false };

  it('cuts the cell into equal wedges by the angle of the offset', () => {
    // Unmirrored, a tile to the right of the centre belongs to the 0° view.
    expect(radialViewAt(1, 0, 4, s)).toBe(0);
    expect(radialViewAt(0, -1, 4, s)).toBe(1); // up the sheet is -v
    expect(radialViewAt(-1, 0, 4, s)).toBe(2);
    expect(radialViewAt(0, 1, 4, s)).toBe(3);
    // Radius is irrelevant — a wedge runs all the way to the rim.
    expect(radialViewAt(0.01, 0, 4, s)).toBe(0);
    expect(radialViewAt(9, 0, 4, s)).toBe(0);
  });

  it('puts a view opposite its own bearing when the lens inverts', () => {
    const m = { ...s, mirrorViews: true };
    // The view seen from the right sits on the left of the cell.
    expect(radialViewAt(-1, 0, 4, m)).toBe(0);
    expect(radialViewAt(1, 0, 4, m)).toBe(2);
  });

  it('centres each wedge on the bearing it is named for', () => {
    // Dead level with the right-hand edge is the middle of view 0, not a seam,
    // so a whisker either side of it is still view 0.
    expect(radialViewAt(1, -0.01, 4, s)).toBe(0);
    expect(radialViewAt(1, 0.01, 4, s)).toBe(0);
    // The seams are halfway between two names: 45° for four views.
    expect(radialViewAt(1, -0.99, 4, s)).toBe(0);
    expect(radialViewAt(0.99, -1, 4, s)).toBe(1);
  });

  it('turns with the array, so a bearing means the same on the printed sheet', () => {
    // Lattice axes turned 90°: the sheet direction "right" is now (0, -1) in
    // lattice coordinates, and it still belongs to the view named 0°.
    const turned = { orientationDeg: 90, spin: 0, mirrorViews: false };
    expect(radialViewAt(0, -1, 4, turned)).toBe(0);
    // And (1, 0) in those turned axes points *down* the sheet, so it belongs
    // to the view named 270°, not to the one it would own unturned.
    expect(radialViewAt(1, 0, 4, turned)).toBe(3);
    expect(radialViewAt(1, 0, 4, s)).toBe(0);
  });

  it('spins the seams without renaming the views', () => {
    // Half a step of spin puts a seam where the middle of view 0 was, so the
    // two sides of the bearing now belong to different views.
    const spun = { ...s, spin: 0.5 };
    expect(radialViewAt(1, -0.01, 4, spun)).not.toBe(radialViewAt(1, 0.01, 4, spun));
  });
});

// The wedge-placement tests below sample a lenslet 10 px across, so they pin
// the artwork to the lens map's raster; the sizing rule is its own test.
const ART = { width: 100, height: 100 };

describe('radial interlace', () => {
  it('gives every view the wedge at its own bearing', () => {
    const art = renderRadialInterlaced(RING, settings({ mirrorViews: false }), { interlacedSize: ART });
    // One lenslet is 10 px across at these settings; sample around a centre.
    const cx = 15;
    const cy = 15;
    expect(px(art, cx + 3, cy)).toEqual([255, 0, 0]); // right → 0°
    expect(px(art, cx, cy - 3)).toEqual([0, 255, 0]); // up → 90°
    expect(px(art, cx - 3, cy)).toEqual([0, 0, 255]); // left → 180°
    expect(px(art, cx, cy + 3)).toEqual([255, 255, 0]); // down → 270°
  });

  it('mirrors the ring when the lens inverts, which is the default', () => {
    const art = renderRadialInterlaced(RING, settings({ mirrorViews: true }), { interlacedSize: ART });
    const cx = 15;
    const cy = 15;
    // The view named 0° is now on the left of the cell, so that an eye to the
    // right sees it through the lens.
    expect(px(art, cx - 3, cy)).toEqual([255, 0, 0]);
    expect(px(art, cx + 3, cy)).toEqual([0, 0, 255]);
  });

  it('carries every view somewhere on the sheet', () => {
    const art = renderRadialInterlaced(RING, settings(), { interlacedSize: ART });
    const seen = new Set<string>();
    for (let i = 0; i < art.width * art.height; i++) {
      seen.add(`${art.data[i * 4]},${art.data[i * 4 + 1]},${art.data[i * 4 + 2]}`);
    }
    for (const v of ['255,0,0', '0,255,0', '0,0,255', '255,255,0']) expect(seen.has(v)).toBe(true);
  });

  it('refuses a ring that is not the size it was configured for', () => {
    expect(() => renderRadialInterlaced([RIGHT, UP], settings({ views: 4 }), {})).toThrow(/needs 4 images/);
  });

  it('sizes the artwork for the wedges, capped at what the press can print', () => {
    const s = settings();
    // 10 cells × 4 views × 2 samples ÷ π = 26 px: enough that a wedge is two
    // pixels wide at the rim, which is where a wedge is widest. Then rounded
    // up to 3 whole pixels per cell, so every cap divides identically.
    expect(radialInterlacedSize(s, RING).width).toBe(30);
    // No orientation helps a radial edge, so none of them changes the size…
    expect(radialInterlacedSize({ ...s, orientationDeg: 0 }, RING).width).toBe(
      radialInterlacedSize({ ...s, orientationDeg: 23 }, RING).width,
    );
    // …but more samples do, and they stop at the 100 px the press can print.
    expect(radialInterlacedSize({ ...s, stripSamples: 8 }, RING).width).toBe(100); // capped, wanted 102
    // 51 px of floor at four samples, rounded up to 6 whole pixels per cell.
    expect(radialInterlacedSize({ ...s, stripSamples: 4 }, RING).width).toBe(60);
  });

  it('prints the same lens array as the grid does', () => {
    const map = renderRadialDepthMap(RING, settings(), {});
    expect([map.width, map.height]).toEqual([100, 100]);
    // Caps standing on a base: something reaches (near) the top of the stack —
    // no pixel centre lands exactly on an apex — and the flats a square packing
    // leaves in the cell corners sit at exactly the base height.
    const g = lensGeometry(settings());
    expect(Math.max(...map.depth)).toBeGreaterThan(65000);
    expect(Math.min(...map.depth)).toBe(Math.round((g.baseMm / g.totalMm) * 65535));
  });

  it('flashes as you walk around, for the switch sheet', () => {
    const views = radialSwitchViews(4);
    expect(views).toHaveLength(4);
    expect(views.map((v) => v.data[0])).toEqual([255, 0, 255, 0]);
  });
});

describe('radial node', () => {
  it('is registered, manual, and has its editor', () => {
    expect(getNodeDef('radialGrid')).toBe(radialGridNode);
    expect(radialGridNode.autoRun).toBe(false);
    expect(radialGridNode.customEditor).toBe('radialGrid');
    expect(radialGridNode.category).toBe('UV');
  });

  it('grows and shrinks its ports with the view count', () => {
    const four = nodePorts({ type: 'radialGrid', config: config({ views: 4 }) }, radialGridNode);
    expect(four.inputs.map((p) => p.id)).toEqual(['all', 'a0', 'a1', 'a2', 'a3']);
    expect(four.inputs[1].label).toBe('0° · Right');
    const eight = nodePorts({ type: 'radialGrid', config: config({ views: 8 }) }, radialGridNode);
    expect(eight.inputs).toHaveLength(9);
    // A graph that lost the key falls back to the node's own default, not to
    // the minimum — it must not silently shed ports.
    expect(radialInputs({}).length - 1).toBe(6);
    expect(radialViewInputs({ views: 3 })).toHaveLength(3);
  });

  it('takes the ring on one wire, and lets a single port override it', () => {
    const bundle: DataValue = { kind: 'sequence', frames: RING };
    const gathered = gatherRadialViews({ all: bundle }, config());
    expect(gathered).toEqual(RING);

    const patched = gatherRadialViews({ all: bundle, a1: DOWN }, config());
    expect(Array.isArray(patched) && patched[1]).toBe(DOWN);
  });

  it('names what is missing rather than rendering a hole', async () => {
    await expect(radialGridNode.compute(ctx({ a0: RIGHT }, config()))).rejects.toThrow(
      /needs all 4 views.*90° · Up/s,
    );
  });

  it('renders both halves and reports the geometry', async () => {
    const out = await radialGridNode.compute(ctx(fourInputs, config()));
    // The artwork is sized by the wedges; the lens map keeps the PPI raster.
    expect((out.interlaced as RasterImage).width).toBe(30);
    expect((out.depth as RasterImage).width).toBe(100);
    const info = (out.info as TextValue).text;
    expect(info).toContain('4 views around the circle, one every 90.0°');
    expect(info).toContain('Head-on all 4 merge');
    expect(info).toContain('Artwork on the minimal raster: 30 px of the 100 px');
    expect(info).toContain('wedge seams');
  });

  it('warns when the wedges are too fine to print at all', async () => {
    // Twelve views under a lenslet only 4 px across: a wedge is about a
    // printed dot wide at the rim, and narrower everywhere inside it.
    const twelve: Record<string, DataValue> = {};
    radialViews(12).forEach((v, i) => (twelve[v.id] = RING[i % RING.length]));
    const out = await radialGridNode.compute(ctx(twelve, config({ views: 12, lpi: 40, ppi: 160 })));
    const info = (out.info as TextValue).text;
    expect(info).toContain('⚠');
    expect(info).toContain('even at the rim');
  });
});

describe('every cap on the same pixel grid', () => {
  const cellsOf = (s: RadialSettings) => (s.widthMm * s.lpi) / 25.4;

  it('gives every cap the same whole number of pixels across', () => {
    for (const s of [
      settings(),
      settings({ stripSamples: 4 }),
      settings({ views: 6, ppi: 1000 }),
      settings({ lpi: 13, ppi: 1200 }),
    ]) {
      const width = radialInterlacedSize(s, radialRing(s)).width;
      const cells = cellsOf(s);
      const perCell = Math.round(width / cells);
      expect(Math.abs(width - cells * perCell)).toBeLessThan(1);
    }
  });

  it('rounds up rather than losing a wedge, and stops at the press', () => {
    const s = settings({ ppi: 1000 });
    const floorPx = Math.ceil((cellsOf(s) * 4 * 2) / Math.PI);
    const width = radialInterlacedSize(s, RING).width;
    expect(width).toBeGreaterThanOrEqual(floorPx);
    expect(radialInterlacedSize(settings({ ppi: 100, stripSamples: 8 }), RING).width).toBeLessThanOrEqual(
      100,
    );
  });
});

/** A ring of the size a settings object asks for, for the sizing tests. */
function radialRing(s: RadialSettings): RasterImage[] {
  return Array.from({ length: clampRadialViews(s.views) }, () => RIGHT);
}
