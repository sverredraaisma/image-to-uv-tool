// Indirection layer so the engine/nodes can decode/encode/fetch images without
// depending directly on the DOM. The browser entry point installs the real
// canvas-based adapter (`lib/canvas.ts`); tests can install fakes.

import type { NodeConfig, RasterImage, StlValue } from '../types';
import type { HeightmapOptions } from './stl';
import type { DecodedAnimation } from './gif';

export interface Platform {
  /** Decode a data URL / object URL / http URL into a raster image. */
  decodeImage(src: string): Promise<RasterImage>;
  /**
   * Decode an animated image (GIF / animated WebP / APNG) into its composited
   * frames. A still image decodes to a single frame.
   */
  decodeAnimation(src: string, maxFrames?: number): Promise<DecodedAnimation>;
  /** Encode as a PNG data URL. */
  encodePng(img: RasterImage): string;
  /** Encode as a PNG Blob (for downloads). */
  encodePngBlob(img: RasterImage): Promise<Blob>;
  /** Fetch a remote image (e.g. a Replicate result) as a raster image. */
  fetchImage(src: string, signal?: AbortSignal): Promise<RasterImage>;
  /** Persist an image data URL out-of-band, returning a content-hash reference. */
  putBlob(dataUrl: string): Promise<string>;
  /** Resolve a blob reference back to its data URL (null if unknown). */
  getBlob(ref: string): Promise<string | null>;
  /** Optional: run a heavy image op off the main thread (Web Worker pool). */
  runImageOp?(name: string, img: RasterImage, config: NodeConfig): Promise<RasterImage>;
  /** Optional: build a heightmap STL off the main thread (Web Worker pool). */
  generateStl?(img: RasterImage, opts: HeightmapOptions): Promise<StlValue>;
}

const notReady = (): never => {
  throw new Error('Platform image adapter not initialised');
};

export const platform: Platform = {
  decodeImage: notReady,
  decodeAnimation: notReady,
  encodePng: notReady,
  encodePngBlob: notReady,
  fetchImage: notReady,
  putBlob: notReady,
  getBlob: notReady,
};

export function setPlatform(p: Partial<Platform>): void {
  Object.assign(platform, p);
}
