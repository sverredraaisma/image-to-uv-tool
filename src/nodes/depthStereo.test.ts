import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import {
  depthEyeOffsets,
  depthStereoNode,
  depthViewOptionsFromConfig,
  describeDepthViews,
} from './depthStereo';
import { getNodeDef } from '../engine/registry';
import { nodePorts } from '../engine/ports';
import { mapsSequencesByDefault } from '../engine/sequenceMap';
import { renderDepthViews } from '../lib/depthViews';
import { createImage } from '../lib/image';
import type { ComputeContext, DataValue, RasterImage, SequenceValue } from '../types';

const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

const config = (over: Record<string, unknown> = {}) => ({
  ...depthStereoNode.defaultConfig(),
  views: 3,
  ...over,
});

/** A small picture with a near bar on a far ground, and its heightmap. */
function scene(w = 48, h = 4): { image: RasterImage; depth: RasterImage } {
  const image = createImage(w, h, [20, 20, 20, 255]);
  const depth = createImage(w, h, [0, 0, 0, 255]);
  for (let y = 0; y < h; y++) {
    for (let x = Math.floor(w / 3); x < Math.floor((2 * w) / 3); x++) {
      const i = (y * w + x) * 4;
      image.data[i] = image.data[i + 1] = image.data[i + 2] = 255;
      depth.data[i] = depth.data[i + 1] = depth.data[i + 2] = 255;
    }
  }
  return { image, depth };
}

const seq = (v: DataValue | undefined) => v as SequenceValue;

describe('Image + Depth → Stereo Views', () => {
  it('is registered, manual, and puts the whole run on one wire', () => {
    expect(getNodeDef('depthStereo')).toBe(depthStereoNode);
    expect(depthStereoNode.autoRun).toBe(false);
    const { inputs, outputs } = nodePorts({ type: 'depthStereo', config: config() }, depthStereoNode);
    expect(inputs.map((p) => p.id)).toEqual(['image', 'depth']);
    expect(inputs.every((p) => p.required)).toBe(true);
    expect(outputs.map((p) => p.id)).toEqual(['views', 'depth', 'info']);
    expect(outputs[0].type).toBe('sequence');
  });

  it('is not run once per frame — it produces the sequence itself', () => {
    const def = getNodeDef('depthStereo');
    const ports = nodePorts({ type: 'depthStereo', config: config() }, def);
    expect(mapsSequencesByDefault(def, ports)).toBe(false);
  });

  it('needs both a picture and a heightmap', async () => {
    const { image, depth } = scene();
    await expect(depthStereoNode.compute(ctx({ depth }, config()))).rejects.toThrow(/Connect a picture/);
    await expect(depthStereoNode.compute(ctx({ image }, config()))).rejects.toThrow(/Connect a heightmap/);
  });

  it('warps the run and hands back the depth map it actually used', async () => {
    const { image, depth } = scene();
    const out = await depthStereoNode.compute(ctx({ image, depth }, config({ views: 5 })));
    const views = seq(out.views);
    expect(views.kind).toBe('sequence');
    expect(views.frames).toHaveLength(5);
    for (const f of views.frames) {
      expect(f.width).toBe(image.width);
      expect(f.height).toBe(image.height);
    }
    const used = out.depth as RasterImage;
    expect(used.width).toBe(image.width);
    // Blurred by the 1 px default, so it is no longer the input verbatim.
    expect([...used.data]).not.toEqual([...depth.data]);
  });

  it('sends the views out right-eye-first, because the lens inverts them', async () => {
    const { image, depth } = scene();
    const mirrored = seq(
      (await depthStereoNode.compute(ctx({ image, depth }, config({ mirrorViews: true })))).views,
    );
    const raw = seq(
      (await depthStereoNode.compute(ctx({ image, depth }, config({ mirrorViews: false })))).views,
    );
    expect([...mirrored.frames[0].data]).toEqual([...raw.frames[2].data]);
    expect([...mirrored.frames[2].data]).toEqual([...raw.frames[0].data]);
    // …and the middle view is the source untouched either way.
    expect([...raw.frames[1].data]).toEqual([...image.data]);
  });

  it('respects an explicit view width, and keeps the source width at 0', async () => {
    const { image, depth } = scene(64, 32);
    const own = seq((await depthStereoNode.compute(ctx({ image, depth }, config()))).views);
    expect(own.frames[0].width).toBe(64);
    const sized = seq((await depthStereoNode.compute(ctx({ image, depth }, config({ viewPx: 128 })))).views);
    expect(sized.frames[0].width).toBe(128);
    expect(sized.frames[0].height).toBe(64);
  });

  it('passes the edge threshold through, and says so in the report', () => {
    const { image, depth } = scene();
    expect(depthViewOptionsFromConfig(config()).edgeJumpPx).toBe(1.5);
    const cfg = config({ views: 3, edgeJumpPx: 4 });
    const o = depthViewOptionsFromConfig(cfg);
    expect(o.edgeJumpPx).toBe(4);
    expect(describeDepthViews(cfg, o, renderDepthViews(image, depth, o))).toMatch(
      /a run stretching more than 4\.0 px across ±3 px counts as an edge/,
    );
  });

  it('reads the cone from the lens, or by hand', () => {
    const fromLens = depthViewOptionsFromConfig(config({ coneMode: 'lens', lpi: 45 }));
    expect(fromLens.coneDeg).toBeGreaterThan(1);
    const byHand = depthViewOptionsFromConfig(config({ coneMode: 'manual', coneDeg: 40 }));
    expect(byHand.coneDeg).toBe(40);
    expect(depthEyeOffsets(byHand)).toHaveLength(byHand.views);
  });

  it('clamps the run to a sane number of views and a sane pop-out', () => {
    expect(depthViewOptionsFromConfig(config({ views: 1 })).views).toBe(2);
    expect(depthViewOptionsFromConfig(config({ views: 999 })).views).toBe(32);
    expect(depthViewOptionsFromConfig(config({ setbackMm: -5000, viewDistanceMm: 400 })).setbackMm).toBe(
      -100,
    );
  });

  it('reports the parallax, the placement and what it had to invent', () => {
    const { image, depth } = scene();
    const o = depthViewOptionsFromConfig(config({ views: 4 }));
    const render = renderDepthViews(image, depth, o);
    const text = describeDepthViews(config({ views: 4 }), o, render);
    expect(text).toMatch(/4 views/);
    expect(text).toMatch(/Window/);
    expect(text).toMatch(/lenslets per view step/);
    expect(text).toMatch(/Invented [\d.]+% of each view/);
  });

  it('warns when the depth range asks for more than a relief can give', () => {
    const { image, depth } = scene();
    const cfg = config({ views: 4, depthMm: 120, coneMode: 'manual', coneDeg: 60 });
    const o = depthViewOptionsFromConfig(cfg);
    const text = describeDepthViews(cfg, o, renderDepthViews(image, depth, o));
    expect(text).toMatch(/⚠ [\d.]+% of the frame is invented/);
    expect(text).toMatch(/double rather than soften|read as haze/);
  });

  it('warns when there is barely any parallax to print', () => {
    const { image, depth } = scene();
    const cfg = config({ views: 4, depthMm: 0.05 });
    const o = depthViewOptionsFromConfig(cfg);
    const text = describeDepthViews(cfg, o, renderDepthViews(image, depth, o));
    expect(text).toMatch(/the print will look flat/);
  });
});
