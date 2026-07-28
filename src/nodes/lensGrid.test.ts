import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { lensGridNode, gridSettingsFromConfig } from './lensGrid';
import { lensGridInputs, nodePorts } from '../engine/ports';
import { getNodeDef } from '../engine/registry';
import { EXAMPLES } from '../components/examples';
import { createImage } from '../lib/image';
import {
  gridAxisLabel,
  gridCellLabel,
  gridCells,
  gridInterlacedSize,
  gridSwitchViews,
  renderGridDepthMap,
  renderGridInterlaced,
  type LensGridSettings,
} from '../lib/lenticular';
import type { ComputeContext, DataValue, RasterImage, SavedGraph } from '../types';

const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

/** Config that renders a fast 40 px artwork on a 100 px lens map. */
const config = (over: Record<string, unknown> = {}) => ({
  ...lensGridNode.defaultConfig(),
  grid: 2,
  widthMm: 25.4,
  ppi: 100,
  lpi: 10,
  heightMm: 5,
  ...over,
});

const settings = (over: Partial<LensGridSettings> = {}): LensGridSettings => ({
  ...gridSettingsFromConfig(config()),
  ...over,
});

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
    expect(gridCells(99)).toHaveLength(36); // ceiling of 6×6
  });
});

describe('Lens Grid node ports', () => {
  it('derives one required input per cell from the config', () => {
    const ports = nodePorts({ type: 'lensGrid', config: { grid: 3 } }, getNodeDef('lensGrid'));
    expect(ports.inputs).toHaveLength(9);
    expect(ports.inputs.every((p) => p.required && p.type === 'image')).toBe(true);
    expect(ports.inputs[4].label).toBe('Centre (neutral)');
    expect(ports.outputs.map((p) => p.id)).toEqual(['interlaced', 'depth', 'info']);
  });

  it('follows the grid setting', () => {
    expect(lensGridInputs({ grid: 2 })).toHaveLength(4);
    expect(lensGridInputs({ grid: 4 })).toHaveLength(16);
    expect(lensGridInputs({})).toHaveLength(9); // default 3×3
    expect(lensGridInputs({ grid: '2' })).toHaveLength(4); // config values can be strings
  });
});

describe('renderGridInterlaced', () => {
  it('splits every cell into a grid of view tiles', () => {
    const s = settings();
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
    const img = renderGridInterlaced(QUAD, settings({ mirrorViews: false }), {
      interlacedSize: { width: 40, height: 40 },
    });
    expect(px(img, 0, 0)).toEqual([255, 0, 0]); // Left · Up, straight through
    expect(px(img, 2, 2)).toEqual([255, 255, 0]); // Right · Down
  });

  it('shifts the tiles with each axis’ own phase', () => {
    const size = { width: 40, height: 40 };
    const x = renderGridInterlaced(QUAD, settings({ phase: 0.5 }), { interlacedSize: size });
    expect(px(x, 0, 0)).toEqual([0, 0, 255]); // stepped one column
    const y = renderGridInterlaced(QUAD, settings({ phaseY: 0.5 }), { interlacedSize: size });
    expect(px(y, 0, 0)).toEqual([0, 255, 0]); // stepped one row
  });

  it('insists on exactly grid² views', () => {
    expect(() => renderGridInterlaced([LU, RU, LD], settings())).toThrow(/2×2 lens grid needs 4 images/);
    expect(() => renderGridInterlaced([...QUAD, LU], settings())).toThrow(/got 5/);
    expect(() => renderGridInterlaced(QUAD, settings({ grid: 3 }))).toThrow(/3×3 lens grid needs 9/);
  });
});

describe('gridInterlacedSize', () => {
  it('needs grid tiles per cell, not just frames per lenticule', () => {
    // 10 cells across × grid × 2 samples.
    expect(gridInterlacedSize(settings(), QUAD).width).toBe(40);
    expect(gridInterlacedSize(settings({ grid: 3 }), QUAD).width).toBe(60);
  });

  it('still keeps the highest-resolution view', () => {
    const big = solid([0, 0, 0], 500, 500);
    expect(gridInterlacedSize(settings(), [big, RU, LD, RD]).width).toBe(500);
  });
});

describe('renderGridDepthMap', () => {
  it('domes each cell, peaking at its centre', () => {
    const map = renderGridDepthMap(QUAD, settings());
    const at = (x: number, y: number) => map.depth[y * map.width + x];
    // 10 px per cell on the 100 px lens raster, so the apex is near (5, 5).
    expect(at(5, 5)).toBeGreaterThan(at(2, 5));
    expect(at(5, 5)).toBeGreaterThan(at(5, 2));
    expect(at(5, 5)).toBeGreaterThan(at(2, 2));
    expect(at(5, 5)).toBe(Math.max(...[...map.depth.slice(0, map.width * 10)]));
  });

  it('leaves the cell corners flat at base height', () => {
    const s = settings();
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
    const map = renderGridDepthMap(QUAD, settings());
    const at = (x: number, y: number) => map.depth[y * map.width + x];
    expect(at(23, 47)).toBe(at(3, 7));
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
  });

  it('interlaces the grid and reports both rasters', async () => {
    const out = await lensGridNode.compute(ctx(fourInputs, config()));
    const interlaced = out.interlaced as RasterImage;
    expect(interlaced.width).toBe(40);
    expect((out.depth as RasterImage).width).toBe(100);
    if (out.info?.kind === 'text') {
      expect(out.info.text).toContain('2×2 grid = 4 views');
      expect(out.info.text).toContain('Each view resolves to 10×10 px');
    } else throw new Error('expected a text info output');
  });

  it('names the cells that are still unconnected', async () => {
    await expect(lensGridNode.compute(ctx({ c0r0: LU, c1r1: RD }, config()))).rejects.toThrow(
      /Missing: Right · Up, Left · Down/,
    );
  });

  it('reads the grid-only settings out of config', () => {
    const s = gridSettingsFromConfig({ grid: 4, phaseY: 0.25, mirrorViews: false });
    expect(s).toMatchObject({ grid: 4, phaseY: 0.25, mirrorViews: false });
    // …and inherits the shared print settings.
    expect(s.ppi).toBe(1440);
    expect(gridSettingsFromConfig({}).grid).toBe(3);
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

  it('renders to a small, printable pair of sheets', async () => {
    const out = await runSources();
    const node = graph.nodes.find((n) => n.id === 'grid')!;
    const result = await getNodeDef('lensGrid').compute(
      ctx({ c0r0: out.s0, c1r0: out.r90, c1r1: out.r180, c0r1: out.r270 }, node.config),
    );
    const interlaced = result.interlaced as RasterImage;
    expect((result.depth as RasterImage).width).toBe(1181); // 50 mm at 600 PPI
    expect(interlaced.width).toBe(512); // the source spinner's own resolution
    if (result.info?.kind === 'text') expect(result.info.text).not.toContain('⚠');
    else throw new Error('expected a text info output');
  });
});
