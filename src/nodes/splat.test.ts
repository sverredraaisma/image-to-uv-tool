import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import {
  cameraFromConfig,
  describeCloud,
  isUnplaced,
  splatCameraNode,
  splatInputNode,
  splatViewsNode,
  viewCount,
} from './splat';
import { getNodeDef } from '../engine/registry';
import { nodePorts } from '../engine/ports';
import { isCompatible } from '../engine/compatibility';
import { mapsSequencesByDefault } from '../engine/sequenceMap';
import type { ComputeContext, DataValue, RasterImage, SequenceValue, SplatValue, TransformValue } from '../types';
// The source of the files whose import graph this suite pins. `?raw` keeps it
// to Vite's own loader rather than a Node filesystem call, so the test runs in
// the same jsdom environment as everything else here.
import splatNodeSource from './splat.ts?raw';
import nodeIndexSource from './index.ts?raw';
import settingsModalSource from '../components/SettingsModal.tsx?raw';
import cloudSource from '../lib/splat/cloud.ts?raw';

const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

/** A tiny cloud: four splats in a square, 400 mm in front of a camera at the origin. */
function cloud(): SplatValue {
  const pts = [
    [-10, 10, -400],
    [10, 10, -420],
    [-10, -10, -420],
    [10, -10, -400],
  ];
  const c: SplatValue = {
    kind: 'splat',
    count: 4,
    positions: new Float32Array(pts.flat()),
    scales: new Float32Array(pts.flatMap(() => [6, 6, 6])),
    rotations: new Float32Array(pts.flatMap(() => [0, 0, 0, 1])),
    colours: new Uint8ClampedArray(pts.flatMap(() => [30, 60, 90, 255])),
    name: 'test.ply',
  };
  return c;
}

const camera = (over: Partial<TransformValue> = {}): TransformValue => ({
  kind: 'transform',
  position: [0, 0, 0],
  rotationDeg: [0, 0, 0],
  scale: 1,
  ...over,
});

const viewsConfig = (over: Record<string, unknown> = {}) => ({
  ...splatViewsNode.defaultConfig(),
  views: 3,
  viewPx: 32,
  coneMode: 'manual',
  coneDeg: 20,
  ...over,
});

const seq = (v: DataValue | undefined) => v as SequenceValue;

describe('splat nodes', () => {
  it('registers all three, wired end to end by type', () => {
    expect(getNodeDef('splatInput')).toBe(splatInputNode);
    expect(getNodeDef('splatCamera')).toBe(splatCameraNode);
    expect(getNodeDef('splatViews')).toBe(splatViewsNode);
    // Cloud out of the input, into the camera and the renderer; camera out of
    // the camera node, into the renderer.
    expect(isCompatible('splat', 'splat')).toBe(true);
    expect(isCompatible('transform', 'transform')).toBe(true);
    // And neither pretends to be an image.
    expect(isCompatible('splat', 'image')).toBe(false);
    expect(isCompatible('image', 'transform')).toBe(false);
  });

  it('has the ports the chain needs', () => {
    const inPorts = nodePorts({ type: 'splatInput', config: {} }, splatInputNode);
    expect(inPorts.outputs.map((p) => p.type)).toEqual(['splat', 'text']);

    const camPorts = nodePorts({ type: 'splatCamera', config: {} }, splatCameraNode);
    expect(camPorts.inputs.map((p) => p.type)).toEqual(['splat']);
    expect(camPorts.outputs.map((p) => p.type)).toEqual(['transform', 'text']);
    expect(splatCameraNode.customEditor).toBe('splatCamera');

    const viewPorts = nodePorts({ type: 'splatViews', config: {} }, splatViewsNode);
    expect(viewPorts.inputs.map((p) => p.id)).toEqual(['splat', 'camera']);
    expect(viewPorts.outputs.map((p) => p.id)).toEqual(['views', 'depth', 'info']);
    expect(viewPorts.outputs[0].type).toBe('sequence');
    // Expensive, so it waits to be asked.
    expect(splatViewsNode.autoRun).toBe(false);
  });

  it('is not run once per frame — it produces the sequence itself', () => {
    const def = getNodeDef('splatViews');
    expect(mapsSequencesByDefault(def, nodePorts({ type: 'splatViews', config: {} }, def))).toBe(false);
  });

  // -- Input ---------------------------------------------------------------

  it('outputs nothing until a file is uploaded', async () => {
    const out = await splatInputNode.compute(ctx({}, splatInputNode.defaultConfig()));
    expect(out.out).toBeUndefined();
    expect(out.info).toBeUndefined();
  });

  it('reads an uploaded .splat through the lazy parser', async () => {
    // One splat, in the compact layout, as a base64 data URL — the shape the
    // upload button stores.
    const buf = new ArrayBuffer(32);
    const v = new DataView(buf);
    v.setFloat32(0, 1, true);
    v.setFloat32(12, 0.5, true);
    v.setUint8(27, 255);
    v.setUint8(28, 255);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
    const out = await splatInputNode.compute(
      ctx({}, { src: `data:application/octet-stream;base64,${b64}`, name: 'x.splat' }),
    );
    const c = out.out as SplatValue;
    expect(c.kind).toBe('splat');
    expect(c.count).toBe(1);
    expect(c.positions[0]).toBe(1);
  });

  it('says what a cloud is, and admits what it dropped', () => {
    const text = describeCloud({ ...cloud(), droppedCount: 500 });
    expect(text).toMatch(/4 splats/);
    expect(text).toMatch(/Bounds 20 × 20 × 20/);
    expect(text).toMatch(/Thinned by 500 splats/);
    expect(text).toMatch(/DC term only/);
  });

  // -- Camera --------------------------------------------------------------

  it('frames the whole cloud until it has been placed', () => {
    const cfg = splatCameraNode.defaultConfig();
    expect(isUnplaced(cfg)).toBe(true);
    const out = splatCameraNode.compute(ctx({ splat: cloud() }, cfg)) as Record<string, DataValue>;
    const cam = out.camera as TransformValue;
    expect(cam.kind).toBe('transform');
    expect(cam.scale).toBeGreaterThan(0);
    // Standing back on the +Z side of a scene that lies down −Z.
    expect(cam.position[2]).toBeGreaterThan(-410);
    expect((out.info as { text: string }).text).toMatch(/Framing the whole cloud/);
  });

  it('hands back exactly the placement its config describes', () => {
    const cfg = {
      ...splatCameraNode.defaultConfig(),
      posX: 1,
      posY: 2,
      posZ: 3,
      yaw: 45,
      pitch: -10,
      roll: 5,
      scale: 0.02,
    };
    expect(isUnplaced(cfg)).toBe(false);
    const out = splatCameraNode.compute(ctx({ splat: cloud() }, cfg)) as Record<string, DataValue>;
    expect(out.camera).toEqual({
      kind: 'transform',
      position: [1, 2, 3],
      rotationDeg: [-10, 45, 5],
      scale: 0.02,
    });
    expect(cameraFromConfig(cfg).scale).toBe(0.02);
    expect((out.info as { text: string }).text).toMatch(/2 units of the scene/);
  });

  it('needs a cloud to stand in', () => {
    expect(() => splatCameraNode.compute(ctx({}, splatCameraNode.defaultConfig()))).toThrow(/Connect a cloud/);
  });

  // -- Views ---------------------------------------------------------------

  it('needs a cloud to render', async () => {
    await expect(splatViewsNode.compute(ctx({}, viewsConfig()))).rejects.toThrow(/Connect a cloud/);
  });

  it('renders the run through the lazy renderer, and reports it', async () => {
    const out = await splatViewsNode.compute(ctx({ splat: cloud(), camera: camera() }, viewsConfig()));
    const views = seq(out.views);
    expect(views.kind).toBe('sequence');
    expect(views.frames).toHaveLength(3);
    expect(views.frames[0].width).toBe(32);
    expect((out.depth as RasterImage).kind).toBe('image');
    const text = (out.info as { text: string }).text;
    expect(text).toMatch(/3 views/);
    expect(text).toMatch(/scene units per mm/);
    expect(text).toMatch(/lenslets per view step/);
  });

  it('sends a run out right-eye-first, and a grid in cell order', async () => {
    const c = cloud();
    const mirrored = seq((await splatViewsNode.compute(ctx({ splat: c }, viewsConfig()))).views);
    const raw = seq(
      (await splatViewsNode.compute(ctx({ splat: c }, viewsConfig({ mirrorViews: false })))).views,
    );
    expect([...mirrored.frames[0].data]).toEqual([...raw.frames[2].data]);

    // A grid is never reversed — Lens Grid Print reads gridCells order and
    // inverts it itself.
    const grid = seq(
      (await splatViewsNode.compute(ctx({ splat: c }, viewsConfig({ layout: '2d', grid: 3 })))).views,
    );
    expect(grid.frames).toHaveLength(9);
  });

  it('counts views by layout', () => {
    const base = { layout: '1d' as const, views: 7, grid: 4 };
    expect(viewCount({ ...base } as never)).toBe(7);
    expect(viewCount({ ...base, layout: '2d' } as never)).toBe(16);
  });

  it('frames the cloud itself when no camera is wired', async () => {
    const out = await splatViewsNode.compute(ctx({ splat: cloud() }, viewsConfig()));
    // It renders rather than failing, and the report says where it put itself.
    expect(seq(out.views).frames).toHaveLength(3);
    expect((out.info as { text: string }).text).toMatch(/scene units per mm/);
  });

  it('warns when the cloud barely covers the sheet', async () => {
    // A camera a long way off makes the scene a speck.
    const far = camera({ position: [0, 0, 40000], scale: 100 });
    const out = await splatViewsNode.compute(ctx({ splat: cloud(), camera: far }, viewsConfig()));
    expect((out.info as { text: string }).text).toMatch(/⚠ The cloud covers only/);
  });

  it('flips the depth map on request', async () => {
    const c = cloud();
    const normal = (await splatViewsNode.compute(ctx({ splat: c, camera: camera() }, viewsConfig())))
      .depth as RasterImage;
    const flipped = (
      await splatViewsNode.compute(ctx({ splat: c, camera: camera() }, viewsConfig({ flipDepth: true })))
    ).depth as RasterImage;
    expect(flipped.data[0]).toBe(255 - normal.data[0]);
  });
});

describe('the splat code stays split out of the main bundle', () => {
  // The parser and the rasteriser are the two big modules here, and a graph
  // with no splat in it must not download either. Both are reached through
  // `await import(...)`, which Vite turns into separate chunks — but a single
  // top-level *value* import anywhere in the eager graph silently undoes that,
  // and nothing fails to tell you. So the invariant is asserted on the source.
  /** Every static import in a file, and whether it is type-only (so, erased). */
  const staticImports = (text: string) =>
    [...text.matchAll(/^\s*import\s+(type\s+)?[^;]*?from\s+'([^']+)'/gm)].map((m) => ({
      from: m[2],
      typeOnly: !!m[1],
    }));

  it('only ever reaches the parser or the renderer through a type, never a value', () => {
    // `import type` is erased before the bundler sees it, so it costs nothing
    // and is how the node file names SplatViewOptions. Dropping the `type`
    // keyword from that one line would pull the whole rasteriser into the entry
    // chunk and nothing else would complain — hence this test.
    for (const text of [splatNodeSource, nodeIndexSource]) {
      const heavy = staticImports(text).filter((i) => /splat\/(parse|render)/.test(i.from));
      expect(heavy.filter((i) => !i.typeOnly)).toEqual([]);
    }
  });

  it('reaches them through a dynamic import instead', () => {
    const text = splatNodeSource;
    expect(text).toMatch(/await import\('\.\.\/lib\/splat\/parse'\)/);
    expect(text).toMatch(/await import\('\.\.\/lib\/splat\/render'\)/);
  });

  it('keeps the editor behind React.lazy', () => {
    const modal = settingsModalSource;
    expect(modal).toMatch(/lazy\(\s*\(\)\s*=>\s*\n?\s*import\('\.\/SplatCameraEditor'\)/);
    const statics = [...modal.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);
    expect(statics.filter((s) => /SplatCameraEditor/.test(s))).toEqual([]);
  });

  it('shares only the small module between the eager and lazy halves', () => {
    // `cloud.ts` is imported eagerly by the nodes, so it must not drag either
    // heavy module in behind it.
    const heavy = staticImports(cloudSource).filter((i) => /parse|render/.test(i.from));
    expect(heavy.filter((i) => !i.typeOnly)).toEqual([]);
  });
});
