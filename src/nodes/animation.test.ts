import { describe, it, expect, beforeEach } from 'vitest';
import { animationInputNode, frameSelectNode } from './animation';
import { lenticularNode } from './lenticular';
import { asImage, asImages, asSequence } from './helpers';
import { isCompatible } from '../engine/compatibility';
import { bypassOutputs } from '../engine/schedule';
import { setPlatform } from '../lib/platform';
import { createImage } from '../lib/image';
import type { ComputeContext, DataValue, RasterImage, SequenceValue } from '../types';

const ctx = (inputs: Record<string, DataValue | DataValue[] | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

const frame = (red: number, size = 8): RasterImage => createImage(size, size, [red, 0, 0, 255]);

/** A stand-in decoder: `n` frames whose red channel counts 0,1,2,… */
function fakeDecoder(n: number, size = 8) {
  return {
    decodeAnimation: async () => ({
      width: size,
      height: size,
      frames: Array.from({ length: n }, (_, i) => ({ image: frame(i, size), delayMs: 40 })),
    }),
    getBlob: async () => null,
  };
}

const config = (over: Record<string, unknown> = {}) => ({
  ...animationInputNode.defaultConfig(),
  src: 'data:image/gif;base64,fake',
  ...over,
});

const reds = (frames: RasterImage[]) => frames.map((f) => f.data[0]);

describe('Animation Input node', () => {
  beforeEach(() => setPlatform(fakeDecoder(8)));

  it('outputs every shaped frame as one sequence, plus the first frame', async () => {
    const out = await animationInputNode.compute(ctx({}, config({ frameCount: 4 })));
    const seq = out.frames as SequenceValue;
    expect(seq.kind).toBe('sequence');
    expect(reds(seq.frames)).toEqual([0, 2, 4, 6]);
    expect(seq.delaysMs).toEqual([40, 40, 40, 40]);
    expect(out.first).toBe(seq.frames[0]);
  });

  it('keeps every frame when the count is 0', async () => {
    const out = await animationInputNode.compute(ctx({}, config({ frameCount: 0 })));
    expect((out.frames as SequenceValue).frames).toHaveLength(8);
  });

  it('ping-pongs and repeats so tilting never snaps back', async () => {
    const out = await animationInputNode.compute(
      ctx({}, config({ frameCount: 4, loop: 'pingpong', cycles: 2 })),
    );
    expect(reds((out.frames as SequenceValue).frames)).toEqual([0, 2, 4, 6, 4, 2, 0, 2, 4, 6, 4, 2]);
  });

  it('downscales frames to the working resolution', async () => {
    setPlatform(fakeDecoder(4, 64));
    const out = await animationInputNode.compute(ctx({}, config({ frameCount: 0, maxSize: 16 })));
    for (const f of (out.frames as SequenceValue).frames) expect(f.width).toBe(16);
  });

  it('reports the frame budget of a lenticule in its info text', async () => {
    const out = await animationInputNode.compute(ctx({}, config({ frameCount: 0, ppi: 1440, lpi: 45 })));
    const text = (out.info as { text: string }).text;
    expect(text).toContain('Source: 8 frames');
    expect(text).toContain('32 frames fit per lenticule');
  });

  it('outputs nothing until a file is uploaded', async () => {
    const out = await animationInputNode.compute(ctx({}, config({ src: '', srcRef: '' })));
    expect(out.frames).toBeUndefined();
    expect(out.first).toBeUndefined();
  });

  it('resolves an out-of-band blob reference like Image Input does', async () => {
    let asked: string | null = null;
    setPlatform({
      ...fakeDecoder(3),
      getBlob: async (ref: string) => {
        asked = ref;
        return 'data:image/gif;base64,stored';
      },
    });
    const out = await animationInputNode.compute(ctx({}, config({ src: '', srcRef: 'blob_abc123' })));
    expect(asked).toBe('blob_abc123');
    expect((out.frames as SequenceValue).frames).toHaveLength(3);
  });
});

describe('Sequence Frame node', () => {
  const seq: SequenceValue = { kind: 'sequence', frames: [frame(0), frame(1), frame(2)] };

  it('pulls out the indexed frame', () => {
    expect(
      (frameSelectNode.compute(ctx({ in: seq }, { index: 1 })) as { out: RasterImage }).out.data[0],
    ).toBe(1);
  });

  it('counts negative indices from the end and clamps out-of-range ones', () => {
    const at = (index: number) =>
      (frameSelectNode.compute(ctx({ in: seq }, { index })) as { out: RasterImage }).out.data[0];
    expect(at(-1)).toBe(2);
    expect(at(-3)).toBe(0);
    expect(at(99)).toBe(2);
    expect(at(-99)).toBe(0);
  });

  it('accepts a lone image as a one-frame sequence, and empty input as nothing', () => {
    const out = frameSelectNode.compute(ctx({ in: frame(7) }, { index: 0 })) as { out: RasterImage };
    expect(out.out.data[0]).toBe(7);
    const empty = frameSelectNode.compute(ctx({ in: undefined }, { index: 0 })) as { out?: RasterImage };
    expect(empty.out).toBeUndefined();
  });
});

describe('sequences on ports', () => {
  const seq: SequenceValue = { kind: 'sequence', frames: [frame(0), frame(1)] };

  it('connects to and from image ports in both directions', () => {
    expect(isCompatible('sequence', 'image')).toBe(true);
    expect(isCompatible('sequence', 'mask')).toBe(true);
    expect(isCompatible('image', 'sequence')).toBe(true);
    expect(isCompatible('sequence', 'text')).toBe(false);
    expect(isCompatible('text', 'sequence')).toBe(false);
  });

  it('collapses to the first frame for single-image nodes and expands for multi', () => {
    expect(asImage(seq)?.data[0]).toBe(0);
    expect(reds(asImages(seq))).toEqual([0, 1]);
    expect(reds(asImages([frame(9), seq]))).toEqual([9, 0, 1]);
    expect(asSequence(frame(5))?.frames).toHaveLength(1);
    expect(asSequence(seq)).toBe(seq);
    expect(asSequence({ kind: 'text', text: 'x' })).toBeUndefined();
  });

  it('passes through a bypassed node on either port type', () => {
    const image = [{ id: 'out', label: 'Image', type: 'image' as const }];
    const sequence = [{ id: 'out', label: 'Frames', type: 'sequence' as const }];
    const inputs = [{ id: 'in', label: 'In', type: 'sequence' as const }];
    expect(bypassOutputs(inputs, image, { in: seq }).out).toBe(seq);
    expect(bypassOutputs(inputs, sequence, { in: frame(3) }).out?.kind).toBe('image');
  });
});

describe('an animation wired into the Lenticular Print node', () => {
  it('interlaces the sequence frames straight off one wire', async () => {
    setPlatform(fakeDecoder(4, 20));
    const animation = await animationInputNode.compute(ctx({}, config({ frameCount: 0 })));

    const print = await lenticularNode.compute(
      ctx(
        // A `multiple` port hands compute an array — here holding one sequence.
        { frames: [animation.frames as DataValue] },
        { ...lenticularNode.defaultConfig(), widthMm: 25.4, ppi: 100, lpi: 10, heightMm: 5 },
      ),
    );
    expect((print.interlaced as RasterImage).width).toBeGreaterThan(0);
    // The info text names the frame count it actually interlaced.
    expect((print.info as { text: string }).text).toContain('4');
  });

  it('still refuses a single-frame animation', async () => {
    setPlatform(fakeDecoder(1, 20));
    const animation = await animationInputNode.compute(ctx({}, config({ frameCount: 0 })));
    await expect(
      lenticularNode.compute(
        ctx({ frames: [animation.frames as DataValue] }, lenticularNode.defaultConfig()),
      ),
    ).rejects.toThrow(/at least 2 images/);
  });
});
