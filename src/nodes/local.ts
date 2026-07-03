// Local, browser-side node definitions (no network). Most are auto-run.

import type { ConfigField, NodeConfig, NodeDefinition, RasterImage } from '../types';
import { platform } from '../lib/platform';
import {
  alphaCleanup,
  applyMask,
  boxBlur,
  brightnessContrast,
  colorKeyMask,
  combine,
  createImage,
  crop,
  downscaleToMax,
  extractChannel,
  flatten,
  gradientMap,
  grayscale,
  hexToRgba,
  hueSaturation,
  invert,
  levels,
  maskCombine,
  morphology,
  outline,
  pixelate,
  posterize,
  resize,
  sharpen,
  sobel,
  threshold,
  vignette,
  transform,
  type AlphaCleanupMode,
  type Channel,
  type CombineMode,
  type MaskOp,
  type TransformOp,
} from '../lib/image';
import { magicWandMask, type Point } from '../lib/magicWand';
import { heightmapToStl } from '../lib/stl';
import { asImage, bool, num, str } from './helpers';

/**
 * Helper for the very common single-image-in / single-image-out, auto-run node.
 * Keeps the many pixel-op nodes free of boilerplate.
 */
function singleImageOp(opts: {
  type: string;
  label: string;
  category: string;
  description?: string;
  configFields?: ConfigField[];
  defaultConfig?: () => NodeConfig;
  op: (img: RasterImage, config: NodeConfig) => RasterImage;
}): NodeDefinition {
  return {
    type: opts.type,
    label: opts.label,
    category: opts.category,
    description: opts.description,
    autoRun: true,
    inputs: [{ id: 'in', label: 'Image', type: 'image' }],
    outputs: [{ id: 'out', label: 'Image', type: 'image' }],
    configFields: opts.configFields,
    defaultConfig: opts.defaultConfig ?? (() => ({})),
    compute: ({ inputs, config }) => {
      const img = asImage(inputs.in);
      if (!img) return { out: undefined };
      return { out: opts.op(img, config) };
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
  configFields: [
    { kind: 'number', key: 'maxSize', label: 'Max size (px, 0 = original)', min: 0, step: 64 },
  ],
  defaultConfig: () => ({ src: '', name: '', maxSize: 0 }),
  compute: async ({ config }) => {
    const src = str(config.src);
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

export const blurNode = singleImageOp({
  type: 'blur',
  label: 'Box Blur',
  category: 'Adjust',
  description: 'Blur by an adjustable pixel radius.',
  configFields: [{ kind: 'number', key: 'radius', label: 'Radius', min: 0, max: 100, step: 1 }],
  defaultConfig: () => ({ radius: 2 }),
  op: (img, config) => boxBlur(img, num(config.radius, 2)),
});

export const sharpenNode = singleImageOp({
  type: 'sharpen',
  label: 'Sharpen',
  category: 'Adjust',
  description: 'Unsharp-mask sharpening.',
  configFields: [{ kind: 'number', key: 'amount', label: 'Amount', min: 0, max: 5, step: 0.1 }],
  defaultConfig: () => ({ amount: 1 }),
  op: (img, config) => sharpen(img, num(config.amount, 1)),
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
  op: (img) => sobel(img),
});

export const pixelateNode = singleImageOp({
  type: 'pixelate',
  label: 'Pixelate',
  category: 'Adjust',
  description: 'Mosaic / blocky pixelation.',
  configFields: [{ kind: 'number', key: 'blockSize', label: 'Block size', min: 1, max: 128, step: 1 }],
  defaultConfig: () => ({ blockSize: 8 }),
  op: (img, config) => pixelate(img, num(config.blockSize, 8)),
});

export const vignetteNode = singleImageOp({
  type: 'vignette',
  label: 'Vignette',
  category: 'Adjust',
  description: 'Darken towards the corners.',
  configFields: [{ kind: 'number', key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.05 }],
  defaultConfig: () => ({ strength: 0.5 }),
  op: (img, config) => vignette(img, num(config.strength, 0.5)),
});

export const posterizeNode = singleImageOp({
  type: 'posterize',
  label: 'Posterize',
  category: 'Adjust',
  description: 'Reduce each colour channel to a limited number of levels.',
  configFields: [{ kind: 'number', key: 'levels', label: 'Levels', min: 2, max: 64, step: 1 }],
  defaultConfig: () => ({ levels: 4 }),
  op: (img, config) => posterize(img, num(config.levels, 4)),
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
  op: (img, config) =>
    outline(img, num(config.thickness, 4), hexToRgba(str(config.color, '#000000'), 255), num(config.alphaThreshold, 0)),
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
    crop(img, num(config.x, 0), num(config.y, 0), num(config.width, img.width), num(config.height, img.height)),
});

export const resizeNode = singleImageOp({
  type: 'resize',
  label: 'Resize',
  category: 'Transform',
  description: 'Resize to a target width/height (nearest-neighbour).',
  configFields: [
    { kind: 'number', key: 'width', label: 'Width', min: 1, step: 1 },
    { kind: 'number', key: 'height', label: 'Height', min: 1, step: 1 },
  ],
  defaultConfig: () => ({ width: 256, height: 256 }),
  op: (img, config) =>
    resize(img, Math.max(1, num(config.width, img.width)), Math.max(1, num(config.height, img.height))),
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
      ],
    },
  ],
  defaultConfig: () => ({ channel: 'lum' satisfies Channel }),
  op: (img, config) => extractChannel(img, str(config.channel, 'lum') as Channel),
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
  op: (img, config) => morphology(img, num(config.radius, 2), 'dilate'),
});

export const erodeNode = singleImageOp({
  type: 'erode',
  label: 'Erode',
  category: 'Mask',
  description: 'Shrink bright / white regions (greyscale erosion).',
  configFields: [{ kind: 'number', key: 'radius', label: 'Radius', min: 0, max: 50, step: 1 }],
  defaultConfig: () => ({ radius: 2 }),
  op: (img, config) => morphology(img, num(config.radius, 2), 'erode'),
});

export const areaPickerNode: NodeDefinition = {
  type: 'areaPicker',
  label: 'Area Picker',
  category: 'Mask',
  description: 'Click points on the image to magic-wand select areas; outputs a mask.',
  autoRun: true,
  inputs: [{ id: 'in', label: 'Image', type: 'image' }],
  outputs: [{ id: 'out', label: 'Mask', type: 'mask' }],
  configFields: [{ kind: 'number', key: 'tolerance', label: 'Tolerance', min: 0, max: 255, step: 1 }],
  customEditor: 'areaPicker',
  defaultConfig: () => ({ points: [] as Point[], tolerance: 32 }),
  compute: ({ inputs, config }) => {
    const img = asImage(inputs.in);
    if (!img) return { out: undefined };
    const points = Array.isArray(config.points) ? (config.points as Point[]) : [];
    return { out: magicWandMask(img, points, num(config.tolerance, 32)) };
  },
};

// ---- Export ----

export const heightmapStlNode: NodeDefinition = {
  type: 'heightmapStl',
  label: 'Heightmap → STL',
  category: 'Export',
  description: 'Turn a heightmap into an STL solid (white = tall). Resize large images first.',
  autoRun: true,
  inputs: [{ id: 'in', label: 'Heightmap', type: 'image' }],
  outputs: [{ id: 'out', label: 'STL', type: 'stl' }],
  configFields: [
    { kind: 'number', key: 'minWhite', label: 'Min white (-1 = all)', min: -1, max: 255, step: 1 },
    { kind: 'number', key: 'baseThickness', label: 'Base thickness', min: 0, step: 0.1 },
    { kind: 'number', key: 'depthRange', label: 'Depth range', min: 0, step: 0.1 },
    { kind: 'number', key: 'width', label: 'Width (units)', min: 0.0001, step: 1 },
  ],
  defaultConfig: () => ({ minWhite: 1, baseThickness: 0, depthRange: 10, width: 100 }),
  compute: ({ inputs, config }) => {
    const img = asImage(inputs.in);
    if (!img) return { out: undefined };
    return {
      out: heightmapToStl(img, {
        minWhite: num(config.minWhite, 1),
        baseThickness: num(config.baseThickness, 0),
        depthRange: num(config.depthRange, 10),
        width: num(config.width, 100),
      }),
    };
  },
};

export const localNodes: NodeDefinition[] = [
  imageInputNode,
  promptInputNode,
  solidColorNode,
  combineNode,
  applyMaskNode,
  flattenNode,
  invertNode,
  grayscaleNode,
  brightnessContrastNode,
  thresholdNode,
  blurNode,
  sharpenNode,
  levelsNode,
  gradientMapNode,
  hueSaturationNode,
  edgeDetectNode,
  pixelateNode,
  vignetteNode,
  posterizeNode,
  outlineNode,
  alphaCleanupNode,
  cropNode,
  resizeNode,
  transformNode,
  extractChannelNode,
  chromaKeyNode,
  maskCombineNode,
  dilateNode,
  erodeNode,
  areaPickerNode,
  heightmapStlNode,
];
