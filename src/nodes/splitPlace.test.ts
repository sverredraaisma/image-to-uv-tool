import { describe, it, expect } from 'vitest';
import { splitRegionNode, placeImageNode } from './local';
import { createImage } from '../lib/image';
import type { ComputeContext, DataValue, RasterImage } from '../types';

// These nodes are pure (no platform / network), so drive compute() directly.
const ctx = (inputs: Record<string, DataValue | undefined>, config: Record<string, unknown>) =>
  ({ inputs, config }) as unknown as ComputeContext;

const px = (img: RasterImage, x: number, y: number) => {
  const i = (y * img.width + x) * 4;
  return [img.data[i], img.data[i + 1], img.data[i + 2], img.data[i + 3]];
};

describe('Split Region node', () => {
  it('crops the region and reports its clamped coordinates + size', async () => {
    const img = createImage(8, 8, [255, 0, 0, 255]);
    const out = await splitRegionNode.compute(ctx({ in: img }, { x: 2, y: 3, width: 4, height: 2 }));
    const region = out.out as RasterImage;
    expect(region.width).toBe(4);
    expect(region.height).toBe(2);
    expect(out.coords?.kind).toBe('text');
    if (out.coords?.kind === 'text') {
      expect(JSON.parse(out.coords.text)).toEqual({ x: 2, y: 3, width: 4, height: 2 });
    }
  });

  it('clamps an oversized rectangle and reports the actual size', async () => {
    const img = createImage(8, 8, [255, 255, 255, 255]);
    const out = await splitRegionNode.compute(ctx({ in: img }, { x: 6, y: 6, width: 10, height: 10 }));
    if (out.coords?.kind === 'text') {
      expect(JSON.parse(out.coords.text)).toEqual({ x: 6, y: 6, width: 2, height: 2 });
    }
  });
});

describe('Place Image node', () => {
  it('composites the overlay at the coords from Split Region (round-trip)', async () => {
    const base = createImage(8, 8, [255, 0, 0, 255]); // red
    // Simulate a processed 4×2 region that will be placed back at (2,3).
    const overlay = createImage(4, 2, [0, 0, 255, 255]); // blue
    const coords: DataValue = { kind: 'text', text: JSON.stringify({ x: 2, y: 3, width: 4, height: 2 }) };
    const out = await placeImageNode.compute(ctx({ base, overlay, coords }, {}));
    const img = out.out as RasterImage;
    expect(px(img, 3, 3)).toEqual([0, 0, 255, 255]); // inside the placed region → blue
    expect(px(img, 0, 0)).toEqual([255, 0, 0, 255]); // outside → still red
    expect(px(img, 6, 6)).toEqual([255, 0, 0, 255]);
  });

  it('scales the overlay to the coords size', async () => {
    const base = createImage(10, 10, [0, 0, 0, 255]);
    const overlay = createImage(2, 2, [255, 255, 255, 255]); // small
    const coords: DataValue = { kind: 'text', text: JSON.stringify({ x: 0, y: 0, width: 6, height: 6 }) };
    const out = await placeImageNode.compute(ctx({ base, overlay, coords }, {}));
    const img = out.out as RasterImage;
    expect(px(img, 3, 3)).toEqual([255, 255, 255, 255]); // within scaled 6×6 → white
    expect(px(img, 8, 8)).toEqual([0, 0, 0, 255]); // outside → black
  });

  it('falls back to manual x/y config when no coords are wired', async () => {
    const base = createImage(6, 6, [0, 0, 0, 255]);
    const overlay = createImage(2, 2, [0, 255, 0, 255]);
    const out = await placeImageNode.compute(ctx({ base, overlay }, { x: 1, y: 1, width: 0, height: 0 }));
    const img = out.out as RasterImage;
    expect(px(img, 1, 1)).toEqual([0, 255, 0, 255]);
    expect(px(img, 0, 0)).toEqual([0, 0, 0, 255]);
  });

  it('returns nothing until both base and overlay are present', async () => {
    const base = createImage(4, 4, [0, 0, 0, 255]);
    expect((await placeImageNode.compute(ctx({ base }, {}))).out).toBeUndefined();
  });
});
