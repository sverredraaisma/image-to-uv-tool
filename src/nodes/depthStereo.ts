// Picture + heightmap → the run of views a Lenticular Print needs. The warp
// lives in ../lib/depthViews; this file is the node wiring and the report.
//
// The sibling node, Model → Stereo Views, has a mesh and can re-render the
// scene from every eye position. This one has one photograph and a depth map,
// so it slides pixels instead — the same projection, but a relief rather than a
// solid, which means it invents whatever a near edge uncovers. That trade is
// what the two extra Info lines at the bottom are about.

import type { ComputeContext, NodeConfig, NodeDefinition, RasterImage } from '../types';
import {
  MAX_VIEW_PX,
  MIN_VIEW_PX,
  clampSetbackMm,
  describePlacement,
  disparityAtDepth,
  eyeOffsetsMm,
  worstDisparity,
} from '../lib/render3d';
import {
  DEFAULT_EDGE_JUMP_PX,
  depthViewChunks,
  edgeWindowFor,
  workingSize,
  type DepthViewOptions,
  type DepthViewRender,
} from '../lib/depthViews';
import { runChunked } from '../lib/chunked';
import { MAX_HAZE_LENSLETS, coneFromConfig } from './model3d';
import { MAX_STEP_LENSLETS, MAX_VIEWS, MIN_VIEWS } from './modelStereo';
import { asImage, bool, num } from './helpers';

/**
 * Past this much of the frame invented, the warp is guessing more than it is
 * showing. A few tenths of a percent is normal — it is the sliver behind each
 * silhouette. Several percent means the depth range is asking a flat picture to
 * turn around.
 */
export const MAX_FILLED_FRACTION = 0.03;

/** Read the warp settings out of a node's config. */
export function depthViewOptionsFromConfig(config: NodeConfig): DepthViewOptions {
  const viewDistanceMm = Math.max(10, num(config.viewDistanceMm, 400));
  const viewPx = Math.round(num(config.viewPx, 0));
  return {
    views: Math.min(MAX_VIEWS, Math.max(MIN_VIEWS, Math.round(num(config.views, 12)))),
    widthMm: Math.max(1, num(config.widthMm, 100)),
    viewDistanceMm,
    depthMm: Math.max(0, num(config.depthMm, 5)),
    // Negative is a picture brought out through the plate; the warp holds it to
    // a sane distance in front (clampSetbackMm).
    setbackMm: clampSetbackMm(num(config.setbackMm, 0), viewDistanceMm),
    coneDeg: coneFromConfig(config),
    // 0 keeps the source's own width, which is usually what you want: the
    // photograph already has the detail it has.
    widthPx: viewPx > 0 ? Math.min(MAX_VIEW_PX, Math.max(MIN_VIEW_PX, viewPx)) : 0,
    invertDepth: bool(config.invertDepth, false),
    depthBlurPx: Math.max(0, num(config.depthBlurPx, 1)),
    edgeJumpPx: Math.max(0, num(config.edgeJumpPx, DEFAULT_EDGE_JUMP_PX)),
  };
}

/** Geometry report for the node's Info output. */
export function describeDepthViews(
  config: NodeConfig,
  o: DepthViewOptions,
  render: DepthViewRender,
): string {
  const lpi = Math.max(1, num(config.lpi, 45));
  const offsets = render.offsetsMm;
  const stepMm = offsets.length > 1 ? Math.abs(offsets[1] - offsets[0]) : 0;
  const D = o.viewDistanceMm;
  // Whichever plane moves most: the far one for a picture inside the window,
  // but the near one once it has been brought out through the plate, since
  // z/(D − z) grows faster in front of the sheet than behind it.
  const step = worstDisparity(stepMm, render.nearMm, render.farMm, D, lpi);
  const face =
    disparityAtDepth(stepMm, -render.nearMm, D, lpi).mm > disparityAtDepth(stepMm, -render.farMm, D, lpi).mm
      ? 'near'
      : 'far';
  const across = (Math.max(1, o.widthMm) * lpi) / 25.4;
  const view = render.views[0];
  const outer = offsets[offsets.length - 1];
  const fromLens = String(config.coneMode ?? 'lens') === 'lens';
  const invented = render.filledFraction * 100;

  const lines = [
    `${render.views.length} views · ${view.width}×${view.height} px each, warped from one picture`,
    `Sheet ${o.widthMm} mm wide, viewed from ${o.viewDistanceMm} mm`,
    `Cone ${o.coneDeg.toFixed(1)}°${
      fromLens
        ? ` (solved from ${lpi} LPI / ${num(config.lensHeightMm, 0.9)} mm / RI ${num(config.ri, 1.5)})`
        : ' (set by hand)'
    } — outer eye ${outer.toFixed(0)} mm off-axis, ${stepMm.toFixed(0)} mm per step`,
    ...describePlacement(render.nearMm, render.farMm, D, 'and the sheet edges occlude it as you move'),
    `Parallax ${step.lenslets.toFixed(2)} lenslets per view step at the ${face} plane ` +
      `(${step.mm.toFixed(3)} mm at ${lpi} LPI), ${(step.lenslets * (render.views.length - 1)).toFixed(2)} ` +
      `across the whole cone`,
    `Each view will print at ${Math.round(across)} px across — one pixel per lenticule`,
    `Invented ${invented.toFixed(2)}% of each view behind the silhouettes, widest strip ` +
      `${render.maxHolePx} px — a heightmap has nothing behind itself, so whatever a near edge ` +
      `uncovers is filled by stretching the background it uncovered`,
    `Silhouettes: a run stretching more than ${(o.edgeJumpPx ?? DEFAULT_EDGE_JUMP_PX).toFixed(1)} px ` +
      `across ±${edgeWindowFor(o.depthBlurPx)} px counts as an edge, and its gap is repainted from the ` +
      `background beyond it rather than from the blended pixels on the edge itself`,
  ];

  // A feature that moves more than a lenticule between adjacent views is never
  // sampled in between: it jumps instead of gliding, and the lens blur turns the
  // jump into a double image. This is the number that decides whether the print
  // reads as depth.
  if (step.lenslets > MAX_HAZE_LENSLETS) {
    lines.push(
      `⚠ ${step.lenslets.toFixed(2)} lenslets per step is far past the line — the ${face} plane will ` +
        `double rather than soften. Reduce Depth range, bring the Setback back toward 0, add views, ` +
        `or raise LPI.`,
    );
  } else if (step.lenslets > MAX_STEP_LENSLETS) {
    lines.push(
      `· ${step.lenslets.toFixed(2)} lenticules per step is over the ${MAX_STEP_LENSLETS} the lens can ` +
        `resolve, but not by much: the ${face} plane will read as haze rather than as detail. Keep the ` +
        `subject of the picture near the sheet plane, which stays sharp, and this is a depth cue rather ` +
        `than a fault. Past ${MAX_HAZE_LENSLETS} lenticules it becomes visible doubling.`,
    );
  } else if (step.lenslets < 0.15 && render.farMm > 0) {
    lines.push(
      `⚠ Only ${step.lenslets.toFixed(2)} lenslets per step — the views are nearly identical and the ` +
        `print will look flat. Raise Depth range, or push the Setback back.`,
    );
  }
  if (render.filledFraction > MAX_FILLED_FRACTION) {
    lines.push(
      `⚠ ${invented.toFixed(1)}% of the frame is invented. That is past what stretched background can ` +
        `hide: the silhouettes will drag. Reduce Depth range, or soften the depth map (raise Depth ` +
        `blur) so its edges are ramps rather than cliffs.`,
    );
  }
  if (view.width < across) {
    lines.push(
      `⚠ Views are ${view.width} px wide but the print resolves ${Math.round(across)} — they are being ` +
        `upsampled. Use a bigger source image, or set View width to at least ${Math.round(across)}.`,
    );
  }
  return lines.join('\n');
}

/** The image on an input port, ignoring a stray sequence's later frames. */
function gather(inputs: ComputeContext['inputs'], id: string): RasterImage | undefined {
  return asImage(inputs[id]);
}

export const depthStereoNode: NodeDefinition = {
  type: 'depthStereo',
  label: 'Image + Depth → Stereo Views',
  category: 'UV',
  description:
    'Turn one picture and its heightmap into the run of views a Lenticular Print needs, and send them ' +
    'down one wire into its Frames input. Each pixel slides sideways by an amount its depth decides — ' +
    'the same projection Model → Stereo Views uses, but from a relief instead of a mesh, so a photo or ' +
    'a generated image with a depth map becomes a 3D print without any geometry. The sheet is a window: ' +
    'white in the heightmap is the plane nearest you, and Setback places it against the glass. What a ' +
    'heightmap cannot do is show what is behind itself, so the strip a near edge uncovers is filled by ' +
    'stretching the background from beyond that edge — never from the blended pixels on it, which is ' +
    'what would smear the subject. Watch the invented-percentage in Info, and keep Depth range modest. ' +
    'Manual: click Run.',
  autoRun: false,
  inputs: [
    { id: 'image', label: 'Image', type: 'image', required: true },
    { id: 'depth', label: 'Heightmap', type: 'image', required: true },
  ],
  outputs: [
    { id: 'views', label: 'Views', type: 'sequence' },
    { id: 'depth', label: 'Depth (used)', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'views', label: 'Views', min: MIN_VIEWS, max: MAX_VIEWS, step: 1 },
    { kind: 'number', key: 'widthMm', label: 'Print width (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'depthMm', label: 'Depth range (mm)', min: 0, step: 1 },
    {
      kind: 'number',
      key: 'setbackMm',
      label: 'Setback behind the sheet (mm, negative comes out of it)',
      step: 1,
    },
    { kind: 'number', key: 'viewDistanceMm', label: 'Viewing distance (mm)', min: 10, step: 10 },
    { kind: 'boolean', key: 'invertDepth', label: 'Heightmap: white is far' },
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
      key: 'depthBlurPx',
      label: 'Depth blur (px)',
      min: 0,
      max: 32,
      step: 1,
      advanced: true,
    },
    {
      kind: 'number',
      key: 'edgeJumpPx',
      label: 'Edge jump (px)',
      min: 0,
      max: 32,
      step: 0.5,
      advanced: true,
    },
    {
      kind: 'number',
      key: 'viewPx',
      label: 'View width (px, 0 = the source’s own)',
      min: 0,
      max: MAX_VIEW_PX,
      step: 64,
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
    views: 12,
    widthMm: 100,
    // Modest on purpose. A relief has nothing behind it, and every millimetre of
    // depth widens the strip the warp has to invent; 5 mm at a 100 mm sheet is
    // plenty of relief and costs a fraction of a percent of the frame.
    depthMm: 5,
    // Right against the glass: the nearest plane of the picture touches the
    // sheet, so nothing floats in front of the paper edge.
    setbackMm: 0,
    viewDistanceMm: 400,
    invertDepth: false,
    coneMode: 'lens',
    lpi: 45,
    lensHeightMm: 0.9,
    ri: 1.5,
    coneDeg: 53,
    // One pixel of blur: enough to take the banding off an 8-bit depth map
    // without rounding the silhouettes the warp is about to cut along.
    depthBlurPx: 1,
    // A pixel and a half of stretch across the edge window is where a surface
    // turning away becomes a surface seen edge-on — and one seen that nearly
    // edge-on carries no detail worth dragging into the hole behind it.
    edgeJumpPx: DEFAULT_EDGE_JUMP_PX,
    viewPx: 0,
    mirrorViews: true,
  }),
  compute: async ({ inputs, config, onProgress, signal }) => {
    const image = gather(inputs, 'image');
    if (!image) throw new Error('Connect a picture to the Image input.');
    const depthImg = gather(inputs, 'depth');
    if (!depthImg) {
      throw new Error('Connect a heightmap to the Heightmap input (Depth Estimate, or any greyscale map).');
    }
    const o = depthViewOptionsFromConfig(config);
    const size = workingSize(image, o.widthPx);
    onProgress?.(`Warping ${o.views} views at ${size.width}×${size.height} px…`);
    // One chunk per view, so the run reports its way through the cone and can
    // be cancelled between passes rather than only at the end.
    const render = await runChunked(depthViewChunks(image, depthImg, o), { onProgress, signal });
    // The warp hands them back left eye first, which is honest but not what
    // gets printed: a lenticule shows its leftmost strip to an eye on the
    // *right*, and Lenticular Print interlaces frames in the order they arrive.
    // So the sequence goes out reversed, and the print comes out orthoscopic —
    // near things near. Turn the flag off to get pseudoscopic depth (inside
    // out), which is what the wrong order looks like if you ever see it.
    const views = bool(config.mirrorViews, true) ? [...render.views].reverse() : render.views;
    return {
      views: { kind: 'sequence', frames: views },
      depth: render.depth,
      info: { kind: 'text', text: describeDepthViews(config, o, render) },
    };
  },
};

/** Eye positions of the run, for tests and reports. */
export const depthEyeOffsets = (o: DepthViewOptions): number[] =>
  eyeOffsetsMm(o.views, o.coneDeg, o.viewDistanceMm);

export const depthStereoNodes: NodeDefinition[] = [depthStereoNode];
