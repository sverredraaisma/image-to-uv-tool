// Lenticular print node: interlace 2+ frames and emit the matching gloss lens
// array. The optics live in ../lib/lenticular; this file is the node wiring.

import type { NodeConfig, NodeDefinition } from '../types';
import {
  depthPreview,
  describeGeometry,
  interlacedSize,
  lenticularChunks,
  lensGeometry,
  outputSize,
  type LenticularSettings,
} from '../lib/lenticular';
import { runChunked } from '../lib/chunked';
import { asImages, num } from './helpers';

/** Read the seven print settings out of a node's config. */
export function settingsFromConfig(config: NodeConfig): LenticularSettings {
  return {
    widthMm: Math.max(0.01, num(config.widthMm, 100)),
    ppi: Math.max(1, num(config.ppi, 1440)),
    lpi: Math.max(1, num(config.lpi, 45)),
    phase: num(config.phase, 0),
    heightMm: Math.max(0.001, num(config.heightMm, 0.9)),
    ri: Math.max(1.0001, num(config.ri, 1.5)),
    orientationDeg: num(config.orientationDeg, 0),
    stripSamples: Math.max(1, num(config.stripSamples, 2)),
  };
}

export const lenticularNode: NodeDefinition = {
  type: 'lenticular',
  label: 'Lenticular Print',
  category: 'UV',
  description:
    'Interlace 2+ images under a lens array and emit the gloss lens array that focuses on them. ' +
    'Connect the frames in viewing order, or wire in a single Animation Input Sequence to print a whole ' +
    'GIF — its frames expand in place. Height/RI/LPI decide the lens sag and the flat base beneath it; ' +
    'open the editor for the 16-bit depth map and Height/RI/LPI calibration sheets. ' +
    'The depth map is on the PPI raster (it is the lens); the artwork is only as big as the interlace and ' +
    'the source images need — scale it to the sheet at print time. Manual: click Run.',
  // Manual: a 100 mm sheet at 1440 PPI is a ~32 MP two-buffer render.
  autoRun: false,
  customEditor: 'lenticular',
  inputs: [{ id: 'frames', label: 'Frames', type: 'image', multiple: true, required: true }],
  outputs: [
    { id: 'interlaced', label: 'Interlaced', type: 'image' },
    { id: 'depth', label: 'Gloss depth', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'widthMm', label: 'Width (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'ppi', label: 'PPI', min: 1, step: 10 },
    { kind: 'number', key: 'lpi', label: 'LPI', min: 1, step: 1 },
    { kind: 'number', key: 'phase', label: 'Phase (0–1)', min: 0, max: 1, step: 0.05 },
    { kind: 'number', key: 'heightMm', label: 'Height (mm)', min: 0.01, step: 0.05 },
    { kind: 'number', key: 'ri', label: 'RI', min: 1.01, max: 3, step: 0.01 },
    { kind: 'number', key: 'orientationDeg', label: 'Orientation (°)', min: -180, max: 180, step: 1 },
    {
      kind: 'number',
      key: 'stripSamples',
      label: 'Artwork px per frame strip',
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
    widthMm: 100,
    ppi: 1440,
    lpi: 45,
    phase: 0,
    heightMm: 0.9,
    // 1.5 is the usual cured clear-varnish / acrylic figure.
    ri: 1.5,
    orientationDeg: 0,
    stripSamples: 2,
    calibBands: 9,
    heightMin: 0.6,
    heightMax: 1.4,
    riMin: 1.4,
    riMax: 1.6,
    lpiMin: 40,
    lpiMax: 50,
    // On by default: a fixed height across an LPI sweep compares lenses with
    // different viewing cones, and coarse bands may not focus at all.
    lpiAutoHeight: true,
    // On by default: an evenly spaced LPI sweep lands almost entirely on
    // fractional pitches, and a fractional pitch is a second variable the
    // sheet cannot separate from the one it is meant to be measuring.
    lpiSnapPpl: true,
  }),
  compute: async ({ inputs, config, onProgress, signal, allowOversize }) => {
    const frames = asImages(inputs.frames);
    if (frames.length < 2) {
      throw new Error(`Lenticular print needs at least 2 images (got ${frames.length}).`);
    }
    const settings = settingsFromConfig(config);
    const depthSize = outputSize(settings, frames[0]);
    const artSize = interlacedSize(settings, frames);
    onProgress?.(`Interlacing ${frames.length} frames, lens map at ${depthSize.width}×${depthSize.height}…`);

    // Chunked: the run hands the UI back between bands of rows, so a big sheet
    // shows a progress bar and can be cancelled instead of freezing the tab.
    const render = await runChunked(lenticularChunks(frames, settings, { allowOversize }), {
      onProgress,
      signal,
    });
    return {
      interlaced: render.interlaced,
      depth: depthPreview(render),
      info: {
        kind: 'text',
        text: describeGeometry(settings, lensGeometry(settings), frames.length, depthSize, artSize),
      },
    };
  },
};

export const lenticularNodes: NodeDefinition[] = [lenticularNode];
