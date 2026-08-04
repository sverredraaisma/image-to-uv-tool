// Radial Lens Print node: the rotational sibling of Lens Grid Print. The same
// cap array, but the artwork under each lenslet is cut into angular wedges
// instead of a square grid of tiles, so a view occupies a *bearing* — walk
// around the print and the views take turns. The optics live in ../lib/lenticular.

import type { ComputeContext, NodeConfig, NodeDefinition, RasterImage } from '../types';
import {
  DEFAULT_RADIAL_VIEWS,
  MAX_RADIAL_VIEWS,
  MIN_RADIAL_VIEWS,
  clampPacking,
  clampRadialViews,
  depthPreview,
  describeRadialGeometry,
  gridCellCounts,
  lensGeometry,
  outputSize,
  radialChunks,
  radialInterlacedSize,
  type RadialSettings,
} from '../lib/lenticular';
import { runChunked } from '../lib/chunked';
import { radialInputs, radialViewInputs } from '../engine/ports';
import { settingsFromConfig } from './lenticular';
import { asImage, asImages, bool, num } from './helpers';

/** Read the print settings, plus the radial-only ones, out of a node's config. */
export function radialSettingsFromConfig(config: NodeConfig): RadialSettings {
  return {
    ...settingsFromConfig(config),
    views: clampRadialViews(num(config.views, DEFAULT_RADIAL_VIEWS)),
    packing: clampPacking(config.packing),
    phaseY: num(config.phaseY, 0),
    spin: num(config.spin, 0),
    mirrorViews: bool(config.mirrorViews, true),
  };
}

/** Views in port order, or the labels of the bearings still unconnected. */
export function gatherRadialViews(
  inputs: ComputeContext['inputs'],
  config: NodeConfig,
): RasterImage[] | { missing: string[] } {
  const bundled = asImages(inputs.all);
  const missing: string[] = [];
  const views: RasterImage[] = [];
  radialViewInputs(config).forEach((port, i) => {
    const img = asImage(inputs[port.id]) ?? bundled[i];
    if (img) views.push(img);
    else missing.push(port.label);
  });
  return missing.length ? { missing } : views;
}

export const radialGridNode: NodeDefinition = {
  type: 'radialGrid',
  label: 'Radial Lens Print',
  category: 'UV',
  description:
    'Spread N images around a circle under a lens array, so each one is visible from the bearing it ' +
    'occupies and all of them merge into one when you look head-on. Same caps and same calibration as ' +
    'Lens Grid Print, but the artwork under each lenslet is cut into angular wedges rather than a grid ' +
    'of tiles: every wedge meets its neighbours at the centre of the lenslet, which is the point the eye ' +
    'sits on when it is square to the sheet — so head-on you see the whole set averaged together, and ' +
    'tilting in any direction hands the sheet to the view that owns that angle. Inputs are named for the ' +
    'bearing they are seen from (0° · Right, 90° · Up, …), or feed the whole ring down one wire. ' +
    'Manual: click Run.',
  autoRun: false,
  customEditor: 'radialGrid',
  // Ports are resolved per instance from `views` (see engine/ports.ts); these
  // are the 6-view defaults, so the static definition still describes the node.
  inputs: radialInputs({ views: DEFAULT_RADIAL_VIEWS }),
  outputs: [
    { id: 'interlaced', label: 'Interlaced', type: 'image' },
    { id: 'depth', label: 'Gloss depth', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    {
      kind: 'number',
      key: 'views',
      label: 'Views around the circle',
      min: MIN_RADIAL_VIEWS,
      max: MAX_RADIAL_VIEWS,
      step: 1,
    },
    {
      kind: 'select',
      key: 'packing',
      label: 'Lenslet packing',
      options: [
        { value: 'hex', label: 'Hexagonal (densest, 90.7% fill)' },
        { value: 'square', label: 'Square grid (78.5% fill)' },
      ],
    },
    { kind: 'number', key: 'widthMm', label: 'Width (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'ppi', label: 'PPI', min: 1, step: 10 },
    { kind: 'number', key: 'lpi', label: 'LPI (lenslets/inch)', min: 1, step: 1 },
    { kind: 'number', key: 'heightMm', label: 'Height (mm)', min: 0.01, step: 0.05 },
    { kind: 'number', key: 'ri', label: 'RI', min: 1.01, max: 3, step: 0.01 },
    { kind: 'number', key: 'orientationDeg', label: 'Orientation (°)', min: -180, max: 180, step: 1 },
    { kind: 'number', key: 'spin', label: 'Spin the wedges (0–1 of a step)', min: 0, max: 1, step: 0.05 },
    { kind: 'number', key: 'phase', label: 'Phase X (0–1)', min: 0, max: 1, step: 0.05, advanced: true },
    { kind: 'number', key: 'phaseY', label: 'Phase Y (0–1)', min: 0, max: 1, step: 0.05, advanced: true },
    {
      kind: 'boolean',
      key: 'mirrorViews',
      label: 'Mirror views (lens inversion)',
      advanced: true,
    },
    {
      kind: 'number',
      key: 'stripSamples',
      label: 'Artwork px per wedge',
      min: 1,
      max: 16,
      step: 1,
      advanced: true,
    },
    {
      kind: 'number',
      key: 'calibBands',
      label: 'Calibration bands',
      min: 2,
      max: 64,
      step: 1,
      advanced: true,
    },
    {
      kind: 'number',
      key: 'heightMin',
      label: 'Height calib. min (mm)',
      min: 0.01,
      step: 0.05,
      advanced: true,
    },
    {
      kind: 'number',
      key: 'heightMax',
      label: 'Height calib. max (mm)',
      min: 0.01,
      step: 0.05,
      advanced: true,
    },
    { kind: 'number', key: 'riMin', label: 'RI calib. min', min: 1.01, max: 3, step: 0.01, advanced: true },
    { kind: 'number', key: 'riMax', label: 'RI calib. max', min: 1.01, max: 3, step: 0.01, advanced: true },
    { kind: 'number', key: 'lpiMin', label: 'LPI calib. min', min: 1, step: 1, advanced: true },
    { kind: 'number', key: 'lpiMax', label: 'LPI calib. max', min: 1, step: 1, advanced: true },
    {
      kind: 'boolean',
      key: 'lpiAutoHeight',
      label: 'LPI calib.: auto height (match viewing angle)',
      advanced: true,
    },
    {
      kind: 'boolean',
      key: 'lpiSnapPpl',
      label: 'LPI calib.: snap to whole pixels per lens',
      advanced: true,
    },
  ],
  defaultConfig: () => ({
    views: DEFAULT_RADIAL_VIEWS,
    packing: 'hex',
    widthMm: 100,
    ppi: 1440,
    lpi: 45,
    phase: 0,
    phaseY: 0,
    spin: 0,
    heightMm: 0.9,
    ri: 1.5,
    orientationDeg: 0,
    mirrorViews: true,
    stripSamples: 2,
    calibBands: 9,
    heightMin: 0.6,
    heightMax: 1.4,
    riMin: 1.4,
    riMax: 1.6,
    lpiMin: 40,
    lpiMax: 50,
    lpiAutoHeight: true,
    // On by default: an evenly spaced LPI sweep lands almost entirely on
    // fractional pitches, and a fractional pitch is a second variable the
    // sheet cannot separate from the one it is meant to be measuring.
    lpiSnapPpl: true,
  }),
  compute: async ({ inputs, config, onProgress, signal, allowOversize }) => {
    const gathered = gatherRadialViews(inputs, config);
    if ('missing' in gathered) {
      const n = clampRadialViews(num(config.views, DEFAULT_RADIAL_VIEWS));
      throw new Error(
        `A ${n}-view radial array needs all ${n} views. Missing: ${gathered.missing.join(', ')}.`,
      );
    }
    const settings = radialSettingsFromConfig(config);
    const depthSize = outputSize(settings, gathered[0]);
    const artSize = radialInterlacedSize(settings, gathered);
    onProgress?.(
      `Interlacing ${gathered.length} views at ${artSize.width}×${artSize.height}, ` +
        `lens map at ${depthSize.width}×${depthSize.height}…`,
    );
    // Chunked: the run hands the UI back between bands of rows, so a big sheet
    // shows a progress bar and can be cancelled instead of freezing the tab.
    const render = await runChunked(radialChunks(gathered, settings, { allowOversize }), {
      onProgress,
      signal,
    });
    return {
      interlaced: render.interlaced,
      depth: depthPreview(render),
      info: {
        kind: 'text',
        text: describeRadialGeometry(
          settings,
          lensGeometry(settings),
          depthSize,
          artSize,
          // One pixel per lenslet, exactly as the grid resolves — the wedges
          // divide the angle, not the sheet.
          gridCellCounts({ ...settings, grid: 2, mirrorViews: true }, gathered[0]),
        ),
      },
    };
  },
};

export const radialGridNodes: NodeDefinition[] = [radialGridNode];
