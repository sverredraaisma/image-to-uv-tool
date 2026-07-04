// Pure RGBA raster-image operations. No DOM: every function here takes and
// returns plain `RasterImage` buffers and is unit-testable in Node.

import type { RasterImage } from '../types';

export function createImage(
  width: number,
  height: number,
  fill: [number, number, number, number] = [0, 0, 0, 0],
): RasterImage {
  const data = new Uint8ClampedArray(width * height * 4);
  const [r, g, b, a] = fill;
  for (let i = 0; i < data.length; i += 4) {
    data[i] = r;
    data[i + 1] = g;
    data[i + 2] = b;
    data[i + 3] = a;
  }
  return { kind: 'image', width, height, data };
}

export function cloneImage(img: RasterImage): RasterImage {
  return {
    kind: 'image',
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  };
}

/** Perceptual luminance (0-255) of a pixel, ignoring alpha. */
export function luminance(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** Nearest-neighbour resize. */
export function resize(img: RasterImage, width: number, height: number): RasterImage {
  if (img.width === width && img.height === height) return cloneImage(img);
  const out = createImage(width, height);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(img.height - 1, Math.floor((y / height) * img.height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(img.width - 1, Math.floor((x / width) * img.width));
      const si = (sy * img.width + sx) * 4;
      const di = (y * width + x) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

/**
 * Downscale so the longest side is at most `maxDim` (aspect preserved). Returns
 * a copy unchanged when `maxDim <= 0` or the image already fits.
 */
export function downscaleToMax(img: RasterImage, maxDim: number): RasterImage {
  const longest = Math.max(img.width, img.height);
  if (maxDim <= 0 || longest <= maxDim) return cloneImage(img);
  const scale = maxDim / longest;
  return resize(img, Math.max(1, Math.round(img.width * scale)), Math.max(1, Math.round(img.height * scale)));
}

/** Scale the alpha channel by `factor` (0–1) to fade the image. */
export function opacity(img: RasterImage, factor: number): RasterImage {
  const f = Math.max(0, Math.min(1, factor));
  const out = cloneImage(img);
  for (let i = 3; i < out.data.length; i += 4) out.data[i] = out.data[i] * f;
  return out;
}

export type InvertChannels = { r: boolean; g: boolean; b: boolean; a: boolean };

/** Invert the selected RGBA channels. */
export function invert(img: RasterImage, channels: InvertChannels): RasterImage {
  const out = cloneImage(img);
  const { r, g, b, a } = channels;
  for (let i = 0; i < out.data.length; i += 4) {
    if (r) out.data[i] = 255 - out.data[i];
    if (g) out.data[i + 1] = 255 - out.data[i + 1];
    if (b) out.data[i + 2] = 255 - out.data[i + 2];
    if (a) out.data[i + 3] = 255 - out.data[i + 3];
  }
  return out;
}

export type CombineMode =
  | 'max'
  | 'min'
  | 'multiply'
  | 'add'
  | 'subtract'
  | 'difference'
  | 'screen'
  | 'average'
  | 'over' // A over B
  | 'under'; // B over A

function combineChannel(a: number, b: number, mode: CombineMode): number {
  switch (mode) {
    case 'max':
      return Math.max(a, b);
    case 'min':
      return Math.min(a, b);
    case 'multiply':
      return (a * b) / 255;
    case 'add':
      return Math.min(255, a + b);
    case 'subtract':
      return Math.max(0, a - b);
    case 'difference':
      return Math.abs(a - b);
    case 'screen':
      return 255 - ((255 - a) * (255 - b)) / 255;
    case 'average':
      return (a + b) / 2;
    default:
      return a;
  }
}

/** Combine exactly two images (already the same size). `a` is "A", `b` is "B". */
function combineTwo(a: RasterImage, b: RasterImage, mode: CombineMode): RasterImage {
  const out = createImage(a.width, a.height);
  const n = out.data.length;
  if (mode === 'over' || mode === 'under') {
    // Alpha compositing. "over": A over B. "under": B over A (swap).
    const top = mode === 'over' ? a : b;
    const bot = mode === 'over' ? b : a;
    for (let i = 0; i < n; i += 4) {
      const at = top.data[i + 3] / 255;
      const ab = bot.data[i + 3] / 255;
      const ao = at + ab * (1 - at);
      out.data[i + 3] = ao * 255;
      for (let c = 0; c < 3; c++) {
        const v = ao > 0 ? (top.data[i + c] * at + bot.data[i + c] * ab * (1 - at)) / ao : 0;
        out.data[i + c] = v;
      }
    }
    return out;
  }
  for (let i = 0; i < n; i += 4) {
    for (let c = 0; c < 4; c++) {
      out.data[i + c] = combineChannel(a.data[i + c], b.data[i + c], mode);
    }
  }
  return out;
}

/**
 * Combine two or more images. Images are resized (nearest-neighbour) to match
 * the first input, then folded left-to-right. For "over", the first input ends
 * up on top.
 */
export function combine(images: RasterImage[], mode: CombineMode): RasterImage {
  if (images.length === 0) throw new Error('combine requires at least one image');
  const [first, ...rest] = images;
  let acc = cloneImage(first);
  for (const img of rest) {
    const sized = resize(img, first.width, first.height);
    acc = combineTwo(acc, sized, mode);
  }
  return acc;
}

/**
 * Chamfer distance transform: for each pixel, approximate distance to the
 * nearest pixel that is "opaque" (alpha > alphaThreshold). Opaque pixels get 0.
 */
export function distanceToOpaque(img: RasterImage, alphaThreshold = 0): Float32Array {
  const { width: w, height: h } = img;
  const INF = 1e9;
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    dist[i] = img.data[i * 4 + 3] > alphaThreshold ? 0 : INF;
  }
  const D1 = 1;
  const D2 = Math.SQRT2;
  const at = (x: number, y: number) => dist[y * w + x];
  // Forward pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let d = at(x, y);
      if (x > 0) d = Math.min(d, at(x - 1, y) + D1);
      if (y > 0) d = Math.min(d, at(x, y - 1) + D1);
      if (x > 0 && y > 0) d = Math.min(d, at(x - 1, y - 1) + D2);
      if (x < w - 1 && y > 0) d = Math.min(d, at(x + 1, y - 1) + D2);
      dist[y * w + x] = d;
    }
  }
  // Backward pass
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      let d = at(x, y);
      if (x < w - 1) d = Math.min(d, at(x + 1, y) + D1);
      if (y < h - 1) d = Math.min(d, at(x, y + 1) + D1);
      if (x < w - 1 && y < h - 1) d = Math.min(d, at(x + 1, y + 1) + D2);
      if (x > 0 && y < h - 1) d = Math.min(d, at(x - 1, y + 1) + D2);
      dist[y * w + x] = d;
    }
  }
  return dist;
}

/**
 * Draw an outline of the given thickness/colour around the non-transparent
 * pixels of `img`. The original image is composited on top of the outline.
 */
export function outline(
  img: RasterImage,
  thickness: number,
  color: [number, number, number, number],
  alphaThreshold = 0,
): RasterImage {
  const out = createImage(img.width, img.height);
  if (thickness > 0) {
    const dist = distanceToOpaque(img, alphaThreshold);
    for (let p = 0; p < img.width * img.height; p++) {
      const original = img.data[p * 4 + 3] > alphaThreshold;
      if (!original && dist[p] <= thickness) {
        out.data[p * 4] = color[0];
        out.data[p * 4 + 1] = color[1];
        out.data[p * 4 + 2] = color[2];
        out.data[p * 4 + 3] = color[3];
      }
    }
  }
  // Composite original on top (simple source-over for opaque source pixels).
  for (let p = 0; p < img.width * img.height; p++) {
    const sa = img.data[p * 4 + 3] / 255;
    if (sa <= 0) continue;
    const i = p * 4;
    const da = out.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = oa > 0 ? (img.data[i + c] * sa + out.data[i + c] * da * (1 - sa)) / oa : 0;
    }
    out.data[i + 3] = oa * 255;
  }
  return out;
}

export type AlphaCleanupMode = 'transparent' | 'black' | 'white';

/**
 * Pixels whose alpha is below `threshold` are replaced: made fully
 * transparent, or snapped to opaque black / white.
 */
export function alphaCleanup(
  img: RasterImage,
  threshold: number,
  mode: AlphaCleanupMode,
): RasterImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    if (out.data[i + 3] < threshold) {
      if (mode === 'transparent') {
        out.data[i + 3] = 0;
      } else {
        const v = mode === 'white' ? 255 : 0;
        out.data[i] = v;
        out.data[i + 1] = v;
        out.data[i + 2] = v;
        out.data[i + 3] = 255;
      }
    }
  }
  return out;
}

/** Parse a #rrggbb or #rrggbbaa hex string to an RGBA tuple. */
export function hexToRgba(hex: string, alpha = 255): [number, number, number, number] {
  const h = hex.replace('#', '');
  if (h.length === 8) {
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
      parseInt(h.slice(6, 8), 16),
    ];
  }
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
    alpha,
  ];
}

/** Desaturate to greyscale (per-pixel luminance), keeping alpha. */
export function grayscale(img: RasterImage): RasterImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const l = Math.round(luminance(out.data[i], out.data[i + 1], out.data[i + 2]));
    out.data[i] = l;
    out.data[i + 1] = l;
    out.data[i + 2] = l;
  }
  return out;
}

/** Brightness and contrast, both in [-100, 100]. Alpha is unchanged. */
export function brightnessContrast(
  img: RasterImage,
  brightness: number,
  contrast: number,
): RasterImage {
  const out = cloneImage(img);
  const bAdd = brightness * 2.55;
  const c = contrast * 2.55;
  const factor = (259 * (c + 255)) / (255 * (259 - c));
  for (let i = 0; i < out.data.length; i += 4) {
    for (let ch = 0; ch < 3; ch++) {
      out.data[i + ch] = factor * (out.data[i + ch] - 128) + 128 + bAdd;
    }
  }
  return out;
}

/** Binarise by luminance: pixels >= level become white, else black (opaque). */
export function threshold(img: RasterImage, level: number, invert = false): RasterImage {
  const out = createImage(img.width, img.height, [0, 0, 0, 255]);
  for (let i = 0; i < img.data.length; i += 4) {
    let on = luminance(img.data[i], img.data[i + 1], img.data[i + 2]) >= level;
    if (invert) on = !on;
    const v = on ? 255 : 0;
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
  }
  return out;
}

/** Crop a rectangle (clamped to the image bounds). */
export function crop(img: RasterImage, x: number, y: number, w: number, h: number): RasterImage {
  const sx = Math.max(0, Math.min(img.width - 1, Math.floor(x)));
  const sy = Math.max(0, Math.min(img.height - 1, Math.floor(y)));
  const ow = Math.max(1, Math.min(Math.floor(w), img.width - sx));
  const oh = Math.max(1, Math.min(Math.floor(h), img.height - sy));
  const out = createImage(ow, oh);
  for (let j = 0; j < oh; j++) {
    for (let i = 0; i < ow; i++) {
      const si = ((sy + j) * img.width + (sx + i)) * 4;
      const di = (j * ow + i) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

/** Extend the canvas by `amount` px on every side with transparent padding. */
export function pad(img: RasterImage, amount: number): RasterImage {
  const a = Math.max(0, Math.floor(amount));
  if (a === 0) return cloneImage(img);
  const out = createImage(img.width + 2 * a, img.height + 2 * a); // transparent
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const si = (y * img.width + x) * 4;
      const di = ((y + a) * out.width + (x + a)) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

export type TransformOp = 'rotate90' | 'rotate180' | 'rotate270' | 'flipH' | 'flipV';

/** Rotate (multiples of 90°) or flip an image. */
export function transform(img: RasterImage, op: TransformOp): RasterImage {
  const { width: w, height: h } = img;
  const rotated = op === 'rotate90' || op === 'rotate270';
  const ow = rotated ? h : w;
  const oh = rotated ? w : h;
  const out = createImage(ow, oh);
  const copy = (sx: number, sy: number, dx: number, dy: number) => {
    const si = (sy * w + sx) * 4;
    const di = (dy * ow + dx) * 4;
    out.data[di] = img.data[si];
    out.data[di + 1] = img.data[si + 1];
    out.data[di + 2] = img.data[si + 2];
    out.data[di + 3] = img.data[si + 3];
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      switch (op) {
        case 'rotate90':
          copy(x, y, h - 1 - y, x);
          break;
        case 'rotate180':
          copy(x, y, w - 1 - x, h - 1 - y);
          break;
        case 'rotate270':
          copy(x, y, y, w - 1 - x);
          break;
        case 'flipH':
          copy(x, y, w - 1 - x, y);
          break;
        case 'flipV':
          copy(x, y, x, h - 1 - y);
          break;
      }
    }
  }
  return out;
}

/** Use a mask's luminance as alpha, multiplied into the image's existing alpha. */
export function applyMask(img: RasterImage, mask: RasterImage): RasterImage {
  const m = resize(mask, img.width, img.height);
  const out = cloneImage(img);
  for (let p = 0; p < img.width * img.height; p++) {
    const i = p * 4;
    const l = luminance(m.data[i], m.data[i + 1], m.data[i + 2]) / 255;
    out.data[i + 3] = out.data[i + 3] * l;
  }
  return out;
}

export type Channel = 'r' | 'g' | 'b' | 'a' | 'lum';

/** Extract one channel (or luminance) as a greyscale, opaque image. */
export function extractChannel(img: RasterImage, channel: Channel): RasterImage {
  const out = createImage(img.width, img.height, [0, 0, 0, 255]);
  const offset = { r: 0, g: 1, b: 2, a: 3 }[channel === 'lum' ? 'r' : channel];
  for (let i = 0; i < img.data.length; i += 4) {
    const v =
      channel === 'lum'
        ? Math.round(luminance(img.data[i], img.data[i + 1], img.data[i + 2]))
        : img.data[i + offset];
    out.data[i] = v;
    out.data[i + 1] = v;
    out.data[i + 2] = v;
  }
  return out;
}

/** Separable box blur of the given pixel radius. */
export function boxBlur(img: RasterImage, radius: number): RasterImage {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return cloneImage(img);
  return blurPass(blurPass(img, r, true), r, false);
}

/** Auto-contrast: stretch each RGB channel so its min→0 and max→255. Alpha kept. */
export function normalize(img: RasterImage): RasterImage {
  const out = cloneImage(img);
  for (let c = 0; c < 3; c++) {
    let min = 255;
    let max = 0;
    for (let i = c; i < img.data.length; i += 4) {
      const v = img.data[i];
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (max > min) {
      const scale = 255 / (max - min);
      for (let i = c; i < out.data.length; i += 4) out.data[i] = (img.data[i] - min) * scale;
    }
  }
  return out;
}

/** Unsharp-mask sharpening: add `amount` × (image − blurred image). Alpha kept. */
export function sharpen(img: RasterImage, amount: number): RasterImage {
  if (amount <= 0) return cloneImage(img);
  const blurred = boxBlur(img, 1);
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = img.data[i + c] + amount * (img.data[i + c] - blurred.data[i + c]);
    }
  }
  return out;
}

function blurPass(img: RasterImage, r: number, horizontal: boolean): RasterImage {
  const { width: w, height: h } = img;
  const out = createImage(w, h);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const window = 2 * r + 1;
  for (let line = 0; line < lines; line++) {
    for (let ch = 0; ch < 4; ch++) {
      let sum = 0;
      const idxAt = (k: number) => {
        const x = horizontal ? k : line;
        const y = horizontal ? line : k;
        return (y * w + x) * 4 + ch;
      };
      // Prime the window at position 0 (clamped edges).
      for (let k = -r; k <= r; k++) sum += img.data[idxAt(Math.max(0, Math.min(len - 1, k)))];
      for (let i = 0; i < len; i++) {
        out.data[idxAt(i)] = sum / window;
        const add = Math.max(0, Math.min(len - 1, i + r + 1));
        const rem = Math.max(0, Math.min(len - 1, i - r));
        sum += img.data[idxAt(add)] - img.data[idxAt(rem)];
      }
    }
  }
  return out;
}

export type MorphOp = 'dilate' | 'erode';

/**
 * Greyscale morphology with a square structuring element (separable). `dilate`
 * grows bright regions (per-channel local max); `erode` shrinks them (local
 * min). On a white-on-black mask these grow / shrink the selection.
 */
export function morphology(img: RasterImage, radius: number, op: MorphOp): RasterImage {
  const r = Math.max(0, Math.floor(radius));
  if (r === 0) return cloneImage(img);
  return morphPass(morphPass(img, r, op, true), r, op, false);
}

function morphPass(img: RasterImage, r: number, op: MorphOp, horizontal: boolean): RasterImage {
  const { width: w, height: h } = img;
  const out = createImage(w, h);
  const lines = horizontal ? h : w;
  const len = horizontal ? w : h;
  const reduce = op === 'dilate' ? Math.max : Math.min;
  for (let line = 0; line < lines; line++) {
    for (let ch = 0; ch < 4; ch++) {
      const idxAt = (k: number) => {
        const x = horizontal ? k : line;
        const y = horizontal ? line : k;
        return (y * w + x) * 4 + ch;
      };
      for (let i = 0; i < len; i++) {
        let acc = op === 'dilate' ? 0 : 255;
        for (let k = i - r; k <= i + r; k++) {
          acc = reduce(acc, img.data[idxAt(Math.max(0, Math.min(len - 1, k)))]);
        }
        out.data[idxAt(i)] = acc;
      }
    }
  }
  return out;
}

export type MaskOp = 'and' | 'or' | 'subtract' | 'xor';

/**
 * Boolean-combine two masks. A pixel is "on" where luminance >= threshold;
 * result is a white(on)/black(off) opaque mask. `b` is resized to match `a`.
 */
export function maskCombine(
  a: RasterImage,
  b: RasterImage,
  op: MaskOp,
  threshold = 128,
): RasterImage {
  const bb = resize(b, a.width, a.height);
  const out = createImage(a.width, a.height, [0, 0, 0, 255]);
  for (let p = 0; p < a.width * a.height; p++) {
    const i = p * 4;
    const aOn = luminance(a.data[i], a.data[i + 1], a.data[i + 2]) >= threshold;
    const bOn = luminance(bb.data[i], bb.data[i + 1], bb.data[i + 2]) >= threshold;
    let on = false;
    switch (op) {
      case 'and':
        on = aOn && bOn;
        break;
      case 'or':
        on = aOn || bOn;
        break;
      case 'subtract':
        on = aOn && !bOn;
        break;
      case 'xor':
        on = aOn !== bOn;
        break;
    }
    if (on) {
      out.data[i] = 255;
      out.data[i + 1] = 255;
      out.data[i + 2] = 255;
    }
  }
  return out;
}

/** Reduce each RGB channel to `levels` evenly-spaced values (alpha kept). */
export function posterize(img: RasterImage, levels: number): RasterImage {
  const n = Math.max(2, Math.floor(levels));
  const step = 255 / (n - 1);
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      out.data[i + c] = Math.round(Math.round(out.data[i + c] / step) * step);
    }
  }
  return out;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}

function hue2rgb(p: number, q: number, t: number): number {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

/**
 * Levels adjustment: remap each RGB channel so `blackPoint` maps to 0 and
 * `whitePoint` maps to 255, with a midtone `gamma` (>1 brightens). Alpha kept.
 */
export function levels(
  img: RasterImage,
  blackPoint: number,
  whitePoint: number,
  gamma: number,
): RasterImage {
  const out = cloneImage(img);
  const range = Math.max(1, whitePoint - blackPoint);
  const invGamma = 1 / Math.max(0.01, gamma);
  for (let i = 0; i < out.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      let t = (out.data[i + c] - blackPoint) / range;
      t = Math.max(0, Math.min(1, t));
      out.data[i + c] = Math.round(Math.pow(t, invGamma) * 255);
    }
  }
  return out;
}

/** Shift hue (degrees) and scale saturation (multiplier), keeping alpha. */
export function hueSaturation(img: RasterImage, hueDegrees: number, satMultiplier: number): RasterImage {
  const out = cloneImage(img);
  const shift = hueDegrees / 360;
  for (let i = 0; i < out.data.length; i += 4) {
    const [h, s, l] = rgbToHsl(out.data[i], out.data[i + 1], out.data[i + 2]);
    let nh = (h + shift) % 1;
    if (nh < 0) nh += 1;
    const ns = Math.max(0, Math.min(1, s * satMultiplier));
    const [r, g, b] = hslToRgb(nh, ns, l);
    out.data[i] = r;
    out.data[i + 1] = g;
    out.data[i + 2] = b;
  }
  return out;
}

/** Map each pixel's luminance (0→low, 255→high) to a two-colour gradient. */
export function gradientMap(
  img: RasterImage,
  low: [number, number, number],
  high: [number, number, number],
): RasterImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const t = luminance(out.data[i], out.data[i + 1], out.data[i + 2]) / 255;
    out.data[i] = low[0] + (high[0] - low[0]) * t;
    out.data[i + 1] = low[1] + (high[1] - low[1]) * t;
    out.data[i + 2] = low[2] + (high[2] - low[2]) * t;
  }
  return out;
}

/**
 * Chroma key: white where a pixel's colour is within `tolerance` (max per-
 * channel RGB distance) of the target colour, black elsewhere. Opaque mask.
 */
export function colorKeyMask(
  img: RasterImage,
  color: [number, number, number],
  tolerance: number,
): RasterImage {
  const out = createImage(img.width, img.height, [0, 0, 0, 255]);
  for (let p = 0; p < img.width * img.height; p++) {
    const i = p * 4;
    const d = Math.max(
      Math.abs(img.data[i] - color[0]),
      Math.abs(img.data[i + 1] - color[1]),
      Math.abs(img.data[i + 2] - color[2]),
    );
    if (d <= tolerance) {
      out.data[i] = 255;
      out.data[i + 1] = 255;
      out.data[i + 2] = 255;
    }
  }
  return out;
}

/** Composite over a solid background colour, making every pixel opaque. */
export function flatten(img: RasterImage, bg: [number, number, number]): RasterImage {
  const out = cloneImage(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const a = img.data[i + 3] / 255;
    out.data[i] = img.data[i] * a + bg[0] * (1 - a);
    out.data[i + 1] = img.data[i + 1] * a + bg[1] * (1 - a);
    out.data[i + 2] = img.data[i + 2] * a + bg[2] * (1 - a);
    out.data[i + 3] = 255;
  }
  return out;
}

/** Mosaic / pixelate: downscale by `blockSize` then nearest-upscale back. */
export function pixelate(img: RasterImage, blockSize: number): RasterImage {
  const b = Math.max(1, Math.floor(blockSize));
  if (b <= 1) return cloneImage(img);
  const smallW = Math.max(1, Math.ceil(img.width / b));
  const smallH = Math.max(1, Math.ceil(img.height / b));
  return resize(resize(img, smallW, smallH), img.width, img.height);
}

/** Vignette: darken towards the corners. `strength` 0 = none, 1 = corners→black. */
export function vignette(img: RasterImage, strength: number): RasterImage {
  const out = cloneImage(img);
  const { width: w, height: h } = img;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const maxD = Math.hypot(cx, cy) || 1;
  const s = Math.max(0, Math.min(1, strength));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x - cx, y - cy) / maxD;
      const factor = 1 - s * d * d;
      const i = (y * w + x) * 4;
      out.data[i] = out.data[i] * factor;
      out.data[i + 1] = out.data[i + 1] * factor;
      out.data[i + 2] = out.data[i + 2] * factor;
    }
  }
  return out;
}

const SOBEL_X = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
const SOBEL_Y = [-1, -2, -1, 0, 0, 0, 1, 2, 1];

/** Sobel edge detection: white edges on black (gradient magnitude of luminance). */
export function sobel(img: RasterImage): RasterImage {
  const { width: w, height: h } = img;
  const out = createImage(w, h, [0, 0, 0, 255]);
  const lumAt = (x: number, y: number) => {
    const i = (Math.max(0, Math.min(h - 1, y)) * w + Math.max(0, Math.min(w - 1, x))) * 4;
    return luminance(img.data[i], img.data[i + 1], img.data[i + 2]);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let gx = 0;
      let gy = 0;
      let k = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++, k++) {
          const l = lumAt(x + i, y + j);
          gx += l * SOBEL_X[k];
          gy += l * SOBEL_Y[k];
        }
      }
      const mag = Math.min(255, Math.hypot(gx, gy));
      const di = (y * w + x) * 4;
      out.data[di] = mag;
      out.data[di + 1] = mag;
      out.data[di + 2] = mag;
    }
  }
  return out;
}
