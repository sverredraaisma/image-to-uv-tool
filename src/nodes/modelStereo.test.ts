import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import {
  describeViewSequence,
  modelStereoNode,
  stereoEyeOffsets,
  viewSequenceOptionsFromConfig,
} from './modelStereo';
import { getNodeDef } from '../engine/registry';
import { nodePorts } from '../engine/ports';
import { disparityAtDepth, prepareVertices, projectToSheet, renderViewSequence } from '../lib/render3d';
import type { ComputeContext, DataValue, RasterImage, SequenceValue, StlValue } from '../types';

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
  ...modelStereoNode.defaultConfig(),
  views: 3,
  viewPx: 48,
  supersample: 1,
  ...over,
});

const options = (over: Record<string, unknown> = {}) => viewSequenceOptionsFromConfig(config(over));

describe('Model → Stereo Views', () => {
  it('is registered, manual, and outputs the whole run on one wire', () => {
    expect(getNodeDef('modelStereo')).toBe(modelStereoNode);
    expect(modelStereoNode.autoRun).toBe(false);
    const { inputs, outputs } = nodePorts({ type: 'modelStereo', config: config() }, modelStereoNode);
    expect(inputs.map((p) => p.id)).toEqual(['model', 'texture']);
    expect(outputs.map((p) => p.id)).toEqual(['views', 'depth', 'info']);
    expect(outputs[0].type).toBe('sequence');
  });

  it('needs a mesh', async () => {
    await expect(modelStereoNode.compute(ctx({}, config()))).rejects.toThrow(/Connect a mesh/);
  });

  it('renders one view per eye position, in eye order across the cone', async () => {
    const out = await modelStereoNode.compute(ctx({ model: TETRA }, config({ views: 5 })));
    const seq = out.views as SequenceValue;
    expect(seq.kind).toBe('sequence');
    expect(seq.frames).toHaveLength(5);
    const offsets = stereoEyeOffsets(options({ views: 5 }));
    expect(offsets).toHaveLength(5);
    // Symmetric about head-on, and the middle view is dead ahead.
    expect(offsets[2]).toBeCloseTo(0, 9);
    expect(offsets[0]).toBeCloseTo(-offsets[4], 9);
    expect(offsets[0]).toBeLessThan(0);
  });

  it('puts the whole subject behind the sheet — it is a window, not a pop-out', () => {
    const o = options({ depthMm: 6, setbackMm: 2 });
    const render = renderViewSequence(TETRA, o);
    expect(render.nearMm).toBe(2);
    expect(render.farMm).toBe(8);

    // The z the renderer actually projects: centred on 0 by prepareVertices,
    // scaled to depthMm, then offset. Nothing may end up in front of z = 0.
    const mesh = prepareVertices(TETRA, { ...o, fitAtZMm: -o.setbackMm });
    const zOffset = -(o.setbackMm + o.depthMm / 2);
    let nearest = -Infinity;
    let farthest = Infinity;
    for (let i = 2; i < mesh.verts.length; i += 3) {
      const z = mesh.verts[i] * mesh.zScale + zOffset;
      nearest = Math.max(nearest, z);
      farthest = Math.min(farthest, z);
    }
    expect(nearest).toBeLessThanOrEqual(1e-6); // nothing crosses the glass
    expect(nearest).toBeCloseTo(-2, 6); // the near face is the setback
    expect(farthest).toBeCloseTo(-8, 6); // and the far face is depth beyond it
  });

  it('scales the fit up so the subject still fills the window from behind it', () => {
    // A subject Z behind the window subtends D/(D+Z) of what it would at the
    // glass, so the fit has to grow by the reciprocal or the frame goes empty.
    const flat = prepareVertices(TETRA, { ...options(), fitAtZMm: 0 });
    const back = prepareVertices(TETRA, { ...options({ setbackMm: 100 }), fitAtZMm: -100 });
    const spanX = (m: { verts: Float32Array }) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < m.verts.length; i += 3) {
        lo = Math.min(lo, m.verts[i]);
        hi = Math.max(hi, m.verts[i]);
      }
      return hi - lo;
    };
    expect(spanX(back) / spanX(flat)).toBeCloseTo(500 / 400, 6);

    // And it lands back at the same size on the sheet once projected from the
    // centre eye — which is the whole point of compensating.
    const halfFlat = spanX(flat) / 2;
    const halfBack = spanX(back) / 2;
    expect(projectToSheet(halfBack, 0, -100, 0, 0, 400).X).toBeCloseTo(halfFlat, 6);
  });

  it('costs less parallax behind the sheet than the same depth in front of it', () => {
    const behind = disparityAtDepth(30, -10, 400, 45);
    const front = disparityAtDepth(30, 10, 400, 45);
    expect(behind.mm).toBeLessThan(front.mm);
    expect(behind.mm).toBeCloseTo((30 * 10) / 410, 9);
    expect(front.mm).toBeCloseTo((30 * 10) / 390, 9);
  });

  it('orders the views for the lens, and can be told not to', async () => {
    const lensOrder = await modelStereoNode.compute(ctx({ model: TETRA }, config({ views: 3 })));
    const rawOrder = await modelStereoNode.compute(
      ctx({ model: TETRA }, config({ views: 3, mirrorViews: false })),
    );
    const a = (lensOrder.views as SequenceValue).frames;
    const b = (rawOrder.views as SequenceValue).frames;
    // A lenticule shows its leftmost strip to an eye on the right, so the run
    // goes out reversed; the middle view is the same either way.
    expect(a[0].data).toEqual(b[2].data);
    expect(a[2].data).toEqual(b[0].data);
    expect(a[1].data).toEqual(b[1].data);
    // The outer views really do differ — otherwise there is no parallax to order.
    expect(a[0].data).not.toEqual(a[2].data);
  });

  it('outputs a depth map of the centre view, flippable', async () => {
    const out = await modelStereoNode.compute(ctx({ model: TETRA }, config()));
    const depth = out.depth as RasterImage;
    expect(depth.width).toBe(48);
    const flipped = await modelStereoNode.compute(ctx({ model: TETRA }, config({ flipDepth: true })));
    const other = flipped.depth as RasterImage;
    for (let i = 0; i < 40; i++) expect(other.data[i * 4]).toBe(255 - depth.data[i * 4]);
  });

  it('reports the window placement, the fit and the parallax', async () => {
    const out = await modelStereoNode.compute(ctx({ model: TETRA }, config({ depthMm: 5, setbackMm: 3 })));
    const info = out.info?.kind === 'text' ? out.info.text : '';
    expect(info).toContain('3 views');
    expect(info).toContain('the subject stands 3.0–8.0 mm behind the sheet');
    expect(info).toContain('Nothing crosses the plane');
    expect(info).toContain('Fitted at the near face');
    expect(info).toContain('lenslets per view step at the far face');
  });

  it('warns when the far face moves more than the lens can follow', () => {
    const o = options({ depthMm: 60, setbackMm: 20, views: 2 });
    const text = describeViewSequence(config({ depthMm: 60, setbackMm: 20, views: 2 }), o, TETRA, {
      views: [],
      offsetsMm: stereoEyeOffsets(o),
      depth: { kind: 'image', width: 1, height: 1, data: new Uint8ClampedArray(4) },
      coverage: 0.5,
      nearMm: 20,
      farMm: 80,
    });
    expect(text).toContain('⚠');
    expect(text).toContain('ghost rather than read as depth');
  });

  it('warns when there is nothing to see', () => {
    const o = options({ depthMm: 0, setbackMm: 0 });
    const text = describeViewSequence(config({ depthMm: 0 }), o, TETRA, {
      views: [],
      offsetsMm: stereoEyeOffsets(o),
      depth: { kind: 'image', width: 1, height: 1, data: new Uint8ClampedArray(4) },
      coverage: 0.5,
      nearMm: 0,
      farMm: 0.0001,
    });
    expect(text).toContain('the print will look flat');
  });
});
