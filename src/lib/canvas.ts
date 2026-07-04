// Browser-only canvas adapter. Provides the concrete Platform implementation
// and preview/thumbnail helpers. Only imported from the browser entry point.

import type { Platform } from './platform';
import type { RasterImage } from '../types';

function rasterToCanvas(img: RasterImage): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  const imageData = new ImageData(new Uint8ClampedArray(img.data), img.width, img.height);
  ctx.putImageData(imageData, 0, 0);
  return canvas;
}

export function rasterToDataUrl(img: RasterImage, type = 'image/png'): string {
  return rasterToCanvas(img).toDataURL(type);
}

/** Downscaled data URL for on-node previews. */
export function rasterToThumbnail(img: RasterImage, max = 200): string {
  const scale = Math.min(1, max / Math.max(img.width, img.height));
  if (scale >= 1) return rasterToDataUrl(img);
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const src = rasterToCanvas(img);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(src, 0, 0, w, h);
  return canvas.toDataURL('image/png');
}

async function decodeImage(src: string): Promise<RasterImage> {
  const image = new Image();
  image.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('Failed to decode image'));
    image.src = src;
  });
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth || image.width;
  canvas.height = image.naturalHeight || image.height;
  // willReadFrequently: this context exists only to read pixels back out.
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.drawImage(image, 0, 0);
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  return { kind: 'image', width: canvas.width, height: canvas.height, data };
}

function encodePngBlob(img: RasterImage): Promise<Blob> {
  return new Promise((resolve, reject) => {
    rasterToCanvas(img).toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Failed to encode PNG'))),
      'image/png',
    );
  });
}

async function fetchImage(src: string, signal?: AbortSignal): Promise<RasterImage> {
  const resp = await fetch(src, { signal });
  if (!resp.ok) throw new Error(`Failed to fetch image (${resp.status})`);
  const blob = await resp.blob();
  const objectUrl = URL.createObjectURL(blob);
  try {
    return await decodeImage(objectUrl);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

export const browserPlatform: Platform = {
  decodeImage,
  encodePng: (img) => rasterToDataUrl(img),
  encodePngBlob,
  fetchImage,
};
