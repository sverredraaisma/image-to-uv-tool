import { describe, it, expect } from 'vitest';
import { resizeNode } from './local';
import { createImage } from '../lib/image';
import type { ComputeContext, NodeConfig, RasterImage } from '../types';

async function run(img: RasterImage, config: NodeConfig): Promise<RasterImage> {
  const ctx = {
    inputs: { in: img },
    config,
    apiKey: null,
    openRouterKey: null,
    proxyUrl: null,
  } as ComputeContext;
  const res = await resizeNode.compute(ctx);
  return res.out as RasterImage;
}

describe('resize node', () => {
  it('scale mode multiplies both axes, keeping the aspect ratio', async () => {
    const img = createImage(4, 2, [10, 20, 30, 255]); // 2:1
    const out = await run(img, { mode: 'scale', scale: 2, method: 'nearest' });
    expect([out.width, out.height]).toEqual([8, 4]); // still 2:1
  });

  it('scale mode rounds and clamps to at least 1px', async () => {
    const img = createImage(3, 3, [0, 0, 0, 255]);
    const out = await run(img, { mode: 'scale', scale: 0.1, method: 'nearest' }); // 0.3 → 1
    expect([out.width, out.height]).toEqual([1, 1]);
  });

  it('dimensions mode still uses exact width/height (back-compat)', async () => {
    const img = createImage(4, 4, [0, 0, 0, 255]);
    const out = await run(img, { mode: 'dimensions', width: 7, height: 3, method: 'nearest' });
    expect([out.width, out.height]).toEqual([7, 3]);
  });

  it('a legacy config with no mode defaults to exact dimensions', async () => {
    const img = createImage(4, 4, [0, 0, 0, 255]);
    const out = await run(img, { width: 5, height: 6, method: 'nearest' });
    expect([out.width, out.height]).toEqual([5, 6]);
  });
});
