// Indirection layer so the engine/nodes can decode/encode/fetch images without
// depending directly on the DOM. The browser entry point installs the real
// canvas-based adapter (`lib/canvas.ts`); tests can install fakes.

import type { RasterImage } from '../types';

export interface Platform {
  /** Decode a data URL / object URL / http URL into a raster image. */
  decodeImage(src: string): Promise<RasterImage>;
  /** Encode as a PNG data URL. */
  encodePng(img: RasterImage): string;
  /** Encode as a PNG Blob (for downloads). */
  encodePngBlob(img: RasterImage): Promise<Blob>;
  /** Fetch a remote image (e.g. a Replicate result) as a raster image. */
  fetchImage(src: string, signal?: AbortSignal): Promise<RasterImage>;
}

const notReady = (): never => {
  throw new Error('Platform image adapter not initialised');
};

export const platform: Platform = {
  decodeImage: notReady,
  encodePng: notReady,
  encodePngBlob: notReady,
  fetchImage: notReady,
};

export function setPlatform(p: Partial<Platform>): void {
  Object.assign(platform, p);
}
