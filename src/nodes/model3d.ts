// 3D model → the grid of views a Lens Grid Print needs.
//
// Two nodes: one reads an STL off disk, the other renders it from every eye
// position in the view grid. The optics live in ../lib/render3d, and the view
// naming is shared with the print node so the ports line up by name.

import type { ComputeContext, NodeConfig, NodeDefinition, RasterImage, StlValue } from '../types';
import { DEFAULT_GRID, clampGrid, lensGeometry } from '../lib/lenticular';
import { MAX_IMPORT_TRIANGLES, meshBounds } from '../lib/stl';
import { parseMesh } from '../lib/mesh';
import {
  MAX_VIEW_PX,
  MIN_VIEW_PX,
  disparityPerStep,
  eyeOffsetsMm,
  renderViewGrid,
  type ViewGridOptions,
} from '../lib/render3d';
import { isBlobRef } from '../lib/blobStore';
import { platform } from '../lib/platform';
import { asImage, bool, num, str } from './helpers';

/** Bytes behind an uploaded file's data URL. */
function dataUrlToBytes(src: string): Uint8Array {
  const comma = src.indexOf(',');
  const meta = comma >= 0 ? src.slice(0, comma) : '';
  const payload = comma >= 0 ? src.slice(comma + 1) : src;
  // FileReader always gives base64; a hand-made data: URL might not.
  if (!/;base64/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(payload));
  const bin = atob(payload);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** What surface detail a mesh brought with it, in the order the renderer uses it. */
function surfaceOf(stl: StlValue): string {
  if (stl.uvs) {
    return stl.colours
      ? 'Carries texture coordinates and vertex colours — wire an image into the render node’s Texture input, or leave it empty to use the colours'
      : 'Carries texture coordinates — wire an image into the render node’s Texture input to use them';
  }
  if (stl.colours) return 'Carries vertex colours, which the render node uses as-is';
  return 'No colour of its own (an STL never has any) — it renders in the material colour';
}

/** Human-readable summary of a loaded mesh. */
export function describeMesh(stl: StlValue, name: string): string {
  const b = meshBounds(stl);
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  return [
    `${name || 'Mesh'} · ${stl.triangleCount.toLocaleString()} triangles`,
    `Bounds ${n(b.size[0])} × ${n(b.size[1])} × ${n(b.size[2])} (model units)`,
    `Centre ${n(b.centre[0])}, ${n(b.centre[1])}, ${n(b.centre[2])}`,
    surfaceOf(stl),
    // Units are whatever the exporter meant; the render fits to the sheet, so
    // only the *proportions* here matter.
    'Scale is fitted to the print at render time — only the shape matters.',
  ].join('\n');
}

export const modelInputNode: NodeDefinition = {
  type: 'modelInput',
  label: '3D Model Input',
  category: 'Input',
  description:
    'Upload a mesh — STL (binary or ASCII) or OBJ — and output it. Feed it to Model → Grid Views to ' +
    'render the views a Lens Grid Print needs. The file’s units and origin do not matter: the ' +
    'renderer centres and fits the model to the sheet. OBJ also carries texture coordinates and ' +
    'vertex colours; STL carries shape alone. A texture image is a separate wire, not a .mtl file.',
  autoRun: true,
  inputs: [],
  outputs: [
    { id: 'out', label: 'Mesh', type: 'stl' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [],
  defaultConfig: () => ({ src: '', srcRef: '', name: '' }),
  compute: async ({ config, onProgress }) => {
    // Same storage shape as Image Input: inline bytes on legacy graphs,
    // otherwise an out-of-band blob reference.
    let src = str(config.src);
    if (!src && isBlobRef(config.srcRef)) src = (await platform.getBlob(config.srcRef)) ?? '';
    if (!src) return { out: undefined, info: undefined };

    onProgress?.('Parsing mesh…');
    const stl = parseMesh(dataUrlToBytes(src), str(config.name));
    return { out: stl, info: { kind: 'text', text: describeMesh(stl, str(config.name)) } };
  },
};

// ---------------------------------------------------------------------------
// Model → Grid Views
// ---------------------------------------------------------------------------

/** Read the render settings out of a node's config. */
export function viewGridOptionsFromConfig(config: NodeConfig): ViewGridOptions {
  const grid = clampGrid(num(config.grid, DEFAULT_GRID));
  return {
    grid,
    widthMm: Math.max(1, num(config.widthMm, 100)),
    heightMm: Math.max(1, num(config.sheetHeightMm, 75)),
    widthPx: Math.min(MAX_VIEW_PX, Math.max(MIN_VIEW_PX, Math.round(num(config.viewPx, 512)))),
    viewDistanceMm: Math.max(10, num(config.viewDistanceMm, 400)),
    depthMm: Math.max(0, num(config.depthMm, 20)),
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

/**
 * The cone the view grid spans. `lens` solves it from the lens you are going to
 * print — the only setting that ties the render to the optics, and the reason
 * this node lives in the tool rather than in a 3D package: views spread wider
 * than the lens can show jump at the flip, and narrower throws depth away.
 */
export function coneFromConfig(config: NodeConfig): number {
  if (str(config.coneMode, 'lens') !== 'lens') {
    return Math.min(170, Math.max(1, num(config.coneDeg, 57)));
  }
  const geometry = lensGeometry({
    widthMm: Math.max(1, num(config.widthMm, 100)),
    ppi: 1440,
    lpi: Math.max(1, num(config.lpi, 45)),
    phase: 0,
    heightMm: Math.max(0.01, num(config.lensHeightMm, 0.9)),
    ri: Math.max(1.01, num(config.ri, 1.5)),
    orientationDeg: 0,
    stripSamples: 2,
  });
  return geometry.viewAngleDeg;
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [216, 212, 204];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** Lenslets across and down the sheet — the real resolution of each view. */
function lensletCounts(config: NodeConfig): { across: number; down: number } {
  const lpi = Math.max(1, num(config.lpi, 45));
  const across = (Math.max(1, num(config.widthMm, 100)) * lpi) / 25.4;
  const down = (Math.max(1, num(config.sheetHeightMm, 75)) * lpi) / 25.4;
  return { across: Math.round(across), down: Math.round(down) };
}

/** More than this much movement per view step and the print ghosts. */
export const MAX_STEP_LENSLETS = 1.5;

/** Which of texture / vertex colour / material colour this render will use. */
function surfaceUsed(stl: StlValue, o: ViewGridOptions): string {
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
export function describeViewGrid(
  config: NodeConfig,
  o: ViewGridOptions,
  stl: StlValue,
  coverage: number,
): string {
  const grid = o.grid;
  const lpi = Math.max(1, num(config.lpi, 45));
  const offsets = eyeOffsetsMm(grid, o.coneDeg, o.viewDistanceMm);
  const step = disparityPerStep(o, lpi);
  const cells = lensletCounts(config);
  const outer = offsets[offsets.length - 1];
  const viewPx = o.widthPx;
  const viewPy = Math.round((o.widthPx * o.heightMm) / o.widthMm);
  const fromLens = str(config.coneMode, 'lens') === 'lens';

  const lines = [
    `${grid}×${grid} = ${grid * grid} views · ${viewPx}×${viewPy} px each · ` +
      `${stl.triangleCount.toLocaleString()} triangles`,
    `Sheet ${o.widthMm}×${o.heightMm} mm, viewed from ${o.viewDistanceMm} mm`,
    `Cone ${o.coneDeg.toFixed(1)}°${fromLens ? ` (solved from ${lpi} LPI / ${num(config.lensHeightMm, 0.9)} mm / RI ${num(config.ri, 1.5)})` : ' (set by hand)'} — ` +
      `outer eye ${outer.toFixed(0)} mm off-axis`,
    `Subject depth ${o.depthMm} mm about the sheet plane · covers ${(coverage * 100).toFixed(0)}% of the frame`,
    `Surface: ${surfaceUsed(stl, o)}`,
    `Parallax ${step.lenslets.toFixed(2)} lenslets per view step ` +
      `(${step.mm.toFixed(3)} mm at ${lpi} LPI), ${(step.lenslets * (grid - 1)).toFixed(2)} across the whole cone`,
    `Each view will print at ${cells.across}×${cells.down} px — one pixel per lenslet`,
  ];

  // A feature that moves more than a lenslet between adjacent views is never
  // sampled in between: it jumps instead of gliding, and the lens blur turns the
  // jump into a double image. This is the number that decides whether the print
  // reads as depth, so it gets the loudest warning in the node.
  if (step.lenslets > MAX_STEP_LENSLETS) {
    lines.push(
      `⚠ ${step.lenslets.toFixed(2)} lenslets per step is too much — the print will ghost rather than ` +
        `read as depth. Reduce Subject depth to about ` +
        `${(o.depthMm * (MAX_STEP_LENSLETS / step.lenslets)).toFixed(1)} mm, raise LPI, or use a bigger grid.`,
    );
  } else if (step.lenslets < 0.15 && o.depthMm > 0) {
    lines.push(
      `⚠ Only ${step.lenslets.toFixed(2)} lenslets per step — under a lenslet across the whole cone, so ` +
        `the views are nearly identical and the print will look flat. Raise Subject depth.`,
    );
  }
  if (viewPx < cells.across) {
    lines.push(
      `⚠ Rendering ${viewPx} px wide but the print resolves ${cells.across} — the views are being ` +
        `upsampled. Raise view pixels to at least ${cells.across}.`,
    );
  }
  if (coverage < 0.02) {
    lines.push('⚠ The subject barely covers the frame — check the rotation, or lower Margin.');
  }
  return lines.join('\n');
}

function gatherMesh(inputs: ComputeContext['inputs']): StlValue | undefined {
  const v = Array.isArray(inputs.model) ? inputs.model[0] : inputs.model;
  return v && v.kind === 'stl' ? v : undefined;
}

export const modelViewsNode: NodeDefinition = {
  type: 'modelViews',
  label: 'Model → Grid Views',
  category: 'UV',
  description:
    'Render a mesh from every eye position of a lens grid and send all of them down one wire into ' +
    'Lens Grid Print’s All views input, in the order its cells are named. The eye is shifted, never rotated, so ' +
    'the sheet plane stays pin-sharp in all views and only depth moves; the grid spans the lens’s own ' +
    'viewing cone. Watch the parallax figure in Info: more than ~1.5 lenslets per view step ghosts ' +
    'instead of reading as depth. Manual: click Run.',
  autoRun: false,
  inputs: [
    { id: 'model', label: 'Mesh', type: 'stl', required: true },
    { id: 'texture', label: 'Texture', type: 'image' },
  ],
  // One wire carries the whole grid, in gridCells order, straight into the print
  // node's `views` input — grid² separate ports would be grid² edges to drag.
  outputs: [
    { id: 'views', label: 'All views', type: 'sequence' },
    { id: 'depth', label: 'Depth (centre)', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'grid', label: 'Grid (N × N views)', min: 2, max: 6, step: 1 },
    { kind: 'number', key: 'widthMm', label: 'Print width (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'sheetHeightMm', label: 'Print height (mm)', min: 1, step: 1 },
    { kind: 'number', key: 'depthMm', label: 'Subject depth (mm)', min: 0, step: 1 },
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
    { kind: 'number', key: 'lpi', label: 'LPI (lenslets/inch)', min: 1, step: 1 },
    { kind: 'number', key: 'lensHeightMm', label: 'Gloss height (mm)', min: 0.01, step: 0.05 },
    { kind: 'number', key: 'ri', label: 'RI', min: 1.01, max: 3, step: 0.01 },
    { kind: 'number', key: 'coneDeg', label: 'Cone by hand (°)', min: 1, max: 170, step: 1 },
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
    grid: DEFAULT_GRID,
    widthMm: 100,
    sheetHeightMm: 75,
    // Two millimetres, and that is not a typo. A 3×3 over the lens's 53.3° cone
    // steps the eye 201 mm between views, so a feature 1 mm off the sheet plane
    // already slides 0.50 mm across it — nearly a whole 45 LPI lenslet, which is
    // the most a lens grid can show. Depth of field is the scarce resource here,
    // and it buys back linearly with the grid: 6×6 carries ~5.6 mm.
    depthMm: 2,
    viewDistanceMm: 400,
    viewPx: 512,
    rotX: 0,
    rotY: 0,
    rotZ: 0,
    coneMode: 'lens',
    lpi: 45,
    lensHeightMm: 0.9,
    ri: 1.5,
    // What the lens mode solves at those three numbers, so switching to `manual`
    // doesn't move the cameras until you actually change it. (Not the 57° an
    // RI-1.5 lens tops out at — that needs a stack right on the feasibility
    // floor, and 0.9 mm at 45 LPI sits 6% above it.)
    coneDeg: 53,
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
    const o = { ...viewGridOptionsFromConfig(config), texture: asImage(inputs.texture) };
    onProgress?.(`Rendering ${o.grid * o.grid} views at ${o.widthPx} px…`);
    // Let the spinner paint before the render locks the main thread.
    await new Promise((resolve) => setTimeout(resolve, 0));

    const render = renderViewGrid(stl, o);
    // Row-major from `Left · Up`, which is the order the print node reads a
    // sequence in — the two are the same gridCells() list.
    return {
      views: { kind: 'sequence', frames: render.views },
      depth: bool(config.flipDepth, false) ? invert(render.depth) : render.depth,
      info: { kind: 'text', text: describeViewGrid(config, o, stl, render.coverage) },
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

export const model3dNodes: NodeDefinition[] = [modelInputNode, modelViewsNode];
