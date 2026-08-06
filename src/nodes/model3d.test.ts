import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import {
  coneFromConfig,
  describeMesh,
  describeViewGrid,
  modelInputNode,
  modelViewsNode,
  viewGridOptionsFromConfig,
} from './model3d';
import { lensGridNode } from './lensGrid';
import { getNodeDef } from '../engine/registry';
import { nodePorts } from '../engine/ports';
import { EXAMPLES } from '../components/examples';
import { stlToBinary } from '../lib/stl';
import { lensGeometry } from '../lib/lenticular';
import type { ComputeContext, DataValue, RasterImage, SavedGraph, StlValue, SequenceValue } from '../types';

const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

/** A tetrahedron: four faces, real depth, tiny. */
const TETRA: StlValue = {
  kind: 'stl',
  triangleCount: 4,
  triangles: new Float32Array([
    0, 1, 0, -1, -1, 1, 1, -1, 1, 0, 1, 0, 1, -1, 1, 0, -1, -1, 0, 1, 0, 0, -1, -1, -1, -1, 1, -1, -1, 1, 0,
    -1, -1, 1, -1, 1,
  ]),
};

/** Config that renders fast: small views, no supersampling. */
const config = (over: Record<string, unknown> = {}) => ({
  ...modelViewsNode.defaultConfig(),
  viewPx: 48,
  supersample: 1,
  // `grid` on its own means a square grid, the only shape there used to be.
  ...('grid' in over ? { gridY: over.grid } : {}),
  ...over,
});

describe('3D Model Input', () => {
  it('parses an uploaded STL into a mesh and describes it', async () => {
    const bytes = stlToBinary(TETRA);
    const src = `data:model/stl;base64,${btoa(String.fromCharCode(...bytes))}`;
    const out = await modelInputNode.compute(ctx({}, { ...modelInputNode.defaultConfig(), src }));
    const stl = out.out as StlValue;
    expect(stl.kind).toBe('stl');
    expect(stl.triangleCount).toBe(4);
    expect(stl.triangles).toEqual(TETRA.triangles);
    if (out.info?.kind === 'text') expect(out.info.text).toContain('4 triangles');
    else throw new Error('expected a text info output');
  });

  it('outputs nothing at all until something is uploaded', async () => {
    const out = await modelInputNode.compute(ctx({}, modelInputNode.defaultConfig()));
    expect(out.out).toBeUndefined();
    expect(out.info).toBeUndefined();
  });

  it('reports the bounds in model units, and that the scale does not matter', () => {
    const text = describeMesh(TETRA, 'tetra.stl');
    expect(text).toContain('tetra.stl');
    expect(text).toContain('Bounds 2 × 2 × 2');
    expect(text).toMatch(/fitted to the print/i);
  });
});

describe('Model → Grid Views', () => {
  it('sends the whole grid down one wire, in cell order', async () => {
    const out = await modelViewsNode.compute(ctx({ model: TETRA }, config()));
    const views = out.views as SequenceValue;
    expect(views.kind).toBe('sequence');
    expect(views.frames).toHaveLength(9); // the default 3×3
    expect(views.frames[0].width).toBe(48);
    expect(views.frames[0].height).toBe(36); // 100 × 75 mm sheet
    // Exactly the ports Lens Grid Print reads, and nothing per-cell.
    expect(modelViewsNode.outputs.map((p) => p.id)).toEqual(['views', 'depth', 'info']);
    expect((out.depth as RasterImage).width).toBe(48);
  });

  it('needs a mesh', async () => {
    await expect(modelViewsNode.compute(ctx({}, config()))).rejects.toThrow(/Connect a mesh/);
  });

  it('renders one view per cell for any grid size, up to the 15×15 ceiling', async () => {
    for (const grid of [2, 4, 8]) {
      const out = await modelViewsNode.compute(ctx({ model: TETRA }, config({ grid })));
      expect((out.views as SequenceValue).frames).toHaveLength(grid * grid);
    }
  });

  it('renders an oblong grid, one view per cell of it', async () => {
    // 2 across × 3 down: six eye positions, and the print node reads them in
    // the same row-major order it names its own cells in.
    const out = await modelViewsNode.compute(ctx({ model: TETRA }, config({ grid: 2, gridY: 3 })));
    expect((out.views as SequenceValue).frames).toHaveLength(6);
    const cfg = { ...modelViewsNode.defaultConfig(), grid: 2, gridY: 3 };
    expect(describeViewGrid(cfg, viewGridOptionsFromConfig(cfg), TETRA, 0.3)).toContain('2×3 = 6 views');
  });

  it('flips the depth output on request', async () => {
    const near = (img: RasterImage) => img.data[Math.floor(img.height / 2) * img.width * 4 + 4];
    const normal = (await modelViewsNode.compute(ctx({ model: TETRA }, config()))).depth as RasterImage;
    const flipped = (await modelViewsNode.compute(ctx({ model: TETRA }, config({ flipDepth: true }))))
      .depth as RasterImage;
    expect(near(flipped)).toBe(255 - near(normal));
  });
});

describe('the view cone', () => {
  it('is solved from the lens by default, so the views match what it can show', () => {
    const cone = coneFromConfig(config());
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
    expect(cone).toBeCloseTo(solved.viewAngleDeg, 10);
    // 53.3°, not the 57° an RI-1.5 lens tops out at: that ceiling needs a stack
    // right on the feasibility floor, and 0.9 mm at 45 LPI sits 6% above it.
    expect(cone).toBeCloseTo(53.3, 1);
  });

  it('follows the lens settings, and can be overridden by hand', () => {
    // A shallower stack at the same pitch is a stronger lens: a wider cone.
    expect(coneFromConfig(config({ lensHeightMm: 0.7 }))).toBeGreaterThan(coneFromConfig(config()));
    expect(coneFromConfig(config({ coneMode: 'manual', coneDeg: 20 }))).toBe(20);
    // A hand-set cone ignores the lens fields entirely.
    expect(coneFromConfig(config({ coneMode: 'manual', coneDeg: 20, lpi: 10 }))).toBe(20);
  });
});

describe('the Info report', () => {
  // The real defaults, not the fast render config: this builds text, it does
  // not rasterise, so there is nothing to speed up and every warning threshold
  // is then measured against what a user actually gets.
  const report = (over: Record<string, unknown> = {}) => {
    // `grid` alone is a square grid, as it was when that was the only shape.
    const cfg = {
      ...modelViewsNode.defaultConfig(),
      ...('grid' in over ? { gridY: over.grid } : {}),
      ...over,
    };
    return describeViewGrid(cfg, viewGridOptionsFromConfig(cfg), TETRA, 0.3);
  };

  it('states the grid, the cone and where the cone came from', () => {
    const text = report();
    expect(text).toContain('3×3 = 9 views');
    expect(text).toMatch(/Cone 53\.\d°\s\(solved from 45 LPI/);
    expect(text).toContain('Each view will print at 177×133 px');
  });

  it('says where the window puts the subject, and what standing there costs it', () => {
    const text = report({ depthMm: 6, setbackMm: 4 });
    expect(text).toContain('the subject stands 4.0–10.0 mm behind the sheet');
    // Fitted at the near face: 404/400 up, and the far face 1.5% smaller again.
    expect(text).toContain('scaled ×1.010');
    expect(text).toMatch(/far face lands 1\.\d% smaller/);
  });

  it('passes the defaults without a warning — they sit just under one lenslet', () => {
    const text = report();
    expect(text).not.toContain('⚠');
    const step = parseFloat(/Parallax ([\d.]+) lenslets/.exec(text)![1]);
    expect(step).toBeGreaterThan(0.75);
    expect(step).toBeLessThan(1); // any more and a feature skips a lenslet
  });

  it('warns when the subject is too deep to print, and says how deep it may be', () => {
    const text = report({ depthMm: 20 });
    expect(text).toMatch(/⚠ 16\.\d+ lenslets per step is far past the line/);
    expect(text).toContain('double rather than soften');
    // 1.5 lenslets is the ceiling, so it should suggest about a ninth of 20 mm.
    expect(text).toMatch(/Reduce Subject depth to about 1\.\d mm/);
  });

  it('calls a mild overshoot haze rather than a fault', () => {
    // 1.5–4 lenslets: the far face blurs progressively with distance, which is
    // what air does. Worth having, so it is a note and not a warning.
    const text = report({ depthMm: 3 });
    expect(text).toMatch(/· 2\.\d+ lenslets per step is over the 1\.5/);
    expect(text).toContain('read as haze');
    expect(text).not.toContain('⚠');
  });

  it('reports a subject brought out through the plate, and warns about the edges', () => {
    const text = report({ depthMm: 30, setbackMm: -2, grid: 15 });
    expect(text).toContain('reaches 2.0 mm out through the plate and 28.0 mm into it');
    expect(text).toContain('window violation');
    // Fitted at the near face, which is now in front of the sheet: down, not up.
    expect(text).toContain('scaled ×0.995');
  });

  it('names whichever face actually moves most', () => {
    // Deep behind the glass, the far face decides…
    expect(report({ depthMm: 30, setbackMm: -2 })).toContain('per view step at the far face');
    // …but a subject that pokes out further than it sinks is decided in front.
    expect(report({ depthMm: 1, setbackMm: -5 })).toContain('per view step at the near face');
  });

  it('holds a negative setback to a sane distance in front of the sheet', () => {
    // A quarter of the viewing distance; past that the projection runs away.
    expect(viewGridOptionsFromConfig({ setbackMm: -50, viewDistanceMm: 400 }).setbackMm).toBe(-50);
    expect(viewGridOptionsFromConfig({ setbackMm: -500, viewDistanceMm: 400 }).setbackMm).toBe(-100);
  });

  it('counts the setback against the depth budget, since the far face is what moves', () => {
    const step = (over: Record<string, unknown>) =>
      parseFloat(/Parallax ([\d.]+) lenslets/.exec(report(over))![1]);
    expect(step({ depthMm: 1, setbackMm: 1 })).toBeCloseTo(step({ depthMm: 2, setbackMm: 0 }), 2);
  });

  it('warns when there is so little depth that the print will look flat', () => {
    expect(report({ depthMm: 0.1 })).toMatch(/⚠ Only 0\.0\d lenslets per step/);
  });

  it('warns when the render is coarser than the print can resolve', () => {
    expect(report({ viewPx: 64 })).toMatch(/⚠ Rendering 64 px wide but the print resolves 177/);
    expect(report({ viewPx: 512 })).not.toContain('upsampled');
  });

  it('measures the parallax on the sparser axis, which is where the steps are biggest', () => {
    const step = (over: Record<string, unknown>) =>
      parseFloat(/Parallax ([\d.]+) lenslets/.exec(report(over))![1]);
    // Both axes cross the same cone, so 15 across by 3 down steps as far as a
    // 3×3 does — vertically — and that is what decides whether it doubles.
    expect(step({ grid: 15, gridY: 3 })).toBeCloseTo(step({ grid: 3 }), 5);
    expect(report({ grid: 15, gridY: 3 })).toContain('down — the sparser axis');
    expect(report({ grid: 3, gridY: 15 })).toContain('across — the sparser axis');
    expect(report({ grid: 3 })).toContain('either axis');
  });

  it('spends more depth on a bigger grid, because the steps get smaller', () => {
    const step = (over: Record<string, unknown>) =>
      parseFloat(/Parallax ([\d.]+) lenslets/.exec(report(over))![1]);
    expect(step({ grid: 6 })).toBeLessThan(step({ grid: 3 }));
    expect(step({ grid: 2 })).toBeGreaterThan(step({ grid: 3 }));
    // 15×15 is the ceiling, and it is what buys real depth: 14 steps across the
    // cone instead of 2, so seven times the subject at the same parallax. 7 mm
    // behind the glass doubles on a 3×3 and prints cleanly on a 15×15.
    expect(report({ grid: 3, depthMm: 7 })).toMatch(/far past the line/);
    expect(report({ grid: 15, depthMm: 7 })).not.toContain('⚠');
  });
});

describe('feeding Lens Grid Print from one wire', () => {
  it('takes the whole grid off a sequence', async () => {
    const rendered = await modelViewsNode.compute(ctx({ model: TETRA }, config()));
    const out = await lensGridNode.compute(
      ctx({ views: rendered.views }, { ...lensGridNode.defaultConfig(), widthMm: 25.4, ppi: 100, lpi: 10 }),
    );
    // 10 cells × 3 tiles × 2 samples ÷ √3/2 = 70 px of floor, rounded up to 9
    // whole pixels per cell (3 per tile column) and still under the 100 px cap.
    expect((out.interlaced as RasterImage).width).toBe(90);
    if (out.info?.kind === 'text') expect(out.info.text).toContain('3×3 grid = 9 views');
    else throw new Error('expected a text info output');
  });

  it('lets a single cell port override one view from the bundle', async () => {
    const rendered = (await modelViewsNode.compute(ctx({ model: TETRA }, config()))).views as SequenceValue;
    const red: RasterImage = {
      kind: 'image',
      width: 4,
      height: 3,
      data: new Uint8ClampedArray(4 * 3 * 4).fill(255),
    };
    const cfg = { ...lensGridNode.defaultConfig(), widthMm: 25.4, ppi: 100, lpi: 10 };
    // c1r1 is the centre of a 3×3; the other eight still come off the sequence.
    const out = await lensGridNode.compute(ctx({ views: rendered, c1r1: red }, cfg));
    expect(out.interlaced).toBeDefined();
  });

  it('still names the cells a short sequence cannot fill', async () => {
    const short: SequenceValue = { kind: 'sequence', frames: [] };
    await expect(
      lensGridNode.compute(ctx({ views: short }, { ...lensGridNode.defaultConfig(), grid: 2, gridY: 2 })),
    ).rejects.toThrow(/Missing: Left · Up, Right · Up, Left · Down, Right · Down/);
  });

  it('exposes the sequence port on the node itself', () => {
    const ports = nodePorts({ type: 'lensGrid', config: {} }, getNodeDef('lensGrid'));
    expect(ports.inputs[0]).toMatchObject({ id: 'views', type: 'sequence' });
  });
});

describe('OBJ and textures', () => {
  /** A uv-mapped quad OBJ: colour comes from a texture, not the mesh. */
  const MAPPED_OBJ = `v -1 -1 0
v 1 -1 0
v 1 1 0
v -1 1 0
vt 0 0
vt 1 0
vt 1 1
vt 0 1
f 1/1 2/2 3/3 4/4
`;

  const upload = (text: string, name: string) => ({
    ...modelInputNode.defaultConfig(),
    src: `data:model/obj;base64,${btoa(text)}`,
    name,
  });

  it('loads an OBJ through the same input node as an STL', async () => {
    const out = await modelInputNode.compute(ctx({}, upload(MAPPED_OBJ, 'quad.obj')));
    const mesh = out.out as StlValue;
    expect(mesh.triangleCount).toBe(2); // the quad, fanned
    expect(mesh.uvs).toBeDefined();
    if (out.info?.kind === 'text') expect(out.info.text).toContain('texture coordinates');
    else throw new Error('expected a text info output');
  });

  it('paints the texture wired into the render node', async () => {
    const mesh = (await modelInputNode.compute(ctx({}, upload(MAPPED_OBJ, 'quad.obj')))).out;
    const texture: RasterImage = {
      kind: 'image',
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([20, 200, 40, 255]),
    };
    const out = await modelViewsNode.compute(
      ctx({ model: mesh, texture }, config({ ambient: 1, margin: 0 })),
    );
    const view = (out.views as SequenceValue).frames[4];
    const mid = (Math.floor(view.height / 2) * view.width + Math.floor(view.width / 2)) * 4;
    expect([...view.data.slice(mid, mid + 3)]).toEqual([20, 200, 40]);
    if (out.info?.kind === 'text') expect(out.info.text).toContain('Surface: texture, 1×1 px');
    else throw new Error('expected a text info output');
  });

  it('says so when a texture is wired to a mesh that cannot use it', async () => {
    const texture: RasterImage = {
      kind: 'image',
      width: 1,
      height: 1,
      data: new Uint8ClampedArray([1, 2, 3, 255]),
    };
    // TETRA is an STL-style mesh: no uvs, so the texture has nowhere to land.
    const out = await modelViewsNode.compute(ctx({ model: TETRA, texture }, config()));
    if (out.info?.kind === 'text') {
      expect(out.info.text).toMatch(/⚠ a texture is wired in but the mesh has no texture coordinates/);
    } else throw new Error('expected a text info output');
  });

  it('renders a vertex-coloured mesh without any texture at all', async () => {
    const coloured = `v -1 -1 0 1 0 0
v 1 -1 0 1 0 0
v 1 1 0 1 0 0
v -1 1 0 1 0 0
f 1 2 3 4
`;
    const mesh = (await modelInputNode.compute(ctx({}, upload(coloured, 'flat.obj')))).out;
    const out = await modelViewsNode.compute(ctx({ model: mesh }, config({ ambient: 1, margin: 0 })));
    const view = (out.views as SequenceValue).frames[4];
    const mid = (Math.floor(view.height / 2) * view.width + Math.floor(view.width / 2)) * 4;
    expect([...view.data.slice(mid, mid + 3)]).toEqual([255, 0, 0]);
    if (out.info?.kind === 'text') expect(out.info.text).toContain('the mesh’s own vertex colours');
    else throw new Error('expected a text info output');
  });
});

describe('the cube example', () => {
  const example = EXAMPLES.find((e) => e.name.includes('cube'))!;
  const graph = example.graph as SavedGraph;

  it('wires the mesh through the renderer into the print, on one edge', () => {
    expect(graph.edges).toEqual([
      expect.objectContaining({ source: 'cube', target: 'views', targetHandle: 'model' }),
      expect.objectContaining({
        source: 'views',
        sourceHandle: 'views',
        target: 'grid',
        targetHandle: 'views',
      }),
    ]);
  });

  it('ships the cube as a real OBJ, with a colour per face', async () => {
    const node = graph.nodes.find((n) => n.id === 'cube')!;
    const out = await getNodeDef('modelInput').compute(ctx({}, node.config));
    const stl = out.out as StlValue;
    expect(stl.triangleCount).toBe(12); // six quads, fanned into two each
    // 20 units on a side, centred on the origin.
    expect([...stl.triangles].every((v) => Math.abs(v) === 10)).toBe(true);
    // Six distinct face colours, flat across each face — which is the whole
    // reason the cube is an OBJ and not the STL it started as.
    expect(stl.colours).toBeDefined();
    const perTriangle = Array.from({ length: 12 }, (_, t) => stl.colours!.slice(t * 9, t * 9 + 9));
    for (const tri of perTriangle) {
      expect([...tri.slice(0, 3)]).toEqual([...tri.slice(3, 6)]); // flat across…
      expect([...tri.slice(0, 3)]).toEqual([...tri.slice(6, 9)]); // …all three corners
    }
    expect(new Set(perTriangle.map((t) => t.slice(0, 3).join(','))).size).toBe(6);
    if (out.info?.kind === 'text') expect(out.info.text).toContain('vertex colours');
    else throw new Error('expected a text info output');
  });

  it('prints at the nodes’ defaults, turned only to give the cube a silhouette', () => {
    const views = graph.nodes.find((n) => n.id === 'views')!;
    const grid = graph.nodes.find((n) => n.id === 'grid')!;
    expect(views.config).toEqual({ ...modelViewsNode.defaultConfig(), rotX: -25, rotY: 30 });
    expect(grid.config).toEqual(lensGridNode.defaultConfig());
    // Both nodes must agree on the grid, or the print is short of views.
    expect(views.config.grid).toBe(grid.config.grid);
  });

  it('renders nine views of a solid cube that the print then accepts', async () => {
    const views = graph.nodes.find((n) => n.id === 'views')!;
    const mesh = (await getNodeDef('modelInput').compute(ctx({}, graph.nodes[0].config))).out;
    // Rendered smaller than the example ships, so this stays a unit test; the
    // optics being solved (the 57° cone off 45 LPI at 0.9 mm, RI 1.5) are the
    // example's own, and that it ships the defaults is asserted above.
    const rendered = await getNodeDef('modelViews').compute(
      ctx({ model: mesh }, { ...views.config, viewPx: 64, supersample: 1 }),
    );
    const frames = (rendered.views as SequenceValue).frames;
    expect(frames).toHaveLength(9);
    // The depth budget and the framing are the example's own and must be sound.
    // (It does warn about resolution here — this test renders 64 px on purpose,
    // where the shipped 512 does not.)
    if (rendered.info?.kind === 'text') {
      expect(rendered.info.text).not.toMatch(/far past the line/);
      expect(rendered.info.text).not.toMatch(/⚠ Only/);
      expect(rendered.info.text).not.toMatch(/barely covers/);
    } else throw new Error('expected a text info output');
    // …and the views differ, or there would be nothing to look around.
    expect(new Set(frames.map((f) => f.data.join(','))).size).toBeGreaterThan(1);
    // The faces really do come out in different colours: at a three-quarter
    // view, three faces are visible and each is a different hue.
    const centre = frames[4];
    const hues = new Set<string>();
    for (let i = 0; i < centre.data.length; i += 4) {
      const [r, g, b] = [centre.data[i], centre.data[i + 1], centre.data[i + 2]];
      if (r > 250 && g > 250 && b > 250) continue; // the white sheet behind
      hues.add(`${Math.round(r / 32)},${Math.round(g / 32)},${Math.round(b / 32)}`);
    }
    expect(hues.size).toBeGreaterThanOrEqual(3);

    const printed = await getNodeDef('lensGrid').compute(
      ctx(
        { views: rendered.views },
        // Smaller and coarser than the example ships, to keep this a unit test —
        // but still 13 px across a lenslet, so the lens is not terraced.
        { ...graph.nodes[2].config, widthMm: 50, ppi: 600 },
      ),
    );
    expect((printed.depth as RasterImage).width).toBe(1181); // 50 mm at 600 PPI
    if (printed.info?.kind === 'text') expect(printed.info.text).not.toContain('⚠');
    else throw new Error('expected a text info output');
  });
});
