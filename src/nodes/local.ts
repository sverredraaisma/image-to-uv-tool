// Local, browser-side node definitions (no network). Most are auto-run.

import type { ConfigField, NodeConfig, NodeDefinition, RasterImage } from '../types';
import { platform } from '../lib/platform';
import {
  alphaCleanup,
  applyCurve,
  applyMask,
  brightnessContrast,
  channelPack,
  curveLut,
  colorKeyMask,
  combine,
  createImage,
  crop,
  downscaleToMax,
  extractChannel,
  flatten,
  glossPreview,
  gradientMap,
  grayscale,
  hexToRgba,
  histogram,
  hueSaturation,
  invert,
  levels,
  linearGradient,
  maskCombine,
  normalize,
  opacity,
  pad,
  pasteImage,
  removeColor,
  resize,
  resizeBilinear,
  splitCompare,
  threshold,
  tint,
  valueNoise,
  transform,
  whiteBalance,
  type AlphaCleanupMode,
  type AutoThresholdMode,
  type Channel,
  type CombineMode,
  type CurveChannel,
  type CurvePoint,
  type MaskOp,
  type MorphOp,
  type TransformOp,
} from '../lib/image';
import { type Point } from '../lib/magicWand';
import { buildSelectionMask, type SelectionShape } from '../lib/selection';
import { heightmapToStl } from '../lib/stl';
import { isBlobRef } from '../lib/blobStore';
import { runHeavyOp } from '../lib/heavyOps';
import { formatRegion, parseRegion } from '../lib/region';
import { asImage, asText, bool, num, str } from './helpers';

/**
 * Helper for the very common single-image-in / single-image-out, auto-run node.
 * Keeps the many pixel-op nodes free of boilerplate.
 *
 * Pass `opName` (a key in the heavy-op registry) for CPU-heavy ops: they run in
 * a Web Worker when one is available (`platform.runImageOp`), and fall back to
 * the identical synchronous registry call otherwise.
 */
function singleImageOp(opts: {
  type: string;
  label: string;
  category: string;
  description?: string;
  configFields?: ConfigField[];
  defaultConfig?: () => NodeConfig;
  op?: (img: RasterImage, config: NodeConfig) => RasterImage;
  opName?: string;
  customEditor?: string;
}): NodeDefinition {
  const op = opts.op ?? ((img: RasterImage, config: NodeConfig) => runHeavyOp(opts.opName!, img, config));
  return {
    type: opts.type,
    label: opts.label,
    category: opts.category,
    description: opts.description,
    autoRun: true,
    inputs: [{ id: 'in', label: 'Image', type: 'image' }],
    outputs: [{ id: 'out', label: 'Image', type: 'image' }],
    configFields: opts.configFields,
    customEditor: opts.customEditor,
    defaultConfig: opts.defaultConfig ?? (() => ({})),
    compute: async ({ inputs, config }) => {
      const img = asImage(inputs.in);
      if (!img) return { out: undefined };
      if (opts.opName && platform.runImageOp) {
        return { out: await platform.runImageOp(opts.opName, img, config) };
      }
      return { out: op(img, config) };
    },
  };
}

// ---- Sources ----

export const imageInputNode: NodeDefinition = {
  type: 'imageInput',
  label: 'Image Input',
  category: 'Input',
  description: 'Upload an image to use as an output. Optionally cap the working resolution.',
  autoRun: true,
  inputs: [],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  configFields: [{ kind: 'number', key: 'maxSize', label: 'Max size (px, 0 = original)', min: 0, step: 64 }],
  defaultConfig: () => ({ src: '', srcRef: '', name: '', maxSize: 0 }),
  compute: async ({ config }) => {
    // Prefer the inline data URL (legacy graphs); otherwise resolve the
    // out-of-band blob reference kept in localStorage-friendly config.
    let src = str(config.src);
    if (!src && isBlobRef(config.srcRef)) src = (await platform.getBlob(config.srcRef)) ?? '';
    if (!src) return { out: undefined };
    const img = await platform.decodeImage(src);
    const maxSize = num(config.maxSize, 0);
    return { out: maxSize > 0 ? downscaleToMax(img, maxSize) : img };
  },
};

export const promptInputNode: NodeDefinition = {
  type: 'promptInput',
  label: 'Prompt Input',
  category: 'Input',
  description: 'A text prompt made available as an output.',
  autoRun: true,
  inputs: [],
  outputs: [{ id: 'out', label: 'Text', type: 'text' }],
  configFields: [
    { kind: 'text', key: 'text', label: 'Prompt', multiline: true, placeholder: 'Enter prompt…' },
  ],
  defaultConfig: () => ({ text: '' }),
  compute: ({ config }) => ({ out: { kind: 'text', text: str(config.text) } }),
};

export const solidColorNode: NodeDefinition = {
  type: 'solidColor',
  label: 'Solid Colour',
  category: 'Input',
  description: 'Generate a solid colour image.',
  autoRun: true,
  inputs: [],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  configFields: [
    { kind: 'number', key: 'width', label: 'Width', min: 1, step: 1 },
    { kind: 'number', key: 'height', label: 'Height', min: 1, step: 1 },
    { kind: 'color', key: 'color', label: 'Colour' },
  ],
  defaultConfig: () => ({ width: 256, height: 256, color: '#ffffff' }),
  compute: ({ config }) => ({
    out: createImage(
      Math.max(1, num(config.width, 256)),
      Math.max(1, num(config.height, 256)),
      hexToRgba(str(config.color, '#ffffff'), 255),
    ),
  }),
};

export const gradientNode: NodeDefinition = {
  type: 'gradient',
  label: 'Gradient',
  category: 'Input',
  description: 'Generate a linear two-colour gradient.',
  autoRun: true,
  inputs: [],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  configFields: [
    { kind: 'number', key: 'width', label: 'Width', min: 1, step: 1 },
    { kind: 'number', key: 'height', label: 'Height', min: 1, step: 1 },
    { kind: 'color', key: 'from', label: 'From' },
    { kind: 'color', key: 'to', label: 'To' },
    {
      kind: 'select',
      key: 'direction',
      label: 'Direction',
      options: [
        { value: 'horizontal', label: 'Horizontal' },
        { value: 'vertical', label: 'Vertical' },
      ],
    },
  ],
  defaultConfig: () => ({ width: 256, height: 256, from: '#000000', to: '#ffffff', direction: 'horizontal' }),
  compute: ({ config }) => ({
    out: linearGradient(
      Math.max(1, num(config.width, 256)),
      Math.max(1, num(config.height, 256)),
      hexToRgba(str(config.from, '#000000'), 255),
      hexToRgba(str(config.to, '#ffffff'), 255),
      str(config.direction, 'horizontal') === 'horizontal',
    ),
  }),
};

// ---- Compose ----

const COMBINE_MODES: { value: CombineMode; label: string }[] = [
  { value: 'over', label: 'A over B' },
  { value: 'under', label: 'B over A' },
  { value: 'max', label: 'Max (lighten)' },
  { value: 'min', label: 'Min (darken)' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'add', label: 'Add' },
  { value: 'subtract', label: 'Subtract' },
  { value: 'difference', label: 'Difference' },
  { value: 'screen', label: 'Screen' },
  { value: 'average', label: 'Average' },
];

export const combineNode: NodeDefinition = {
  type: 'combine',
  label: 'Combine',
  category: 'Compose',
  description: 'Blend a base image A with a secondary image B.',
  autoRun: true,
  inputs: [
    { id: 'a', label: 'A (base)', type: 'image' },
    { id: 'b', label: 'B (secondary)', type: 'image' },
  ],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  configFields: [{ kind: 'select', key: 'mode', label: 'Mode', options: COMBINE_MODES }],
  defaultConfig: () => ({ mode: 'over' satisfies CombineMode }),
  compute: ({ inputs, config }) => {
    const a = asImage(inputs.a);
    const b = asImage(inputs.b);
    const mode = str(config.mode, 'over') as CombineMode;
    if (a && b) return { out: combine([a, b], mode) };
    if (a) return { out: a };
    if (b) return { out: b };
    return { out: undefined };
  },
};

export const applyMaskNode: NodeDefinition = {
  type: 'applyMask',
  label: 'Apply Mask',
  category: 'Mask',
  description: "Use a mask's luminance as the image's alpha.",
  autoRun: true,
  inputs: [
    { id: 'image', label: 'Image', type: 'image' },
    { id: 'mask', label: 'Mask', type: 'mask' },
  ],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  defaultConfig: () => ({}),
  compute: ({ inputs }) => {
    const img = asImage(inputs.image);
    const mask = asImage(inputs.mask);
    if (!img) return { out: undefined };
    if (!mask) return { out: img };
    return { out: applyMask(img, mask) };
  },
};

export const flattenNode = singleImageOp({
  type: 'flatten',
  label: 'Flatten',
  category: 'Compose',
  description: 'Composite over a solid background colour (removes transparency).',
  configFields: [{ kind: 'color', key: 'background', label: 'Background' }],
  defaultConfig: () => ({ background: '#ffffff' }),
  op: (img, config) =>
    flatten(img, hexToRgba(str(config.background, '#ffffff')).slice(0, 3) as [number, number, number]),
});

// ---- Adjust ----

export const invertNode = singleImageOp({
  type: 'invert',
  label: 'Invert',
  category: 'Adjust',
  description: 'Invert selected RGBA channels.',
  configFields: [
    { kind: 'boolean', key: 'r', label: 'R' },
    { kind: 'boolean', key: 'g', label: 'G' },
    { kind: 'boolean', key: 'b', label: 'B' },
    { kind: 'boolean', key: 'a', label: 'A' },
  ],
  defaultConfig: () => ({ r: true, g: true, b: true, a: false }),
  op: (img, config) =>
    invert(img, {
      r: bool(config.r, true),
      g: bool(config.g, true),
      b: bool(config.b, true),
      a: bool(config.a, false),
    }),
});

export const grayscaleNode = singleImageOp({
  type: 'grayscale',
  label: 'Greyscale',
  category: 'Adjust',
  description: 'Desaturate to greyscale (luminance).',
  op: (img) => grayscale(img),
});

export const brightnessContrastNode = singleImageOp({
  type: 'brightnessContrast',
  label: 'Brightness / Contrast',
  category: 'Adjust',
  description: 'Adjust brightness and contrast.',
  configFields: [
    { kind: 'number', key: 'brightness', label: 'Brightness', min: -100, max: 100, step: 1 },
    { kind: 'number', key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1 },
  ],
  defaultConfig: () => ({ brightness: 0, contrast: 0 }),
  op: (img, config) => brightnessContrast(img, num(config.brightness, 0), num(config.contrast, 0)),
});

export const thresholdNode = singleImageOp({
  type: 'threshold',
  label: 'Threshold',
  category: 'Adjust',
  description: 'Binarise by luminance to black/white.',
  configFields: [
    { kind: 'number', key: 'level', label: 'Level', min: 0, max: 255, step: 1 },
    { kind: 'boolean', key: 'invert', label: 'Invert' },
  ],
  defaultConfig: () => ({ level: 128, invert: false }),
  op: (img, config) => threshold(img, num(config.level, 128), bool(config.invert, false)),
});

export const autoThresholdNode = singleImageOp({
  type: 'autoThreshold',
  label: 'Auto Threshold',
  category: 'Adjust',
  description:
    'Binarise at a level chosen from the histogram (Otsu valley, or brightest N%) — robust on dark or pale art. Invert for dark-luxury gloss.',
  configFields: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Mode',
      options: [
        { value: 'otsu', label: 'Otsu (auto valley)' },
        { value: 'percentile', label: 'Percentile (brightest N%)' },
      ],
    },
    { kind: 'number', key: 'percentile', label: 'Top %', min: 0, max: 100, step: 1 },
    { kind: 'boolean', key: 'invert', label: 'Invert' },
  ],
  defaultConfig: () => ({ mode: 'otsu' satisfies AutoThresholdMode, percentile: 20, invert: false }),
  opName: 'autoThreshold',
});

export const blurNode = singleImageOp({
  type: 'blur',
  label: 'Box Blur',
  category: 'Adjust',
  description: 'Blur by an adjustable pixel radius.',
  configFields: [{ kind: 'number', key: 'radius', label: 'Radius', min: 0, max: 100, step: 1 }],
  defaultConfig: () => ({ radius: 2 }),
  opName: 'blur',
});

export const sharpenNode = singleImageOp({
  type: 'sharpen',
  label: 'Sharpen',
  category: 'Adjust',
  description: 'Unsharp-mask sharpening.',
  configFields: [{ kind: 'number', key: 'amount', label: 'Amount', min: 0, max: 5, step: 0.1 }],
  defaultConfig: () => ({ amount: 1 }),
  opName: 'sharpen',
});

export const gradientMapNode = singleImageOp({
  type: 'gradientMap',
  label: 'Gradient Map',
  category: 'Adjust',
  description: 'Map luminance to a two-colour gradient.',
  configFields: [
    { kind: 'color', key: 'low', label: 'Shadows' },
    { kind: 'color', key: 'high', label: 'Highlights' },
  ],
  defaultConfig: () => ({ low: '#000000', high: '#ffffff' }),
  op: (img, config) =>
    gradientMap(
      img,
      hexToRgba(str(config.low, '#000000')).slice(0, 3) as [number, number, number],
      hexToRgba(str(config.high, '#ffffff')).slice(0, 3) as [number, number, number],
    ),
});

export const normalizeNode = singleImageOp({
  type: 'normalize',
  label: 'Auto Contrast',
  category: 'Adjust',
  description: 'Stretch each channel to the full 0–255 range.',
  op: (img) => normalize(img),
});

export const histogramNode = singleImageOp({
  type: 'histogram',
  label: 'Histogram',
  category: 'Adjust',
  description: 'RGB value-distribution scope — inspect the tonal range.',
  op: (img) => histogram(img),
});

export const curvesNode = singleImageOp({
  type: 'curves',
  label: 'Curves',
  category: 'Adjust',
  description: 'Remap tones with an editable curve (open the editor to drag points).',
  configFields: [
    {
      kind: 'select',
      key: 'channel',
      label: 'Channel',
      options: [
        { value: 'rgb', label: 'RGB' },
        { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' },
        { value: 'b', label: 'Blue' },
      ],
    },
  ],
  customEditor: 'curves',
  defaultConfig: () => ({
    channel: 'rgb' satisfies CurveChannel,
    points: [
      { x: 0, y: 0 },
      { x: 255, y: 255 },
    ] satisfies CurvePoint[],
  }),
  op: (img, config) => {
    const points = Array.isArray(config.points) ? (config.points as CurvePoint[]) : [];
    return applyCurve(img, curveLut(points), str(config.channel, 'rgb') as CurveChannel);
  },
});

export const opacityNode = singleImageOp({
  type: 'opacity',
  label: 'Opacity',
  category: 'Adjust',
  description: 'Fade the image by scaling its alpha.',
  configFields: [{ kind: 'number', key: 'opacity', label: 'Opacity', min: 0, max: 1, step: 0.05 }],
  defaultConfig: () => ({ opacity: 1 }),
  op: (img, config) => opacity(img, num(config.opacity, 1)),
});

export const tintNode = singleImageOp({
  type: 'tint',
  label: 'Tint',
  category: 'Adjust',
  description: 'Multiply the image by a colour.',
  configFields: [{ kind: 'color', key: 'color', label: 'Colour' }],
  defaultConfig: () => ({ color: '#ffffff' }),
  op: (img, config) =>
    tint(img, hexToRgba(str(config.color, '#ffffff')).slice(0, 3) as [number, number, number]),
});

export const levelsNode = singleImageOp({
  type: 'levels',
  label: 'Levels',
  category: 'Adjust',
  description: 'Remap tones with black/white points and midtone gamma.',
  configFields: [
    { kind: 'number', key: 'black', label: 'Black point', min: 0, max: 255, step: 1 },
    { kind: 'number', key: 'white', label: 'White point', min: 0, max: 255, step: 1 },
    { kind: 'number', key: 'gamma', label: 'Gamma', min: 0.1, max: 5, step: 0.05 },
  ],
  defaultConfig: () => ({ black: 0, white: 255, gamma: 1 }),
  op: (img, config) => levels(img, num(config.black, 0), num(config.white, 255), num(config.gamma, 1)),
});

export const hueSaturationNode = singleImageOp({
  type: 'hueSaturation',
  label: 'Hue / Saturation',
  category: 'Adjust',
  description: 'Shift hue and scale saturation.',
  configFields: [
    { kind: 'number', key: 'hue', label: 'Hue shift (°)', min: -180, max: 180, step: 1 },
    { kind: 'number', key: 'saturation', label: 'Saturation ×', min: 0, max: 2, step: 0.05 },
  ],
  defaultConfig: () => ({ hue: 0, saturation: 1 }),
  op: (img, config) => hueSaturation(img, num(config.hue, 0), num(config.saturation, 1)),
});

export const edgeDetectNode = singleImageOp({
  type: 'edgeDetect',
  label: 'Edge Detect',
  category: 'Adjust',
  description: 'Sobel edge detection — white edges on black (feeds ControlNet).',
  opName: 'edgeDetect',
});

export const pixelateNode = singleImageOp({
  type: 'pixelate',
  label: 'Pixelate',
  category: 'Adjust',
  description: 'Mosaic / blocky pixelation.',
  configFields: [{ kind: 'number', key: 'blockSize', label: 'Block size', min: 1, max: 128, step: 1 }],
  defaultConfig: () => ({ blockSize: 8 }),
  opName: 'pixelate',
});

export const vignetteNode = singleImageOp({
  type: 'vignette',
  label: 'Vignette',
  category: 'Adjust',
  description: 'Darken towards the corners.',
  configFields: [{ kind: 'number', key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.05 }],
  defaultConfig: () => ({ strength: 0.5 }),
  opName: 'vignette',
});

export const posterizeNode = singleImageOp({
  type: 'posterize',
  label: 'Posterize',
  category: 'Adjust',
  description: 'Reduce each colour channel to a limited number of levels.',
  configFields: [{ kind: 'number', key: 'levels', label: 'Levels', min: 2, max: 64, step: 1 }],
  defaultConfig: () => ({ levels: 4 }),
  opName: 'posterize',
});

export const outlineNode = singleImageOp({
  type: 'outline',
  label: 'Outline',
  category: 'Adjust',
  description: 'Add a coloured outline around non-transparent pixels.',
  configFields: [
    { kind: 'number', key: 'thickness', label: 'Thickness (px)', min: 0, max: 200, step: 1 },
    { kind: 'color', key: 'color', label: 'Colour' },
    { kind: 'number', key: 'alphaThreshold', label: 'Alpha threshold', min: 0, max: 255, advanced: true },
  ],
  defaultConfig: () => ({ thickness: 4, color: '#000000', alphaThreshold: 0 }),
  opName: 'outline',
});

export const alphaCleanupNode = singleImageOp({
  type: 'alphaCleanup',
  label: 'Alpha Cleanup',
  category: 'Adjust',
  description: 'Snap pixels below an alpha threshold to transparent / black / white.',
  configFields: [
    { kind: 'number', key: 'threshold', label: 'Alpha threshold', min: 0, max: 255, step: 1 },
    {
      kind: 'select',
      key: 'mode',
      label: 'Below becomes',
      options: [
        { value: 'transparent', label: 'Transparent' },
        { value: 'black', label: 'Black' },
        { value: 'white', label: 'White' },
      ],
    },
  ],
  defaultConfig: () => ({ threshold: 128, mode: 'transparent' satisfies AlphaCleanupMode }),
  op: (img, config) =>
    alphaCleanup(img, num(config.threshold, 128), str(config.mode, 'transparent') as AlphaCleanupMode),
});

// ---- Transform ----

export const cropNode = singleImageOp({
  type: 'crop',
  label: 'Crop',
  category: 'Transform',
  description: 'Crop a rectangle from the image.',
  configFields: [
    { kind: 'number', key: 'x', label: 'X', min: 0, step: 1 },
    { kind: 'number', key: 'y', label: 'Y', min: 0, step: 1 },
    { kind: 'number', key: 'width', label: 'Width', min: 1, step: 1 },
    { kind: 'number', key: 'height', label: 'Height', min: 1, step: 1 },
  ],
  defaultConfig: () => ({ x: 0, y: 0, width: 256, height: 256 }),
  op: (img, config) =>
    crop(
      img,
      num(config.x, 0),
      num(config.y, 0),
      num(config.width, img.width),
      num(config.height, img.height),
    ),
});

export const splitRegionNode: NodeDefinition = {
  type: 'splitRegion',
  label: 'Split Region',
  category: 'Transform',
  description:
    'Cut a rectangular region out as its own image, plus its coordinates + size. Wire "Coords" into Place Image to composite the (processed) region back exactly where it came from.',
  autoRun: true,
  inputs: [{ id: 'in', label: 'Image', type: 'image' }],
  outputs: [
    { id: 'out', label: 'Region', type: 'image' },
    { id: 'coords', label: 'Coords', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'x', label: 'X', min: 0, step: 1 },
    { kind: 'number', key: 'y', label: 'Y', min: 0, step: 1 },
    { kind: 'number', key: 'width', label: 'Width', min: 1, step: 1 },
    { kind: 'number', key: 'height', label: 'Height', min: 1, step: 1 },
  ],
  defaultConfig: () => ({ x: 0, y: 0, width: 256, height: 256 }),
  compute: ({ inputs, config }) => {
    const img = asImage(inputs.in);
    if (!img) return { out: undefined, coords: undefined };
    const rx = Math.max(0, Math.floor(num(config.x, 0)));
    const ry = Math.max(0, Math.floor(num(config.y, 0)));
    const cropped = crop(img, rx, ry, num(config.width, img.width), num(config.height, img.height));
    // Report the ACTUAL (clamped) rectangle — its size matches the cropped
    // image, so Place Image can put it back at exactly this spot.
    const region = { x: rx, y: ry, width: cropped.width, height: cropped.height };
    return { out: cropped, coords: { kind: 'text', text: formatRegion(region) } };
  },
};

export const placeImageNode: NodeDefinition = {
  type: 'placeImage',
  label: 'Place Image',
  category: 'Compose',
  description:
    'Composite an overlay onto a base image at given coordinates + size. Wire "Coords" from Split Region to drop a processed region back where it came from; the overlay is scaled to the coords size.',
  autoRun: true,
  inputs: [
    { id: 'base', label: 'Base', type: 'image', required: true },
    { id: 'overlay', label: 'Overlay', type: 'image', required: true },
    { id: 'coords', label: 'Coords', type: 'text' },
  ],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  configFields: [
    { kind: 'number', key: 'x', label: 'X', step: 1 },
    { kind: 'number', key: 'y', label: 'Y', step: 1 },
    { kind: 'number', key: 'width', label: 'Width (0 = overlay size)', min: 0, step: 1 },
    { kind: 'number', key: 'height', label: 'Height (0 = overlay size)', min: 0, step: 1 },
  ],
  defaultConfig: () => ({ x: 0, y: 0, width: 0, height: 0 }),
  compute: ({ inputs, config }) => {
    const base = asImage(inputs.base);
    const overlay = asImage(inputs.overlay);
    if (!base || !overlay) return { out: undefined };
    // A wired, valid Coords value overrides the manual x/y/width/height.
    const coordsText = asText(inputs.coords);
    const region = coordsText ? parseRegion(coordsText) : null;
    const x = region ? region.x : num(config.x, 0);
    const y = region ? region.y : num(config.y, 0);
    // width/height of 0 means "keep the overlay's own size".
    let w = region ? region.width : num(config.width, 0);
    let h = region ? region.height : num(config.height, 0);
    if (w <= 0) w = overlay.width;
    if (h <= 0) h = overlay.height;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const scaled = w === overlay.width && h === overlay.height ? overlay : resizeBilinear(overlay, w, h);
    return { out: pasteImage(base, scaled, x, y) };
  },
};

export const resizeNode = singleImageOp({
  type: 'resize',
  label: 'Resize',
  category: 'Transform',
  description: 'Resize by a scale multiplier (keeps aspect) or to an exact width/height.',
  configFields: [
    {
      kind: 'select',
      key: 'mode',
      label: 'Mode',
      options: [
        { value: 'scale', label: 'Scale × (keep aspect)' },
        { value: 'dimensions', label: 'Exact width × height' },
      ],
    },
    { kind: 'number', key: 'scale', label: 'Scale ×', min: 0.01, step: 0.1 },
    { kind: 'number', key: 'width', label: 'Width', min: 1, step: 1 },
    { kind: 'number', key: 'height', label: 'Height', min: 1, step: 1 },
    {
      kind: 'select',
      key: 'method',
      label: 'Method',
      options: [
        { value: 'bilinear', label: 'Bilinear (smooth)' },
        { value: 'nearest', label: 'Nearest (blocky)' },
      ],
    },
  ],
  // Nodes created before these fields default to 'dimensions' + nearest, so
  // existing graphs are unchanged; new nodes prefer scale + bilinear.
  defaultConfig: () => ({ mode: 'scale', scale: 1, width: 256, height: 256, method: 'bilinear' }),
  op: (img, config) => {
    let w: number;
    let h: number;
    if (str(config.mode, 'dimensions') === 'scale') {
      // A single multiplier applied to both axes keeps the aspect ratio.
      const s = Math.max(0.01, num(config.scale, 1));
      w = Math.max(1, Math.round(img.width * s));
      h = Math.max(1, Math.round(img.height * s));
    } else {
      w = Math.max(1, num(config.width, img.width));
      h = Math.max(1, num(config.height, img.height));
    }
    return str(config.method, 'nearest') === 'nearest' ? resize(img, w, h) : resizeBilinear(img, w, h);
  },
});

export const rotateAngleNode = singleImageOp({
  type: 'rotateAngle',
  label: 'Rotate (angle)',
  category: 'Transform',
  description: 'Rotate by an arbitrary angle — expands the canvas, bilinear sampled.',
  configFields: [{ kind: 'number', key: 'degrees', label: 'Degrees', min: -360, max: 360, step: 1 }],
  defaultConfig: () => ({ degrees: 45 }),
  opName: 'rotateAngle',
});

export const whiteBalanceNode = singleImageOp({
  type: 'whiteBalance',
  label: 'White Balance',
  category: 'Adjust',
  description: 'Shift colour temperature (warm/cool) and green/magenta tint.',
  configFields: [
    { kind: 'number', key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1 },
    { kind: 'number', key: 'tint', label: 'Tint', min: -100, max: 100, step: 1 },
  ],
  defaultConfig: () => ({ temperature: 0, tint: 0 }),
  op: (img, config) => whiteBalance(img, num(config.temperature, 0), num(config.tint, 0)),
});

export const seamlessTileNode = singleImageOp({
  type: 'seamlessTile',
  label: 'Seamless Tile',
  category: 'UV',
  description: 'Blend the borders so the texture tiles without visible seams.',
  configFields: [{ kind: 'number', key: 'feather', label: 'Feather', min: 0, max: 1, step: 0.05 }],
  defaultConfig: () => ({ feather: 0.5 }),
  opName: 'seamlessTile',
});

export const compareNode: NodeDefinition = {
  type: 'compare',
  label: 'A/B Compare',
  category: 'Compose',
  description: 'Split view: A on one side, B on the other, to compare two results.',
  autoRun: true,
  inputs: [
    { id: 'a', label: 'A', type: 'image' },
    { id: 'b', label: 'B', type: 'image' },
  ],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  configFields: [
    { kind: 'number', key: 'split', label: 'Split', min: 0, max: 1, step: 0.05 },
    {
      kind: 'select',
      key: 'orientation',
      label: 'Orientation',
      options: [
        { value: 'horizontal', label: 'Horizontal' },
        { value: 'vertical', label: 'Vertical' },
      ],
    },
  ],
  defaultConfig: () => ({ split: 0.5, orientation: 'horizontal' }),
  compute: ({ inputs, config }) => {
    const a = asImage(inputs.a);
    const b = asImage(inputs.b);
    if (a && b) {
      return {
        out: splitCompare(a, b, num(config.split, 0.5), str(config.orientation, 'horizontal') === 'vertical'),
      };
    }
    if (a) return { out: a };
    if (b) return { out: b };
    return { out: undefined };
  },
};

export const padNode = singleImageOp({
  type: 'pad',
  label: 'Pad',
  category: 'Transform',
  description: 'Extend the canvas with a transparent border (e.g. for outpainting).',
  configFields: [{ kind: 'number', key: 'amount', label: 'Amount (px)', min: 0, step: 1 }],
  defaultConfig: () => ({ amount: 32 }),
  op: (img, config) => pad(img, num(config.amount, 32)),
});

export const transformNode = singleImageOp({
  type: 'transform',
  label: 'Rotate / Flip',
  category: 'Transform',
  description: 'Rotate by 90° steps or flip.',
  configFields: [
    {
      kind: 'select',
      key: 'op',
      label: 'Operation',
      options: [
        { value: 'rotate90', label: 'Rotate 90° CW' },
        { value: 'rotate180', label: 'Rotate 180°' },
        { value: 'rotate270', label: 'Rotate 90° CCW' },
        { value: 'flipH', label: 'Flip horizontal' },
        { value: 'flipV', label: 'Flip vertical' },
      ],
    },
  ],
  defaultConfig: () => ({ op: 'rotate90' satisfies TransformOp }),
  op: (img, config) => transform(img, str(config.op, 'rotate90') as TransformOp),
});

// ---- Mask ----

export const extractChannelNode = singleImageOp({
  type: 'extractChannel',
  label: 'Extract Channel',
  category: 'Mask',
  description: 'Pull one channel (or luminance) out as a greyscale image.',
  configFields: [
    {
      kind: 'select',
      key: 'channel',
      label: 'Channel',
      options: [
        { value: 'lum', label: 'Luminance' },
        { value: 'r', label: 'Red' },
        { value: 'g', label: 'Green' },
        { value: 'b', label: 'Blue' },
        { value: 'a', label: 'Alpha' },
        { value: 'sat', label: 'Saturation (HSV)' },
        { value: 'val', label: 'Value (HSV)' },
        { value: 'hue', label: 'Hue (HSV)' },
      ],
    },
  ],
  defaultConfig: () => ({ channel: 'lum' satisfies Channel }),
  op: (img, config) => extractChannel(img, str(config.channel, 'lum') as Channel),
});

export const highlightExtractNode = singleImageOp({
  type: 'highlightExtract',
  label: 'Highlight Extract',
  category: 'Mask',
  description:
    'Extract painted speculars (locally bright + desaturated) as a greyscale gloss signal — where the artist put a glint. Big radius keeps skies/whites out.',
  configFields: [
    { kind: 'number', key: 'radius', label: 'Local radius (px)', min: 1, max: 200, step: 1 },
    { kind: 'number', key: 'gain', label: 'Gain', min: 0, max: 10, step: 0.1 },
    { kind: 'number', key: 'bias', label: 'Bias', min: 0, max: 255, step: 1 },
    { kind: 'number', key: 'satRejection', label: 'Saturation rejection', min: 0, max: 8, step: 0.5 },
  ],
  defaultConfig: () => ({ radius: 24, gain: 1, bias: 4, satRejection: 2 }),
  opName: 'highlightExtract',
});

export const chromaKeyNode: NodeDefinition = {
  type: 'chromaKey',
  label: 'Chroma Key',
  category: 'Mask',
  description: 'Make a mask of pixels near a target colour (within tolerance).',
  autoRun: true,
  inputs: [{ id: 'in', label: 'Image', type: 'image' }],
  outputs: [{ id: 'out', label: 'Mask', type: 'mask' }],
  configFields: [
    { kind: 'color', key: 'color', label: 'Colour' },
    { kind: 'number', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1 },
  ],
  defaultConfig: () => ({ color: '#00ff00', tolerance: 40 }),
  compute: ({ inputs, config }) => {
    const img = asImage(inputs.in);
    if (!img) return { out: undefined };
    const [r, g, b] = hexToRgba(str(config.color, '#00ff00'));
    return { out: colorKeyMask(img, [r, g, b], num(config.tolerance, 40)) };
  },
};

export const removeColorNode = singleImageOp({
  type: 'removeColor',
  label: 'Remove Colour',
  category: 'Mask',
  description: 'Make pixels near a colour transparent (local background key-out).',
  configFields: [
    { kind: 'color', key: 'color', label: 'Colour' },
    { kind: 'number', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1 },
  ],
  defaultConfig: () => ({ color: '#ffffff', tolerance: 30 }),
  op: (img, config) =>
    removeColor(
      img,
      hexToRgba(str(config.color, '#ffffff')).slice(0, 3) as [number, number, number],
      num(config.tolerance, 30),
    ),
});

export const maskCombineNode: NodeDefinition = {
  type: 'maskCombine',
  label: 'Combine Masks',
  category: 'Mask',
  description: 'Boolean-combine two masks (AND / OR / subtract / XOR).',
  autoRun: true,
  inputs: [
    { id: 'a', label: 'Mask A', type: 'mask' },
    { id: 'b', label: 'Mask B', type: 'mask' },
  ],
  outputs: [{ id: 'out', label: 'Mask', type: 'mask' }],
  configFields: [
    {
      kind: 'select',
      key: 'op',
      label: 'Operation',
      options: [
        { value: 'and', label: 'AND (intersection)' },
        { value: 'or', label: 'OR (union)' },
        { value: 'subtract', label: 'A minus B' },
        { value: 'xor', label: 'XOR (difference)' },
      ],
    },
  ],
  defaultConfig: () => ({ op: 'or' satisfies MaskOp }),
  compute: ({ inputs, config }) => {
    const a = asImage(inputs.a);
    const b = asImage(inputs.b);
    if (a && b) return { out: maskCombine(a, b, str(config.op, 'or') as MaskOp) };
    if (a) return { out: a };
    if (b) return { out: b };
    return { out: undefined };
  },
};

export const dilateNode = singleImageOp({
  type: 'dilate',
  label: 'Dilate',
  category: 'Mask',
  description: 'Grow bright / white regions (greyscale dilation).',
  configFields: [{ kind: 'number', key: 'radius', label: 'Radius', min: 0, max: 50, step: 1 }],
  defaultConfig: () => ({ radius: 2 }),
  opName: 'dilate',
});

export const erodeNode = singleImageOp({
  type: 'erode',
  label: 'Erode',
  category: 'Mask',
  description: 'Shrink bright / white regions (greyscale erosion).',
  configFields: [{ kind: 'number', key: 'radius', label: 'Radius', min: 0, max: 50, step: 1 }],
  defaultConfig: () => ({ radius: 2 }),
  opName: 'erode',
});

export const openCloseNode = singleImageOp({
  type: 'openClose',
  label: 'Open / Close',
  category: 'Mask',
  description:
    'Morphological open (remove bright specks) or close (fill dark pinholes) in one step — seals gloss shapes before the choke.',
  configFields: [
    {
      kind: 'select',
      key: 'op',
      label: 'Operation',
      options: [
        { value: 'close', label: 'Close (fill pinholes)' },
        { value: 'open', label: 'Open (remove specks)' },
      ],
    },
    { kind: 'number', key: 'radius', label: 'Radius', min: 0, max: 50, step: 1 },
  ],
  defaultConfig: () => ({ op: 'close' satisfies MorphOp, radius: 2 }),
  opName: 'morphology',
});

export const despeckleNode = singleImageOp({
  type: 'despeckle',
  label: 'Despeckle',
  category: 'Mask',
  description:
    'Enforce a minimum feature size: drop white islands below Min area and optionally fill enclosed pinholes below Min hole area. Outputs a clean B/W mask.',
  configFields: [
    { kind: 'number', key: 'minArea', label: 'Min area (px²)', min: 0, step: 1 },
    { kind: 'number', key: 'minHoleArea', label: 'Min hole area (px²)', min: 0, step: 1 },
    { kind: 'number', key: 'threshold', label: 'On threshold', min: 0, max: 255, step: 1, advanced: true },
  ],
  defaultConfig: () => ({ minArea: 9, minHoleArea: 0, threshold: 128 }),
  opName: 'despeckle',
});

export const areaPickerNode: NodeDefinition = {
  type: 'areaPicker',
  label: 'Area Picker',
  category: 'Mask',
  description:
    'Combine magic-wand clicks, rectangle and ellipse selections into one mask. Open the editor to draw; all selections are unioned.',
  autoRun: true,
  inputs: [{ id: 'in', label: 'Image', type: 'image' }],
  outputs: [{ id: 'out', label: 'Mask', type: 'mask' }],
  configFields: [{ kind: 'number', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1 }],
  customEditor: 'areaPicker',
  defaultConfig: () => ({ points: [] as Point[], tolerance: 32, shapes: [] as SelectionShape[] }),
  compute: ({ inputs, config }) => {
    const img = asImage(inputs.in);
    if (!img) return { out: undefined };
    const points = Array.isArray(config.points) ? (config.points as Point[]) : [];
    const shapes = Array.isArray(config.shapes) ? (config.shapes as SelectionShape[]) : [];
    return {
      out: buildSelectionMask(img, { points, tolerance: num(config.tolerance, 32), shapes }),
    };
  },
};

// ---- Export ----

export const heightmapStlNode: NodeDefinition = {
  type: 'heightmapStl',
  label: 'Heightmap → STL',
  category: 'Export',
  description:
    'Turn a heightmap into an STL solid (white = tall). Manual: click Run — generation runs in a worker so a high-res heightmap won’t freeze the UI. Enable “Merge flat areas” to collapse equal-height regions into a much smaller mesh (great for simple art / big images).',
  // Manual: STL meshing is heavy, so only run on explicit Run (not on every edit).
  autoRun: false,
  inputs: [{ id: 'in', label: 'Heightmap', type: 'image' }],
  outputs: [{ id: 'out', label: 'STL', type: 'stl' }],
  configFields: [
    { kind: 'number', key: 'minWhite', label: 'Min white (-1 = all)', min: -1, max: 255, step: 1 },
    { kind: 'number', key: 'baseThickness', label: 'Base thickness', min: 0, step: 0.1 },
    { kind: 'number', key: 'depthRange', label: 'Depth range', min: 0, step: 0.1 },
    { kind: 'number', key: 'width', label: 'Width (units)', min: 0.0001, step: 1 },
    { kind: 'number', key: 'smooth', label: 'Smoothing (σ px, 0 = off)', min: 0, max: 10, step: 0.5 },
    { kind: 'boolean', key: 'optimize', label: 'Merge flat areas (smaller mesh)' },
    {
      kind: 'number',
      key: 'heightLevels',
      label: 'Height levels (merge mode)',
      min: 2,
      max: 256,
      step: 1,
      advanced: true,
    },
  ],
  defaultConfig: () => ({
    minWhite: 1,
    baseThickness: 0,
    depthRange: 10,
    width: 100,
    smooth: 0,
    optimize: false,
    heightLevels: 16,
  }),
  compute: async ({ inputs, config, onProgress }) => {
    const img = asImage(inputs.in);
    if (!img) return { out: undefined };
    const opts = {
      minWhite: num(config.minWhite, 1),
      baseThickness: num(config.baseThickness, 0),
      depthRange: num(config.depthRange, 10),
      width: num(config.width, 100),
      smooth: num(config.smooth, 0),
      optimize: bool(config.optimize, false),
      heightLevels: num(config.heightLevels, 16),
    };
    onProgress?.('Generating STL…');
    // Off the main thread when a worker is available; identical sync fallback.
    const out = platform.generateStl ? await platform.generateStl(img, opts) : heightmapToStl(img, opts);
    return { out };
  },
};

// ---- UV / Texture ----

export const normalMapNode = singleImageOp({
  type: 'normalMap',
  label: 'Normal Map',
  category: 'UV',
  description: 'Heightmap → tangent-space normal map (white = high). OpenGL +Y.',
  configFields: [{ kind: 'number', key: 'strength', label: 'Strength', min: 0, max: 10, step: 0.1 }],
  defaultConfig: () => ({ strength: 2 }),
  opName: 'normalMap',
});

export const glossPreviewNode: NodeDefinition = {
  type: 'glossPreview',
  label: 'Gloss Preview',
  category: 'UV',
  description:
    'Simulate a spot-gloss (varnish) print: shiny where the gloss mask is on, using heightmap relief if wired. Reports gloss coverage % (aim 5–30%). Open the editor for an interactive 3D view.',
  autoRun: true,
  customEditor: 'gloss3d',
  inputs: [
    { id: 'art', label: 'Art', type: 'image' },
    { id: 'gloss', label: 'Gloss mask', type: 'mask' },
    { id: 'heightmap', label: 'Heightmap', type: 'image' },
  ],
  outputs: [
    { id: 'preview', label: 'Preview', type: 'image' },
    { id: 'stats', label: 'Stats', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'azimuth', label: 'Light azimuth (°)', min: 0, max: 360, step: 5 },
    { kind: 'number', key: 'elevation', label: 'Light elevation (°)', min: 0, max: 90, step: 5 },
    { kind: 'number', key: 'shininess', label: 'Shininess', min: 1, max: 200, step: 1 },
    { kind: 'number', key: 'intensity', label: 'Intensity', min: 0, max: 4, step: 0.1 },
    { kind: 'number', key: 'matte', label: 'Matte darkening', min: 0, max: 1, step: 0.05 },
    {
      kind: 'number',
      key: 'heightStrength',
      label: 'Relief strength',
      min: 0,
      max: 10,
      step: 0.5,
      advanced: true,
    },
  ],
  defaultConfig: () => ({
    azimuth: 135,
    elevation: 45,
    shininess: 32,
    intensity: 1,
    matte: 0,
    heightStrength: 2,
  }),
  compute: ({ inputs, config }) => {
    const art = asImage(inputs.art);
    if (!art) return { preview: undefined, stats: undefined };
    const { image, coverage } = glossPreview(art, asImage(inputs.gloss), asImage(inputs.heightmap), {
      azimuth: num(config.azimuth, 135),
      elevation: num(config.elevation, 45),
      shininess: num(config.shininess, 32),
      intensity: num(config.intensity, 1),
      matte: num(config.matte, 0),
      heightStrength: num(config.heightStrength, 2),
    });
    const pct = (coverage * 100).toFixed(1);
    return {
      preview: image,
      stats: { kind: 'text', text: `Gloss coverage ${pct}% (aim 5–30%)` },
    };
  },
};

export const channelPackNode: NodeDefinition = {
  type: 'channelPack',
  label: 'Channel Pack',
  category: 'UV',
  description: 'Pack up to four greyscale inputs into R/G/B/A (e.g. roughness/metallic/AO).',
  autoRun: true,
  inputs: [
    { id: 'r', label: 'R', type: 'image' },
    { id: 'g', label: 'G', type: 'image' },
    { id: 'b', label: 'B', type: 'image' },
    { id: 'a', label: 'A', type: 'image' },
  ],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  defaultConfig: () => ({}),
  compute: ({ inputs }) => {
    const r = asImage(inputs.r);
    const g = asImage(inputs.g);
    const b = asImage(inputs.b);
    const a = asImage(inputs.a);
    if (!r && !g && !b && !a) return { out: undefined };
    return { out: channelPack({ r, g, b, a }) };
  },
};

export const noiseNode: NodeDefinition = {
  type: 'noise',
  label: 'Noise',
  category: 'Input',
  description: 'Generate seeded value noise (procedural greyscale texture).',
  autoRun: true,
  inputs: [],
  outputs: [{ id: 'out', label: 'Image', type: 'image' }],
  configFields: [
    { kind: 'number', key: 'width', label: 'Width', min: 1, step: 1 },
    { kind: 'number', key: 'height', label: 'Height', min: 1, step: 1 },
    { kind: 'number', key: 'scale', label: 'Scale (px/cell)', min: 1, step: 1 },
    { kind: 'number', key: 'seed', label: 'Seed', min: 0, step: 1 },
  ],
  defaultConfig: () => ({ width: 256, height: 256, scale: 24, seed: 1 }),
  compute: ({ config }) => ({
    out: valueNoise(
      Math.max(1, num(config.width, 256)),
      Math.max(1, num(config.height, 256)),
      Math.max(1, num(config.scale, 24)),
      num(config.seed, 1),
    ),
  }),
};

export const localNodes: NodeDefinition[] = [
  imageInputNode,
  promptInputNode,
  solidColorNode,
  gradientNode,
  combineNode,
  compareNode,
  applyMaskNode,
  flattenNode,
  invertNode,
  grayscaleNode,
  brightnessContrastNode,
  thresholdNode,
  autoThresholdNode,
  blurNode,
  sharpenNode,
  normalizeNode,
  histogramNode,
  curvesNode,
  opacityNode,
  tintNode,
  levelsNode,
  gradientMapNode,
  hueSaturationNode,
  whiteBalanceNode,
  edgeDetectNode,
  pixelateNode,
  vignetteNode,
  posterizeNode,
  outlineNode,
  alphaCleanupNode,
  cropNode,
  splitRegionNode,
  placeImageNode,
  resizeNode,
  rotateAngleNode,
  padNode,
  transformNode,
  extractChannelNode,
  highlightExtractNode,
  chromaKeyNode,
  removeColorNode,
  maskCombineNode,
  dilateNode,
  erodeNode,
  openCloseNode,
  despeckleNode,
  areaPickerNode,
  noiseNode,
  normalMapNode,
  glossPreviewNode,
  channelPackNode,
  seamlessTileNode,
  heightmapStlNode,
];
