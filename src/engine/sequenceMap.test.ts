import { describe, it, expect, vi } from 'vitest';
import '../nodes'; // register built-ins
import { getNodeDef } from './registry';
import { nodePorts } from './ports';
import { MAX_MAPPED_FRAMES, computeMaybeMapped, mapsSequences, mapsSequencesByDefault } from './sequenceMap';
import { createImage } from '../lib/image';
import type {
  ComputeContext,
  DataValue,
  NodeConfig,
  NodeDefinition,
  RasterImage,
  SequenceValue,
} from '../types';

const ctx = (inputs: Record<string, DataValue | undefined>, config: NodeConfig = {}): ComputeContext =>
  ({ inputs, config }) as unknown as ComputeContext;

/** The resolved ports of a registered node, at its own defaults. */
const portsOf = (type: string) => {
  const def = getNodeDef(type);
  return { def, ports: nodePorts({ type, config: def.defaultConfig() }, def) };
};

const grey = (v: number, w = 4, h = 4): RasterImage => createImage(w, h, [v, v, v, 255]);
const seq = (values: number[], delaysMs?: number[]): SequenceValue => ({
  kind: 'sequence',
  frames: values.map((v) => grey(v)),
  delaysMs,
});
const firstPixel = (img: RasterImage) => img.data[0];

describe('which nodes map over a sequence', () => {
  it('maps an ordinary image op — image in, image out', () => {
    for (const type of ['invert', 'blur', 'levels', 'grayscale', 'combine', 'applyMask']) {
      const { def, ports } = portsOf(type);
      expect(mapsSequencesByDefault(def, ports), type).toBe(true);
    }
  });

  it('leaves nodes that already speak Sequence alone', () => {
    // A sequence port in either direction, or a `multiple` image input that
    // collects frames itself — mapping these would run the whole job per frame.
    for (const type of ['frameSelect', 'lensGrid', 'radialGrid', 'lenticular', 'modelViews', 'modelStereo']) {
      const { def, ports } = portsOf(type);
      expect(mapsSequencesByDefault(def, ports), type).toBe(false);
    }
  });

  it('leaves a pipeline to its own inner nodes', () => {
    const def = getNodeDef('pipeline');
    const ports = nodePorts(
      { type: 'pipeline', config: { inputs: [{ id: 'in', label: 'In', type: 'image' }], outputs: [] } },
      def,
    );
    expect(mapsSequencesByDefault(def, ports)).toBe(false);
  });

  it('leaves nodes with no image to map, or nothing image-shaped to give back', () => {
    for (const type of ['imageInput', 'solidColor', 'promptInput', 'heightmapStl']) {
      const { def, ports } = portsOf(type);
      expect(mapsSequencesByDefault(def, ports), type).toBe(false);
    }
  });

  it('lets a paid AI node decide from its own config, and defaults to no', () => {
    const { def, ports } = portsOf('fluxKontext');
    // Image in, image out — it would map by default, which is exactly why it
    // opts out: one prediction per frame is one charge per frame.
    expect(mapsSequencesByDefault(def, ports)).toBe(true);
    expect(mapsSequences(def, ports, def.defaultConfig())).toBe(false);
    expect(mapsSequences(def, ports, { ...def.defaultConfig(), mapFrames: true })).toBe(true);
  });
});

describe('mapping a node over the frames', () => {
  const invert = () => portsOf('invert');

  it('runs once per frame and bundles the images back into a sequence', async () => {
    const { def, ports } = invert();
    const out = await computeMaybeMapped(def, ports, ctx({ in: seq([0, 100, 255]) }));
    const result = out.out as SequenceValue;
    expect(result.kind).toBe('sequence');
    expect(result.frames.map(firstPixel)).toEqual([255, 155, 0]);
  });

  it('does nothing at all when no sequence is wired in', async () => {
    const { def, ports } = invert();
    const out = await computeMaybeMapped(def, ports, ctx({ in: grey(10) }));
    expect((out.out as RasterImage).kind).toBe('image');
    expect(firstPixel(out.out as RasterImage)).toBe(245);
  });

  it('carries the frame timings, so a GIF keeps its pacing down the chain', async () => {
    const { def, ports } = invert();
    const out = await computeMaybeMapped(def, ports, ctx({ in: seq([0, 128], [40, 90]) }));
    expect((out.out as SequenceValue).delaysMs).toEqual([40, 90]);
  });

  it('reuses a still for every frame, which is what composites an overlay onto a GIF', async () => {
    const { def, ports } = portsOf('combine');
    const out = await computeMaybeMapped(
      def,
      ports,
      ctx({ a: seq([0, 60, 120]), b: grey(10) }, { ...def.defaultConfig(), mode: 'add' }),
    );
    const frames = (out.out as SequenceValue).frames;
    expect(frames).toHaveLength(3);
    expect(frames.map(firstPixel)).toEqual([10, 70, 130]);
  });

  it('holds a shorter sequence on its last frame rather than running out', async () => {
    const { def, ports } = portsOf('combine');
    const out = await computeMaybeMapped(
      def,
      ports,
      ctx({ a: seq([0, 0, 0]), b: seq([5, 9]) }, { ...def.defaultConfig(), mode: 'add' }),
    );
    expect((out.out as SequenceValue).frames.map(firstPixel)).toEqual([5, 9, 9]);
  });

  it('reports which frame it is on, without silencing the node', async () => {
    const progress: string[] = [];
    const def: NodeDefinition = {
      type: 'stub',
      label: 'Stub',
      category: 'Test',
      autoRun: true,
      inputs: [{ id: 'in', label: 'In', type: 'image' }],
      outputs: [{ id: 'out', label: 'Out', type: 'image' }],
      defaultConfig: () => ({}),
      compute: ({ inputs, onProgress }) => {
        onProgress?.('working');
        return { out: inputs.in as RasterImage };
      },
    };
    const ports = nodePorts({ type: 'stub', config: {} }, def);
    await computeMaybeMapped(def, ports, {
      ...ctx({ in: seq([1, 2]) }),
      onProgress: (m) => progress.push(m),
    });
    expect(progress).toEqual(['Frame 1/2', 'Frame 1/2 · working', 'Frame 2/2', 'Frame 2/2 · working']);
  });
});

describe('the awkward parts', () => {
  /** A node with one image output and one text output. */
  const reporter: NodeDefinition = {
    type: 'stubReport',
    label: 'Stub report',
    category: 'Test',
    autoRun: true,
    inputs: [{ id: 'in', label: 'In', type: 'image' }],
    outputs: [
      { id: 'out', label: 'Out', type: 'image' },
      { id: 'info', label: 'Info', type: 'text' },
    ],
    defaultConfig: () => ({}),
    compute: ({ inputs }) => {
      const img = inputs.in as RasterImage;
      return { out: img, info: { kind: 'text', text: `saw ${img.data[0]}` } };
    },
  };
  const reporterPorts = nodePorts({ type: 'stubReport', config: {} }, reporter);

  it('keeps the first frame of anything that is not an image', async () => {
    const out = await computeMaybeMapped(reporter, reporterPorts, ctx({ in: seq([7, 8, 9]) }));
    expect((out.out as SequenceValue).frames).toHaveLength(3);
    // One report describing the run, not three near-identical ones.
    expect(out.info).toEqual({ kind: 'text', text: 'saw 7' });
  });

  it('stops between frames when the run is cancelled', async () => {
    const controller = new AbortController();
    let calls = 0;
    const def: NodeDefinition = {
      ...reporter,
      compute: ({ inputs }) => {
        calls += 1;
        controller.abort();
        return { out: inputs.in as RasterImage };
      },
    };
    await expect(
      computeMaybeMapped(def, reporterPorts, {
        ...ctx({ in: seq([1, 2, 3]) }),
        signal: controller.signal,
      }),
    ).rejects.toThrow(/abort/i);
    expect(calls).toBe(1);
  });

  it('refuses a run long enough to be a mistake', async () => {
    const many: SequenceValue = {
      kind: 'sequence',
      frames: Array.from({ length: MAX_MAPPED_FRAMES + 1 }, () => grey(0)),
    };
    const compute = vi.fn();
    await expect(
      computeMaybeMapped({ ...reporter, compute }, reporterPorts, ctx({ in: many })),
    ).rejects.toThrow(new RegExp(`${MAX_MAPPED_FRAMES}`));
    expect(compute).not.toHaveBeenCalled();
  });

  it('drops the timings when a node skips frames, rather than mislabelling them', async () => {
    const patchy: NodeDefinition = {
      ...reporter,
      compute: ({ inputs }) => {
        const img = inputs.in as RasterImage;
        return { out: img.data[0] === 2 ? undefined : img };
      },
    };
    const out = await computeMaybeMapped(patchy, reporterPorts, ctx({ in: seq([1, 2, 3], [10, 20, 30]) }));
    const result = out.out as SequenceValue;
    expect(result.frames).toHaveLength(2);
    expect(result.delaysMs).toBeUndefined();
  });
});
