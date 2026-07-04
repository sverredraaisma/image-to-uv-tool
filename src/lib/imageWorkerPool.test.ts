import { describe, it, expect } from 'vitest';
import { createImageWorkerPool } from './imageWorkerPool';
import { runHeavyOp } from './heavyOps';
import { createImage } from './image';
import type { NodeConfig, RasterImage } from '../types';

// Reproduce exactly what imageOp.worker.ts does across the postMessage boundary:
// a copy of the pixels is transferred in, the op runs on a view of that buffer,
// and the result buffer is transferred back and re-wrapped on the main thread.
function simulateWorkerRoundTrip(name: string, img: RasterImage, config: NodeConfig): RasterImage {
  const copy = new Uint8ClampedArray(img.data); // caller's copy (source stays intact)
  const inBuffer = copy.buffer;
  // --- worker side ---
  const inImg: RasterImage = {
    kind: 'image',
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(inBuffer),
  };
  const out = runHeavyOp(name, inImg, config);
  const outBuffer = out.data.buffer;
  // --- main side re-wraps the transferred result ---
  return { kind: 'image', width: out.width, height: out.height, data: new Uint8ClampedArray(outBuffer) };
}

describe('image worker offload', () => {
  const img = createImage(6, 6, [90, 140, 60, 255]);
  img.data.set([255, 255, 255, 255], (3 * 6 + 3) * 4);

  it('the transfer round-trip yields pixels identical to the synchronous op', () => {
    for (const [name, cfg] of [
      ['blur', { radius: 2 }],
      ['edgeDetect', {}],
      ['normalMap', { strength: 3 }],
      ['dilate', { radius: 1 }],
    ] as [string, NodeConfig][]) {
      const viaWorker = simulateWorkerRoundTrip(name, img, cfg);
      const sync = runHeavyOp(name, img, cfg);
      expect([...viaWorker.data]).toEqual([...sync.data]);
      expect([viaWorker.width, viaWorker.height]).toEqual([sync.width, sync.height]);
    }
  });

  it('does not detach the caller source image', () => {
    const before = [...img.data];
    simulateWorkerRoundTrip('blur', img, { radius: 2 });
    expect([...img.data]).toEqual(before); // source untouched (we transferred a copy)
  });

  it('the pool falls back to a correct synchronous result when workers are unavailable', async () => {
    const run = createImageWorkerPool(); // jsdom has no Worker → sync fallback
    const out = await run('blur', img, { radius: 2 });
    expect([...out.data]).toEqual([...runHeavyOp('blur', img, { radius: 2 }).data]);
  });
});
