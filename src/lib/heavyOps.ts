// Registry of the CPU-heavy, pure image ops keyed by name, so they can run
// either synchronously on the main thread or off it in a Web Worker with an
// identical result. Worker-safe: only imports pure code (image.ts + helpers).

import type { NodeConfig, RasterImage } from '../types';
import { num, str } from '../nodes/helpers';
import {
  boxBlur,
  hexToRgba,
  morphology,
  normalMap,
  outline,
  pixelate,
  posterize,
  rotate,
  seamlessTile,
  sharpen,
  sobel,
  vignette,
} from './image';

export type HeavyOp = (img: RasterImage, config: NodeConfig) => RasterImage;

// Param extraction MUST match the corresponding node's inline op exactly so the
// offloaded result is identical to the synchronous one.
export const HEAVY_OPS: Record<string, HeavyOp> = {
  blur: (img, c) => boxBlur(img, num(c.radius, 2)),
  sharpen: (img, c) => sharpen(img, num(c.amount, 1)),
  dilate: (img, c) => morphology(img, num(c.radius, 2), 'dilate'),
  erode: (img, c) => morphology(img, num(c.radius, 2), 'erode'),
  edgeDetect: (img) => sobel(img),
  normalMap: (img, c) => normalMap(img, num(c.strength, 2)),
  pixelate: (img, c) => pixelate(img, num(c.blockSize, 8)),
  vignette: (img, c) => vignette(img, num(c.strength, 0.5)),
  posterize: (img, c) => posterize(img, num(c.levels, 4)),
  seamlessTile: (img, c) => seamlessTile(img, num(c.feather, 0.5)),
  rotateAngle: (img, c) => rotate(img, num(c.degrees, 45)),
  outline: (img, c) =>
    outline(img, num(c.thickness, 4), hexToRgba(str(c.color, '#000000'), 255), num(c.alphaThreshold, 0)),
};

export function runHeavyOp(name: string, img: RasterImage, config: NodeConfig): RasterImage {
  const op = HEAVY_OPS[name];
  if (!op) throw new Error(`Unknown image op: ${name}`);
  return op(img, config);
}
