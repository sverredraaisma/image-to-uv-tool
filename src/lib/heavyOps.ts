// Registry of the CPU-heavy, pure image ops keyed by name, so they can run
// either synchronously on the main thread or off it in a Web Worker with an
// identical result. Worker-safe: only imports pure code (image.ts + helpers).

import type { NodeConfig, RasterImage } from '../types';
import { bool, num, str } from '../nodes/helpers';
import {
  autoThreshold,
  boxBlur,
  despeckle,
  hexToRgba,
  highlightExtract,
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
  type AutoThresholdMode,
  type MorphOp,
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
  morphology: (img, c) => morphology(img, num(c.radius, 2), str(c.op, 'close') as MorphOp),
  highlightExtract: (img, c) =>
    highlightExtract(img, {
      radius: num(c.radius, 24),
      satRejection: num(c.satRejection, 2),
      gain: num(c.gain, 1),
      bias: num(c.bias, 4),
    }),
  autoThreshold: (img, c) =>
    autoThreshold(img, {
      mode: str(c.mode, 'otsu') as AutoThresholdMode,
      percentile: num(c.percentile, 20),
      invert: bool(c.invert, false),
    }),
  despeckle: (img, c) =>
    despeckle(img, {
      minArea: num(c.minArea, 9),
      minHoleArea: num(c.minHoleArea, 0),
      threshold: num(c.threshold, 128),
    }),
};

export function runHeavyOp(name: string, img: RasterImage, config: NodeConfig): RasterImage {
  const op = HEAVY_OPS[name];
  if (!op) throw new Error(`Unknown image op: ${name}`);
  return op(img, config);
}
