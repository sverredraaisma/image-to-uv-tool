// Lens Grid node: the 2D sibling of Lenticular Print. Rows *and* columns of
// lenslets, so the sheet carries a whole grid of views instead of a strip and
// moves in both axes. The optics live in ../lib/lenticular.

import type { ComputeContext, NodeConfig, NodeDefinition, RasterImage } from '../types';
import {
  DEFAULT_GRID,
  clampGrid,
  clampPacking,
  depthPreview,
  describeGridGeometry,
  gridCellCounts,
  gridInterlacedSize,
  lensGeometry,
  outputSize,
  renderLensGrid,
  type LensGridSettings,
} from '../lib/lenticular';
import { lensGridCellInputs, lensGridInputs } from '../engine/ports';
import { settingsFromConfig } from './lenticular';
import { asImage, asImages, bool, num } from './helpers';

/** Read the print settings, plus the grid-only ones, out of a node's config. */
export function gridSettingsFromConfig(config: NodeConfig): LensGridSettings {
  return {
    ...settingsFromConfig(config),
    grid: clampGrid(num(config.grid, DEFAULT_GRID)),
    packing: clampPacking(config.packing),
    phaseY: num(config.phaseY, 0),
    mirrorViews: bool(config.mirrorViews, true),
  };
}

/**
 * Views in port order, or the labels of the cells still unconnected.
 *
 * A Sequence on the `views` port supplies the whole grid at once — that is how
 * Model → Grid Views feeds this node, and dragging 36 edges for a 6×6 by hand
 * would be absurd. Individual cell ports win where both are present, so you can
 * wire the sequence and then override one view with a retouched image.
 */
export function gatherViews(
  inputs: ComputeContext['inputs'],
  config: NodeConfig,
): RasterImage[] | { missing: string[] } {
  const bundled = asImages(inputs.views);
  const missing: string[] = [];
  const views: RasterImage[] = [];
  lensGridCellInputs(config).forEach((port, i) => {
    const img = asImage(inputs[port.id]) ?? bundled[i];
    if (img) views.push(img);
    else missing.push(port.label);
  });
  return missing.length ? { missing } : views;
}

export const lensGridNode: NodeDefinition = {
  type: 'lensGrid',
  label: 'Lens Grid Print',
  category: 'UV',
  description:
    'Interlace a grid of views under a 2D lens array (rows and columns of lenslets), so the print ' +
    'moves both left/right and up/down. Every input is named for where it is viewed from relative to ' +
    'head-on — Left · Up, Centre, Right · Down; or feed all of them down one wire from Model → Grid ' +
    'Views. Same optics and calibration sheets as Lenticular Print; ' +
    'a grid of N gives N² views, each resolving to one pixel per lenslet. Lenslets pack hexagonally by ' +
    'default (the densest arrangement, ~15% more lenses and less flat sheet than a square grid) — switch ' +
    'to Square grid to line them up in rows and columns instead. Manual: click Run.',
  autoRun: false,
  customEditor: 'lensGrid',
  // Ports are resolved per instance from `grid` (see engine/ports.ts); these
  // are the 3×3 defaults, so the static definition still describes the node.
  inputs: lensGridInputs({ grid: DEFAULT_GRID }),
  outputs: [
    { id: 'interlaced', label: 'Interlaced', type: 'image' },
    { id: 'depth', label: 'Gloss depth', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'grid', label: 'Grid (N × N views)', min: 2, max: 6, step: 1 },
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
    { kind: 'number', key: 'phase', label: 'Phase X (0–1)', min: 0, max: 1, step: 0.05 },
    { kind: 'number', key: 'phaseY', label: 'Phase Y (0–1)', min: 0, max: 1, step: 0.05 },
    { kind: 'number', key: 'heightMm', label: 'Height (mm)', min: 0.01, step: 0.05 },
    { kind: 'number', key: 'ri', label: 'RI', min: 1.01, max: 3, step: 0.01 },
    { kind: 'number', key: 'orientationDeg', label: 'Orientation (°)', min: -180, max: 180, step: 1 },
    {
      kind: 'boolean',
      key: 'mirrorViews',
      label: 'Mirror views (lens inversion)',
      advanced: true,
    },
    {
      kind: 'number',
      key: 'stripSamples',
      label: 'Artwork px per view tile',
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
  ],
  defaultConfig: () => ({
    grid: DEFAULT_GRID,
    packing: 'hex',
    widthMm: 100,
    ppi: 1440,
    lpi: 45,
    phase: 0,
    phaseY: 0,
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
  }),
  compute: async ({ inputs, config, onProgress }) => {
    const gathered = gatherViews(inputs, config);
    if ('missing' in gathered) {
      const n = clampGrid(num(config.grid, DEFAULT_GRID));
      throw new Error(
        `A ${n}×${n} lens grid needs all ${n * n} views. Missing: ${gathered.missing.join(', ')}.`,
      );
    }
    const settings = gridSettingsFromConfig(config);
    const depthSize = outputSize(settings, gathered[0]);
    const artSize = gridInterlacedSize(settings, gathered);
    onProgress?.(
      `Interlacing ${gathered.length} views at ${artSize.width}×${artSize.height}, ` +
        `lens map at ${depthSize.width}×${depthSize.height}…`,
    );
    // Let the spinner paint before the render locks the main thread.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const render = renderLensGrid(gathered, settings);
    return {
      interlaced: render.interlaced,
      depth: depthPreview(render),
      info: {
        kind: 'text',
        text: describeGridGeometry(
          settings,
          lensGeometry(settings),
          depthSize,
          artSize,
          gridCellCounts(settings, gathered[0]),
        ),
      },
    };
  },
};

export const lensGridNodes: NodeDefinition[] = [lensGridNode];
