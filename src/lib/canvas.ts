// Browser-only canvas adapter. Provides the concrete Platform implementation
// and preview/thumbnail helpers. Only imported from the browser entry point.

import type { Platform } from './platform';
import type { RasterImage } from '../types';
import { createBlobStore, indexedDbBackend } from './blobStore';
import { createImageWorkerPool } from './imageWorkerPool';
import { decodeGif, isGif, type AnimationFrame, type DecodedAnimation } from './gif';

const blobStore = createBlobStore(indexedDbBackend());
const workerPool = createImageWorkerPool();

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

// --- Animated image decoding -----------------------------------------------
//
// GIF goes through our own decoder (lib/gif.ts): it works in every browser and
// is unit-tested. Animated WebP and APNG need a real codec, so they go through
// WebCodecs' ImageDecoder where it exists — Chromium and Safari 17+ have it,
// and anything else falls back to the still-image path (one frame), which is
// also the right answer for a PNG/JPEG that was never animated.

/** Minimal structural type for WebCodecs' ImageDecoder (absent from lib.dom). */
interface ImageDecoderLike {
  completed: Promise<void>;
  tracks: { selectedTrack?: { frameCount: number; animated: boolean } };
  decode(init: { frameIndex: number }): Promise<{ image: VideoFrameLike }>;
  close(): void;
}
interface VideoFrameLike {
  displayWidth: number;
  displayHeight: number;
  /** Frame duration in microseconds, when the container states one. */
  duration: number | null;
  close(): void;
}
type ImageDecoderCtor = new (init: { data: BufferSource; type: string }) => ImageDecoderLike;

const imageDecoderCtor = (): ImageDecoderCtor | undefined =>
  (globalThis as { ImageDecoder?: ImageDecoderCtor }).ImageDecoder;

/** Container sniff — enough to name a MIME type for ImageDecoder. */
function sniffMime(bytes: Uint8Array): string | null {
  const ascii = (at: number, len: number) => String.fromCharCode(...bytes.subarray(at, at + len));
  if (bytes.length < 12) return null;
  if (isGif(bytes)) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (bytes[0] === 0x89 && ascii(1, 3) === 'PNG') return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (ascii(4, 4) === 'ftyp') return 'image/avif';
  return null;
}

async function fetchBytes(src: string): Promise<Uint8Array> {
  const resp = await fetch(src);
  if (!resp.ok) throw new Error(`Failed to read image (${resp.status})`);
  return new Uint8Array(await resp.arrayBuffer());
}

async function decodeViaImageDecoder(
  bytes: Uint8Array,
  mime: string,
  maxFrames: number,
): Promise<DecodedAnimation | null> {
  const Ctor = imageDecoderCtor();
  if (!Ctor) return null;
  const decoder = new Ctor({ data: bytes as unknown as BufferSource, type: mime });
  try {
    await decoder.completed; // frameCount is only final once the file is parsed
    const track = decoder.tracks.selectedTrack;
    const count = Math.max(1, Math.min(track?.frameCount ?? 1, maxFrames));
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2D canvas context unavailable');
    const frames: AnimationFrame[] = [];
    for (let i = 0; i < count; i++) {
      const { image } = await decoder.decode({ frameIndex: i });
      try {
        canvas.width = image.displayWidth;
        canvas.height = image.displayHeight;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        // A VideoFrame is a valid drawImage source; lib.dom's union predates it
        // in this TS version.
        ctx.drawImage(image as unknown as CanvasImageSource, 0, 0);
        frames.push({
          image: {
            kind: 'image',
            width: canvas.width,
            height: canvas.height,
            data: ctx.getImageData(0, 0, canvas.width, canvas.height).data,
          },
          delayMs: image.duration ? Math.max(10, Math.round(image.duration / 1000)) : 100,
        });
      } finally {
        image.close();
      }
    }
    if (!frames.length) return null;
    return { width: frames[0].image.width, height: frames[0].image.height, frames };
  } finally {
    decoder.close();
  }
}

async function decodeAnimation(src: string, maxFrames = 512): Promise<DecodedAnimation> {
  const bytes = await fetchBytes(src);
  if (isGif(bytes)) return decodeGif(bytes, maxFrames);

  const mime = sniffMime(bytes);
  if (mime) {
    try {
      const decoded = await decodeViaImageDecoder(bytes, mime, maxFrames);
      if (decoded) return decoded;
    } catch {
      // Unsupported container or a codec the browser won't touch — fall through
      // to the still-image path rather than failing the node outright.
    }
  }

  const image = await decodeImage(src);
  return { width: image.width, height: image.height, frames: [{ image, delayMs: 100 }] };
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
  decodeAnimation,
  encodePng: (img) => rasterToDataUrl(img),
  encodePngBlob,
  fetchImage,
  putBlob: (dataUrl) => blobStore.put(dataUrl),
  getBlob: (ref) => blobStore.get(ref),
  putBytes: (bytes) => blobStore.putBytes(bytes),
  getBytes: (ref) => blobStore.getBytes(ref),
  runImageOp: workerPool.runImageOp,
  generateStl: workerPool.generateStl,
};
