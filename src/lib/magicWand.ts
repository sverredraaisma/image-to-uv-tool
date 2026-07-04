// Contiguous magic-wand selection via flood fill. Pure and testable.

import type { RasterImage } from '../types';
import { createImage } from './image';

export interface Point {
  x: number;
  y: number;
}

/** Max per-channel RGB difference between two pixels at offsets. */
function colorDist(data: Uint8ClampedArray, i: number, j: number): number {
  return Math.max(
    Math.abs(data[i] - data[j]),
    Math.abs(data[i + 1] - data[j + 1]),
    Math.abs(data[i + 2] - data[j + 2]),
  );
}

/**
 * Flood-fill from each seed over pixels within `tolerance` of that seed's
 * colour (4-connected). Returns a boolean selection mask (length w*h).
 */
export function selectRegion(img: RasterImage, seeds: Point[], tolerance: number): Uint8Array {
  const { width: w, height: h, data } = img;
  const selected = new Uint8Array(w * h);
  for (const seed of seeds) {
    const sx = Math.round(seed.x);
    const sy = Math.round(seed.y);
    if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
    const seedIdx = (sy * w + sx) * 4;
    const stack: number[] = [sy * w + sx];
    // Per-seed visited guard so different seed colours don't block each other.
    const visited = new Uint8Array(w * h);
    while (stack.length) {
      const p = stack.pop()!;
      if (visited[p]) continue;
      visited[p] = 1;
      if (colorDist(data, p * 4, seedIdx) > tolerance) continue;
      selected[p] = 1;
      const x = p % w;
      const y = (p - x) / w;
      if (x > 0) stack.push(p - 1);
      if (x < w - 1) stack.push(p + 1);
      if (y > 0) stack.push(p - w);
      if (y < h - 1) stack.push(p + w);
    }
  }
  return selected;
}

/** Produce an opaque black/white mask image from a magic-wand selection. */
export function magicWandMask(img: RasterImage, seeds: Point[], tolerance: number): RasterImage {
  const selected = selectRegion(img, seeds, tolerance);
  const out = createImage(img.width, img.height, [0, 0, 0, 255]);
  for (let p = 0; p < selected.length; p++) {
    if (selected[p]) {
      out.data[p * 4] = 255;
      out.data[p * 4 + 1] = 255;
      out.data[p * 4 + 2] = 255;
    }
  }
  return out;
}
