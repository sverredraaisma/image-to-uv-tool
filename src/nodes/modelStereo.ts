// 3D model → the run of views a Lenticular Print needs, with the sheet acting
// as a window the subject stands behind. The optics live in ../lib/render3d;
// this file is the node wiring and the report.

import type { ComputeContext, NodeConfig, NodeDefinition, RasterImage, StlValue } from '../types';
import { MAX_IMPORT_TRIANGLES } from '../lib/stl';
import {
  MAX_VIEW_PX,
  MIN_VIEW_PX,
  disparityAtDepth,
  eyeOffsetsMm,
  renderViewSequence,
  type ViewSequenceOptions,
  type ViewSequenceRender,
} from '../lib/render3d';
import { coneFromConfig } from './model3d';
import { asImage, bool, num, str } from './helpers';

/** Fewest and most views a run can carry. */
export const MIN_VIEWS = 2;
export const MAX_VIEWS = 32;

/** More than this much movement per view step and the print ghosts. */
export const MAX_STEP_LENSLETS = 1.5;

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [216, 212, 204];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Read the render settings out of a node's config. */
export function viewSequenceOptionsFromConfig(config: NodeConfig): ViewSequenceOptions {
  return {
    views: Math.min(MAX_VIEWS, Math.max(MIN_VIEWS, Math.round(num(config.views, 12)))),
    widthMm: Math.max(1, num(config.widthMm, 100)),
    heightMm: Math.max(1, num(config.sheetHeightMm, 75)),
    widthPx: Math.min(MAX_VIEW_PX, Math.max(MIN_VIEW_PX, Math.round(num(config.viewPx, 512)))),
    viewDistanceMm: Math.max(10, num(config.viewDistanceMm, 400)),
    depthMm: Math.max(0, num(config.depthMm, 5)),
    setbackMm: Math.max(0, num(config.setbackMm, 0)),
    coneDeg: coneFromConfig(config),
    rotationDeg: [num(config.rotX, 0), num(config.rotY, 0), num(config.rotZ, 0)],
    margin: Math.min(0.4, Math.max(0, num(config.margin, 0.08))),
    supersample: Math.min(4, Math.max(1, Math.round(num(config.supersample, 2)))),
    shading: {
      lightAzimuthDeg: num(config.lightAzimuthDeg, -30),
      lightElevationDeg: num(config.lightElevationDeg, 35),
      ambient: Math.min(1, Math.max(0, num(config.ambient, 0.25))),
      colour: hexToRgb(str(config.colour, '#d8d4cc')),
      background: hexToRgb(str(config.background, '#ffffff')),
    },
  };
}

/** Which of texture / vertex colour / material colour this render will use. */
function surfaceUsed(stl: StlValue, o: ViewSequenceOptions): string {
  if (o.texture) {
    return stl.uvs
      ? `texture, ${o.texture.width}×${o.texture.height} px, through the mesh’s own UVs`
      : '⚠ a texture is wired in but the mesh has no texture coordinates — an STL never does. Export as OBJ with UVs, or unplug it';
  }
  if (stl.uvs && stl.colours) return 'vertex colours (the mesh has UVs too — wire a Texture to use them)';
  if (stl.uvs) return 'material colour — the mesh has UVs, so wiring a Texture would use them';
  if (stl.colours) return 'the mesh’s own vertex colours';
  return 'flat material colour, lit by the light settings';
}

/** Geometry report for the node's Info output. */
export function describeViewSequence(
  config: NodeConfig,
  o: ViewSequenceOptions,
  stl: StlValue,
  render: ViewSequenceRender,
): string {
  const lpi = Math.max(1, num(config.lpi, 45));
  const offsets = render.offsetsMm;
  const stepMm = offsets.length > 1 ? Math.abs(offsets[1] - offsets[0]) : 0;
  // Behind the sheet z is negative, and the far face is the extreme.
  const step = disparityAtDepth(stepMm, -render.farMm, o.viewDistanceMm, lpi);
  const across = (Math.max(1, o.widthMm) * lpi) / 25.4;
  const viewPy = Math.round((o.widthPx * o.heightMm) / o.widthMm);
  const outer = offsets[offsets.length - 1];
  const fromLens = str(config.coneMode, 'lens') === 'lens';
  // How much smaller the far face lands than the near one, through the window.
  const D = o.viewDistanceMm;
  const shrink = (D + render.nearMm) / (D + render.farMm);

  const lines = [
    `${o.views} views · ${o.widthPx}×${viewPy} px each · ${stl.triangleCount.toLocaleString()} triangles`,
    `Sheet ${o.widthMm}×${o.heightMm} mm, viewed from ${o.viewDistanceMm} mm`,
    `Cone ${o.coneDeg.toFixed(1)}°${
      fromLens
        ? ` (solved from ${lpi} LPI / ${num(config.lensHeightMm, 0.9)} mm / RI ${num(config.ri, 1.5)})`
        : ' (set by hand)'
    } — outer eye ${outer.toFixed(0)} mm off-axis, ${stepMm.toFixed(0)} mm per step`,
    `Window: the subject stands ${render.nearMm.toFixed(1)}–${render.farMm.toFixed(1)} mm behind the ` +
      `sheet, all of it. Nothing crosses the plane, so nothing can float in front of the paper edge ` +
      `and be cut off by it`,
    `Fitted at the near face, scaled ×${((D + render.nearMm) / D).toFixed(3)} to fill the window from ` +
      `there; the far face lands ${((1 - shrink) * 100).toFixed(1)}% smaller, which is the perspective ` +
      `doing the work`,
    `Covers ${(render.coverage * 100).toFixed(0)}% of the frame`,
    `Surface: ${surfaceUsed(stl, o)}`,
    `Parallax ${step.lenslets.toFixed(2)} lenslets per view step at the far face ` +
      `(${step.mm.toFixed(3)} mm at ${lpi} LPI), ${(step.lenslets * (o.views - 1)).toFixed(2)} across the ` +
      `whole cone`,
    `Each view will print at ${Math.round(across)} px across — one pixel per lenticule`,
  ];

  // A feature that moves more than a lenticule between adjacent views is never
  // sampled in between: it jumps instead of gliding, and the lens blur turns the
  // jump into a double image. This is the number that decides whether the print
  // reads as depth.
  if (step.lenslets > MAX_STEP_LENSLETS) {
    lines.push(
      `⚠ ${step.lenslets.toFixed(2)} lenslets per step is too much — the print will ghost rather than ` +
        `read as depth. Reduce Subject depth or Setback, add views, or raise LPI.`,
    );
  } else if (step.lenslets < 0.15 && render.farMm > 0) {
    lines.push(
      `⚠ Only ${step.lenslets.toFixed(2)} lenslets per step — the views are nearly identical and the ` +
        `print will look flat. Raise Subject depth, or push the Setback back.`,
    );
  }
  if (o.widthPx < across) {
    lines.push(
      `⚠ Rendering ${o.widthPx} px wide but the print resolves ${Math.round(across)} — the views are ` +
        `being upsampled. Raise view pixels to at least ${Math.round(across)}.`,
    );
  }
  if (render.coverage < 0.02) {
    lines.push('⚠ The subject barely covers the frame — check the rotation, or lower Margin.');
  }
  return lines.join('\n');
}

function gatherMesh(inputs: ComputeContext['inputs']): StlValue | undefined {
  const v = Array.isArray(inputs.model) ? inputs.model[0] : inputs.model;
  return v && v.kind === 'stl' ? v : undefined;
}

export const modelStereoNode: NodeDefinition = {
  type: 'modelStereo',
  label: 'Model → Stereo Views',
  category: 'UV',
  description:
    'Render a mesh as if it stood behind the print, and send the whole run of views down one wire into ' +
    'Lenticular Print’s Frames input. The sheet is a window: the subject sits entirely behind it, so it ' +
    'recedes into the paper instead of floating in front of it, and the edges of the sheet occlude it as ' +
    'you move — which is where most of the depth you actually see comes from. The eye slides sideways ' +
    'and never rotates, so the window plane stays pin-sharp in every view; the run spans the lens’s own ' +
    'viewing cone. Subject depth and Setback place the box behind the glass; watch the parallax figure ' +
    'in Info, since more than ~1.5 lenticules per view step ghosts. Manual: click Run.',
  autoRun: false,
  inputs: [
    { id: 'model', label: 'Mesh', type: 'stl', required: true },
    { id: 'texture', label: 'Texture', type: 'image' },
  ],
  outputs: [
    { id: 'views', label: 'Views', type: 'sequence' },
    { id: 'depth', label: 'Depth (centre)', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'views', label: 'Views', min: MIN_VIEWS, max: MAX_VIEWS, step: 1 },
    { kind: 'number', key: 'widthMm', label: 'Print width (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'sheetHeightMm', label: 'Print height (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'depthMm', label: 'Subject depth (mm)', min: 0, step: 1 },
    { kind: 'number', key: 'setbackMm', label: 'Setback behind the sheet (mm)', min: 0, step: 1 },
    { kind: 'number', key: 'viewDistanceMm', label: 'Viewing distance (mm)', min: 10, step: 10 },
    { kind: 'number', key: 'viewPx', label: 'View width (px)', min: MIN_VIEW_PX, max: MAX_VIEW_PX, step: 32 },
    { kind: 'number', key: 'rotX', label: 'Rotate X (°)', min: -180, max: 180, step: 5 },
    { kind: 'number', key: 'rotY', label: 'Rotate Y (°)', min: -180, max: 180, step: 5 },
    { kind: 'number', key: 'rotZ', label: 'Rotate Z (°)', min: -180, max: 180, step: 5 },
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
      kind: 'boolean',
      key: 'mirrorViews',
      label: 'Order for the lens (right eye first)',
      advanced: true,
    },
    { kind: 'color', key: 'colour', label: 'Model colour', advanced: true },
    { kind: 'color', key: 'background', label: 'Background', advanced: true },
    { kind: 'number', key: 'ambient', label: 'Ambient (0–1)', min: 0, max: 1, step: 0.05, advanced: true },
    {
      kind: 'number',
      key: 'lightAzimuthDeg',
      label: 'Light azimuth (°)',
      min: -180,
      max: 180,
      step: 5,
      advanced: true,
    },
    {
      kind: 'number',
      key: 'lightElevationDeg',
      label: 'Light elevation (°)',
      min: -90,
      max: 90,
      step: 5,
      advanced: true,
    },
    { kind: 'number', key: 'margin', label: 'Margin (0–0.4)', min: 0, max: 0.4, step: 0.02, advanced: true },
    {
      kind: 'number',
      key: 'supersample',
      label: 'Supersample (1–4)',
      min: 1,
      max: 4,
      step: 1,
      advanced: true,
    },
    { kind: 'boolean', key: 'flipDepth', label: 'Depth output: white = far', advanced: true },
  ],
  defaultConfig: () => ({
    // A dozen views across the cone: 33 mm of eye movement per step at the
    // defaults, which is what keeps the parallax under a lenticule at 5 mm of
    // depth. The 1D print can carry many more views than a grid can — it only
    // spends resolution on one axis — and depth buys back with every one.
    views: 12,
    widthMm: 100,
    sheetHeightMm: 75,
    depthMm: 5,
    // Right against the glass: the subject's nearest point touches the sheet
    // plane, which is the deepest box you can have before the far face starts
    // moving more than the lens can follow.
    setbackMm: 0,
    viewDistanceMm: 400,
    viewPx: 512,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    coneMode: 'lens',
    lpi: 45,
    lensHeightMm: 0.9,
    ri: 1.5,
    coneDeg: 53,
    mirrorViews: true,
    colour: '#d8d4cc',
    background: '#ffffff',
    ambient: 0.25,
    lightAzimuthDeg: -30,
    lightElevationDeg: 35,
    margin: 0.08,
    supersample: 2,
    flipDepth: false,
  }),
  compute: async ({ inputs, config, onProgress }) => {
    const stl = gatherMesh(inputs);
    if (!stl) throw new Error('Connect a mesh to the Mesh input (3D Model Input).');
    if (stl.triangleCount > MAX_IMPORT_TRIANGLES) {
      throw new Error(`Mesh has ${stl.triangleCount.toLocaleString()} triangles — decimate it first.`);
    }
    const o = { ...viewSequenceOptionsFromConfig(config), texture: asImage(inputs.texture) };
    onProgress?.(`Rendering ${o.views} views at ${o.widthPx} px…`);
    // Let the spinner paint before the render locks the main thread.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const render = renderViewSequence(stl, o);
    // The renderer hands them back left eye first, which is honest but not what
    // gets printed: a lenticule shows its leftmost strip to an eye on the
    // *right*, and Lenticular Print interlaces frames in the order they arrive.
    // So the sequence goes out reversed, and the print comes out orthoscopic —
    // near things near. Turn the flag off to get pseudoscopic depth (inside
    // out), which is what the wrong order looks like if you ever see it.
    const views = bool(config.mirrorViews, true) ? [...render.views].reverse() : render.views;
    return {
      views: { kind: 'sequence', frames: views },
      depth: bool(config.flipDepth, false) ? invert(render.depth) : render.depth,
      info: { kind: 'text', text: describeViewSequence(config, o, stl, render) },
    };
  },
};

/** White ↔ black, for a depth map that wants far = white. */
function invert(img: RasterImage): RasterImage {
  const out: RasterImage = {
    kind: 'image',
    width: img.width,
    height: img.height,
    data: new Uint8ClampedArray(img.data),
  };
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255 - out.data[i];
    out.data[i + 1] = 255 - out.data[i + 1];
    out.data[i + 2] = 255 - out.data[i + 2];
  }
  return out;
}

/** Eye positions of the run, for tests and reports. */
export const stereoEyeOffsets = (o: ViewSequenceOptions): number[] =>
  eyeOffsetsMm(o.views, o.coneDeg, o.viewDistanceMm);

export const modelStereoNodes: NodeDefinition[] = [modelStereoNode];
