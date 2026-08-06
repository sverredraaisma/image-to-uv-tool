// Picture → the run (or grid) of views that makes a print face the viewer.
//
// The warp lives in ../lib/facingViews; this file is the node wiring and the
// report. Its siblings all render a scene from several eye positions and let the
// lens rebuild the depth. This one has no depth to rebuild: it prints the *same*
// picture from every angle, pre-turned so that the sheet's own foreshortening
// cancels and the picture reads square on wherever you stand.

import type { ComputeContext, NodeConfig, NodeDefinition, RasterImage } from '../types';
import { DEFAULT_GRID, MAX_GRID, MIN_GRID, clampGrid, gridLabel } from '../lib/lenticular';
import { MAX_VIEW_PX, MIN_VIEW_PX } from '../lib/render3d';
import {
  coverScale,
  facingViewChunks,
  facingViewCount,
  facingViewSize,
  type FacingViewOptions,
  type FacingViewRender,
} from '../lib/facingViews';
import { runChunked } from '../lib/chunked';
import { coneFromConfig } from './model3d';
import { MAX_VIEWS, MIN_VIEWS } from './modelStereo';
import { asImage, bool, num, str } from './helpers';

/** Read the warp settings out of a node's config. */
export function facingViewOptionsFromConfig(config: NodeConfig): FacingViewOptions {
  const grid = clampGrid(num(config.grid, DEFAULT_GRID));
  return {
    layout: str(config.layout, '1d') === '2d' ? '2d' : '1d',
    views: Math.min(MAX_VIEWS, Math.max(MIN_VIEWS, Math.round(num(config.views, 12)))),
    grid,
    // No `gridY` is a graph saved before the grid could be oblong: square.
    gridY: clampGrid(num(config.gridY, grid)),
    widthMm: Math.max(1, num(config.widthMm, 100)),
    heightMm: Math.max(1, num(config.sheetHeightMm, 75)),
    widthPx: Math.min(MAX_VIEW_PX, Math.max(MIN_VIEW_PX, Math.round(num(config.viewPx, 512)))),
    viewDistanceMm: Math.max(10, num(config.viewDistanceMm, 400)),
    coneDeg: coneFromConfig(config),
    follow: Math.min(1, Math.max(0, num(config.follow, 1))),
    zoom: Math.max(1, num(config.zoom, 1)),
  };
}

/**
 * Under this much of the source left visible, the print is a detail of the
 * picture rather than the picture. It is not wrong — a tight crop is what makes
 * the movement obvious — but it is worth saying out loud.
 */
export const MIN_HEAD_ON_FRACTION = 0.25;

/** Geometry report for the node's Info output. */
export function describeFacingViews(
  config: NodeConfig,
  o: FacingViewOptions,
  render: FacingViewRender,
  source: RasterImage,
): string {
  const lpi = Math.max(1, num(config.lpi, 45));
  const across = (o.widthMm * lpi) / 25.4;
  const { width, height } = facingViewSize(o);
  const n = render.views.length;
  const fromLens = str(config.coneMode, 'lens') === 'lens';
  const eyes = render.eyesMm;
  const outer = eyes[eyes.length - 1] ?? { x: 0, y: 0 };
  // What one step of the head buys, in degrees of turn — the number that says
  // whether the pivot glides or snaps.
  const stepDeg = n > 1 ? (render.turnXDeg * 2) / (facingStepsAcross(o) || 1) : 0;
  const pictureW = Math.round(width * render.scale);

  const lines = [
    o.layout === '2d'
      ? `${gridLabel(Math.round(o.grid), Math.round(o.gridY ?? o.grid))} grid — ${n} views · ` +
        `${width}×${height} px each`
      : `${n} views across the cone · ${width}×${height} px each`,
    `Sheet ${o.widthMm}×${o.heightMm} mm, viewed from ${o.viewDistanceMm} mm`,
    `Cone ${o.coneDeg.toFixed(1)}°${
      fromLens
        ? ` (solved from ${lpi} LPI / ${num(config.lensHeightMm, 0.9)} mm / RI ${num(config.ri, 1.5)})`
        : ' (set by hand)'
    } — outer eye ${outer.x.toFixed(0)} mm across, ${Math.abs(outer.y).toFixed(0)} mm up`,
    `Turns ±${render.turnXDeg.toFixed(1)}° across` +
      (o.layout === '2d' ? ` and ±${render.turnYDeg.toFixed(1)}° up and down` : '') +
      ` about the centre of the picture, which stays put — at ${(o.follow * 100).toFixed(0)}% follow` +
      (o.follow >= 1 ? ', so it is square on from every view' : ' of the way to square on'),
    `Picture printed ${render.scale.toFixed(2)}× the sheet (${pictureW} px across), so the sheet is a ` +
      `${(render.headOnFraction * 100).toFixed(0)}% window on it head-on and the crop slides as you move`,
    `Source ${source.width}×${source.height} px, sampled at ${render.sourcePx.width}×${render.sourcePx.height}`,
    `Each view will print at ${Math.round(across)} px across — one pixel per lenticule`,
  ];
  if (n > 1 && stepDeg > 0) {
    lines.push(`${stepDeg.toFixed(1)}° of turn per view step`);
  }

  if (o.follow <= 0) {
    lines.push(
      '⚠ Follow is 0, so the picture never turns: every view is identical and this prints as an ' +
        'ordinary picture. Raise it towards 1.',
    );
  }
  if (render.headOnFraction < MIN_HEAD_ON_FRACTION) {
    lines.push(
      `· Only ${(render.headOnFraction * 100).toFixed(0)}% of the picture is on the sheet head-on — a ` +
        `wide cone and a full follow crop hard. Narrow the cone, lower Follow, or feed a picture with ` +
        `room around its subject.`,
    );
  }
  if (source.width < pictureW) {
    lines.push(
      `⚠ The picture prints ${pictureW} px across but the source is only ${source.width} — it is being ` +
        `enlarged ${(pictureW / Math.max(1, source.width)).toFixed(1)}×. Feed a bigger picture, or lower ` +
        `Zoom.`,
    );
  }
  if (width < across) {
    lines.push(
      `⚠ Rendering ${width} px wide but the print resolves ${Math.round(across)} — the views are being ` +
        `upsampled. Raise view pixels to at least ${Math.round(across)}.`,
    );
  }
  return lines.join('\n');
}

/** Steps between the outermost eyes on the axis the turn is reported for. */
function facingStepsAcross(o: FacingViewOptions): number {
  const n = o.layout === '2d' ? Math.max(1, Math.round(o.grid)) : Math.max(1, Math.round(o.views));
  return Math.max(1, n - 1);
}

function gatherImage(inputs: ComputeContext['inputs']): RasterImage | undefined {
  return asImage(inputs.image);
}

export const facingViewsNode: NodeDefinition = {
  type: 'facingViews',
  label: 'Image → Facing Views',
  category: 'UV',
  description:
    'Take one picture and print it so it turns to face you from wherever you stand. Each view is the ' +
    'picture on a plane pivoted about its own centre until it squares up to that eye, ray-traced back ' +
    'onto the sheet — so the foreshortening you would see at that angle is cancelled before it happens ' +
    'and the picture reads flat-on from every direction. A turned plane covers less of the sheet, so the ' +
    'picture is enlarged until it fills it from every view and the sheet edges crop it; the crop slides ' +
    'as you move, which is what sells the pivot. Horizontal run for a Lenticular Print, or a grid — X × Y ' +
    '— for a Lens Grid Print, which adds the up-and-down pivot too. Follow sets how far round it turns: ' +
    '1 is square on at every angle, lower lags behind you like a picture on a loose hinge. No depth map, ' +
    'no model, no invented pixels — just one image. Manual: click Run.',
  autoRun: false,
  inputs: [{ id: 'image', label: 'Picture', type: 'image', required: true }],
  outputs: [
    { id: 'views', label: 'Views', type: 'sequence' },
    { id: 'centre', label: 'Head-on view', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    {
      kind: 'select',
      key: 'layout',
      label: 'Layout',
      options: [
        { value: '1d', label: 'Horizontal run (Lenticular Print)' },
        { value: '2d', label: 'Grid, X × Y (Lens Grid Print)' },
      ],
    },
    { kind: 'number', key: 'views', label: 'Views (run)', min: MIN_VIEWS, max: MAX_VIEWS, step: 1 },
    { kind: 'number', key: 'grid', label: 'Grid: views across (X)', min: MIN_GRID, max: MAX_GRID, step: 1 },
    { kind: 'number', key: 'gridY', label: 'Grid: views down (Y)', min: MIN_GRID, max: MAX_GRID, step: 1 },
    { kind: 'number', key: 'follow', label: 'Follow (0–1)', min: 0, max: 1, step: 0.05 },
    { kind: 'number', key: 'widthMm', label: 'Print width (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'sheetHeightMm', label: 'Print height (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'viewDistanceMm', label: 'Viewing distance (mm)', min: 10, step: 10 },
    { kind: 'number', key: 'viewPx', label: 'View width (px)', min: MIN_VIEW_PX, max: MAX_VIEW_PX, step: 32 },
    {
      kind: 'select',
      key: 'coneMode',
      label: 'View cone',
      options: [
        { value: 'lens', label: 'From the lens (LPI · gloss height · RI)' },
        { value: 'manual', label: 'Set by hand' },
      ],
    },
    { kind: 'number', key: 'lpi', label: 'LPI (lenticules/inch)', min: 1, step: 1 },
    { kind: 'number', key: 'lensHeightMm', label: 'Gloss height (mm)', min: 0.01, step: 0.05 },
    { kind: 'number', key: 'ri', label: 'RI', min: 1.01, max: 3, step: 0.01 },
    { kind: 'number', key: 'coneDeg', label: 'Cone by hand (°)', min: 1, max: 170, step: 1 },
    {
      kind: 'number',
      key: 'zoom',
      label: 'Zoom (× the minimum crop)',
      min: 1,
      max: 4,
      step: 0.05,
      advanced: true,
    },
    {
      kind: 'boolean',
      key: 'mirrorViews',
      label: 'Order for the lens (right eye first)',
      advanced: true,
    },
  ],
  defaultConfig: () => ({
    layout: '1d',
    // A dozen across the cone: 4–5° of turn per step at the defaults, which is
    // small enough that the pivot glides rather than clicking round.
    views: 12,
    grid: DEFAULT_GRID,
    gridY: DEFAULT_GRID,
    follow: 1,
    widthMm: 100,
    sheetHeightMm: 75,
    viewDistanceMm: 400,
    viewPx: 512,
    coneMode: 'lens',
    lpi: 45,
    lensHeightMm: 0.9,
    ri: 1.5,
    coneDeg: 53,
    // 1 is the smallest picture that still covers the sheet from every view —
    // the most of the source you can keep. Above it the crop tightens and the
    // movement gets showier, which is a taste, not a default.
    zoom: 1,
    mirrorViews: true,
  }),
  compute: async ({ inputs, config, onProgress, signal }) => {
    const image = gatherImage(inputs);
    if (!image) throw new Error('Connect a picture to the Picture input.');
    const o = facingViewOptionsFromConfig(config);
    const n = facingViewCount(o);
    onProgress?.(
      `Turning the picture through ${n} views at ${facingViewSize(o).width} px ` +
        `(${coverScale(o).toFixed(2)}× the sheet)…`,
    );
    // One chunk per view: the run reports its way round the cone and can be
    // cancelled between passes rather than only at the end.
    const render = await runChunked(facingViewChunks(image, o), { onProgress, signal });
    // A run goes out reversed for the lens — a lenticule shows its leftmost
    // strip to an eye on the right, and Lenticular Print interlaces frames in
    // the order they arrive. A grid goes out in cell order, which is what Lens
    // Grid Print reads and which it inverts itself.
    const views =
      o.layout === '1d' && bool(config.mirrorViews, true) ? [...render.views].reverse() : render.views;
    return {
      views: { kind: 'sequence', frames: views },
      centre: render.views[render.views.length >> 1],
      info: { kind: 'text', text: describeFacingViews(config, o, render, image) },
    };
  },
};

export const facingViewsNodes: NodeDefinition[] = [facingViewsNode];
