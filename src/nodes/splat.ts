// Gaussian splats, in three nodes: read a cloud, stand somewhere in it, print
// what you can see from there.
//
// The split is deliberate. Flying a camera is an interactive act with no output
// worth recomputing, and rendering 225 views of a million ellipsoids is a
// minute of arithmetic with no interaction in it at all. Keeping them in one
// node would mean either re-rendering the print on every keystroke or flying
// blind, so the camera node produces nothing but a placement — position,
// rotation and scale on one wire — and the render node consumes it.
//
// ---------------------------------------------------------------------------
// On the dynamic imports below
// ---------------------------------------------------------------------------
// The parser and the rasteriser are the two big modules in this tool, and a
// graph that has nothing to do with splats should not pay for either. Both are
// therefore reached through `await import(...)` inside `compute`, which Vite
// turns into separate chunks fetched the first time a splat node actually runs.
// The editor is split the same way, at `SettingsModal`.
//
// The rule that keeps this working: nothing in this file may import from
// `lib/splat/parse` or `lib/splat/render` at the top level, not even for a
// type. `import type` is erased, but a value import — a constant, an enum, one
// helper — silently pulls the whole chunk back into the main bundle, and
// nothing fails to tell you. Shared runtime values live in `lib/splat/cloud`,
// which is small and eager on purpose.

import type { ComputeContext, NodeConfig, NodeDefinition, RasterImage, SplatValue, TransformValue } from '../types';
import type { SplatViewOptions } from '../lib/splat/render';
import {
  MAX_IMPORT_SPLATS,
  cloudBounds,
  describeCamera,
  framingCamera,
  looksLikeZip,
} from '../lib/splat/cloud';
import { DEFAULT_GRID, MAX_GRID, MIN_GRID, clampGrid } from '../lib/lenticular';
import { runChunked } from '../lib/chunked';
import { isBlobRef } from '../lib/blobStore';
import { platform } from '../lib/platform';
// render3d is eager anyway — every other view node uses it — so importing the
// disparity maths statically costs nothing here and keeps the chunking honest.
import { MAX_VIEW_PX, MIN_VIEW_PX, disparityAtDepth } from '../lib/render3d';
import { MAX_HAZE_LENSLETS, coneFromConfig } from './model3d';
import { MAX_STEP_LENSLETS, MAX_VIEWS, MIN_VIEWS } from './modelStereo';
import { asSplat, asTransform, bool, num, str } from './helpers';

/**
 * The uploaded file's bytes, whichever way this graph stored them.
 *
 * New uploads are kept as raw bytes and this is a straight read. The data-URL
 * paths are for graphs saved before that: a splat file big enough to matter
 * cannot survive base64 — 1.37× on top of a few hundred megabytes, and past
 * ~390 MB the encoded string is longer than the engine will allocate at all —
 * but a small one saved the old way should still open.
 */
async function uploadedBytes(config: NodeConfig): Promise<Uint8Array | null> {
  const bytesRef = str(config.bytesRef);
  if (isBlobRef(bytesRef)) {
    const bytes = await platform.getBytes(bytesRef);
    if (bytes) return bytes;
  }
  let src = str(config.src);
  if (!src && isBlobRef(config.srcRef)) src = (await platform.getBlob(config.srcRef)) ?? '';
  return src ? dataUrlToBytes(src) : null;
}

/** Bytes behind an uploaded file's data URL. */
function dataUrlToBytes(src: string): Uint8Array {
  const comma = src.indexOf(',');
  const meta = comma >= 0 ? src.slice(0, comma) : '';
  const payload = comma >= 0 ? src.slice(comma + 1) : src;
  if (!/;base64/i.test(meta)) return new TextEncoder().encode(decodeURIComponent(payload));
  const bin = atob(payload);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * Hand a texture's bytes to the browser's own image decoder.
 *
 * SOG stores its attributes as WebP, and there is no sane way to decode WebP in
 * JavaScript — so this is the one place the splat path needs the platform. An
 * object URL rather than a data URL because these run to several megabytes each
 * and base64 would cost a third again in memory, plus the encode.
 */
async function decodeTexture(bytes: Uint8Array, mime: string): Promise<RasterImage> {
  const makeUrl = (globalThis as { URL?: typeof URL }).URL;
  if (typeof makeUrl?.createObjectURL !== 'function') {
    // No object URLs (a worker without them, an odd embedding): fall back to a
    // data URL, built in chunks because `String.fromCharCode(...bytes)` on a
    // multi-megabyte array overflows the argument stack.
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return platform.decodeImage(`data:${mime};base64,${btoa(bin)}`);
  }
  const url = makeUrl.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  try {
    return await platform.decodeImage(url);
  } finally {
    makeUrl.revokeObjectURL(url);
  }
}

/** Human-readable summary of a loaded cloud. */
export function describeCloud(cloud: SplatValue): string {
  const b = cloudBounds(cloud);
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const lines = [
    `${cloud.name || 'Cloud'} · ${cloud.count.toLocaleString()} splats`,
    `Bounds ${n(b.size[0])} × ${n(b.size[1])} × ${n(b.size[2])} (scene units)`,
    `Centre ${n(b.centre[0])}, ${n(b.centre[1])}, ${n(b.centre[2])} · radius ${n(b.radius)}`,
  ];
  if (cloud.droppedCount) {
    lines.push(
      `Thinned by ${cloud.droppedCount.toLocaleString()} splats to stay under the ` +
        `${MAX_IMPORT_SPLATS.toLocaleString()} an import can hold — a memory ceiling, not a quality ` +
        `one, and an even stride so the scene keeps its shape and loses only density.`,
    );
  }
  lines.push(
    'The whole cloud is kept: what a render draws is thinned at render time, after the culls, so the ' +
      'part in front of the camera gets the budget instead of a share of it.',
    'Colour is the DC term only: the print will not carry the view-dependent highlights the capture has.',
  );
  return lines.join('\n');
}

export const splatInputNode: NodeDefinition = {
  type: 'splatInput',
  label: 'Gaussian Splat Input',
  category: 'Input',
  description:
    'Upload a Gaussian splat scene — .ply (what every trainer writes), .sog (the compact bundle, ' +
    'roughly 20× smaller) or .splat — and output the cloud. Feed it to Splat Camera to choose where ' +
    'you stand, then to Splat → Views to print it. ' +
    'The file’s units and origin do not matter; the camera’s scale is what ties the scene to the sheet. ' +
    'The whole cloud is kept — what a render draws is thinned at render time, once it knows what is in ' +
    'front of the camera — and only the base colour of each splat is kept. See the Info output.',
  autoRun: true,
  inputs: [],
  outputs: [
    { id: 'out', label: 'Splat cloud', type: 'splat' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [],
  defaultConfig: () => ({ bytesRef: '', src: '', srcRef: '', name: '' }),
  compute: async ({ config, onProgress, signal }) => {
    const name = str(config.name);
    const bytes = await uploadedBytes(config);
    if (!bytes) return { out: undefined, info: undefined };
    onProgress?.('Reading splat file…');

    // A SOG bundle is a ZIP of textures rather than a list of splats, so it
    // needs its own reader — and its own module, which a graph reading plain
    // PLYs should not download either.
    if (looksLikeZip(bytes)) {
      const { loadSogBundle, decodeSogChunks } = await import('../lib/splat/sog');
      onProgress?.('Unpacking SOG bundle…');
      const { meta, textures } = await loadSogBundle(bytes, decodeTexture);
      const cloud = await runChunked(decodeSogChunks(meta, textures, name), { onProgress, signal });
      return { out: cloud, info: { kind: 'text', text: describeCloud(cloud) } };
    }

    const { parseSplatFileChunks } = await import('../lib/splat/parse');
    const cloud = await runChunked(parseSplatFileChunks(bytes, name), { onProgress, signal });
    return { out: cloud, info: { kind: 'text', text: describeCloud(cloud) } };
  },
};

// ---------------------------------------------------------------------------
// Splat Camera
// ---------------------------------------------------------------------------

/** The placement a camera node's config describes. */
export function cameraFromConfig(config: NodeConfig): TransformValue {
  return {
    kind: 'transform',
    position: [num(config.posX, 0), num(config.posY, 0), num(config.posZ, 0)],
    rotationDeg: [num(config.pitch, 0), num(config.yaw, 0), num(config.roll, 0)],
    // Zero would collapse the scene to a point; it also marks a camera that has
    // never been placed, which `compute` frames automatically.
    scale: Math.max(1e-9, num(config.scale, 0)),
  };
}

/** Has this camera ever been placed, or is it still at its blank default? */
export const isUnplaced = (config: NodeConfig): boolean => num(config.scale, 0) <= 0;

export const splatCameraNode: NodeDefinition = {
  type: 'splatCamera',
  label: 'Splat Camera',
  category: 'UV',
  description:
    'Fly a camera through a splat scene and keep where you stopped. Open the editor and use W/A/S/D to ' +
    'move, Space and Shift for up and down, and the mouse to look — the preview is the head-on view of ' +
    'the print itself, so what you compose is what gets printed. Where you stand is the sheet: whatever ' +
    'the camera sits on lands on the paper in focus, and everything nearer is dropped, so flying forward ' +
    'pushes a slicing plane through the capture. Scroll to change how much of the scene the sheet spans. ' +
    'Position, rotation and scale go out on one wire into Splat → Views. Wire one cloud into several ' +
    'cameras to print the same capture from several places.',
  autoRun: true,
  customEditor: 'splatCamera',
  inputs: [{ id: 'splat', label: 'Splat cloud', type: 'splat', required: true }],
  outputs: [
    { id: 'camera', label: 'Camera', type: 'transform' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'posX', label: 'X', step: 0.1 },
    { kind: 'number', key: 'posY', label: 'Y', step: 0.1 },
    { kind: 'number', key: 'posZ', label: 'Z', step: 0.1 },
    { kind: 'number', key: 'yaw', label: 'Yaw (°)', min: -180, max: 180, step: 1 },
    { kind: 'number', key: 'pitch', label: 'Pitch (°)', min: -90, max: 90, step: 1 },
    { kind: 'number', key: 'roll', label: 'Roll (°)', min: -180, max: 180, step: 1, advanced: true },
    { kind: 'number', key: 'scale', label: 'Scene units per mm', min: 0, step: 0.001 },
    { kind: 'number', key: 'widthMm', label: 'Sheet width (mm)', min: 1, step: 1, advanced: true },
    { kind: 'number', key: 'sheetHeightMm', label: 'Sheet height (mm)', min: 1, step: 1, advanced: true },
    {
      kind: 'number',
      key: 'viewDistanceMm',
      label: 'Viewing distance (mm)',
      min: 10,
      step: 10,
      advanced: true,
    },
    { kind: 'number', key: 'moveSpeed', label: 'Fly speed (units/s)', min: 0.01, step: 0.05, advanced: true },
    {
      kind: 'number',
      key: 'previewSplats',
      label: 'Preview splats',
      min: 5000,
      max: 400000,
      step: 5000,
      advanced: true,
    },
    { kind: 'number', key: 'previewPx', label: 'Preview width (px)', min: 96, max: 960, step: 32, advanced: true },
  ],
  defaultConfig: () => ({
    posX: 0,
    posY: 0,
    posZ: 0,
    yaw: 0,
    pitch: 0,
    roll: 0,
    // 0 means "never placed": the first run frames the whole cloud instead.
    scale: 0,
    widthMm: 100,
    sheetHeightMm: 75,
    viewDistanceMm: 400,
    moveSpeed: 0.5,
    // Enough to read the scene while moving; the print uses all of them.
    previewSplats: 150000,
    previewPx: 480,
  }),
  compute: ({ inputs, config }) => {
    const cloud = asSplat(inputs.splat);
    if (!cloud) throw new Error('Connect a cloud to the Splat cloud input (Gaussian Splat Input).');
    // An unplaced camera frames the whole capture, so a fresh graph shows
    // something the moment it is wired rather than a blank sheet the user has
    // to fly out of.
    const camera = isUnplaced(config)
      ? framingCamera(cloud, Math.max(1, num(config.widthMm, 100)), Math.max(10, num(config.viewDistanceMm, 400)))
      : cameraFromConfig(config);
    return {
      camera,
      info: {
        kind: 'text',
        text:
          (isUnplaced(config) ? 'Framing the whole cloud — open the editor and fly.\n' : '') +
          describeCamera(camera, Math.max(1, num(config.widthMm, 100))),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Splat → Views
// ---------------------------------------------------------------------------

/** Read the render settings out of a node's config, given the camera. */
export function splatViewOptionsFromConfig(config: NodeConfig, camera: TransformValue): SplatViewOptions {
  const layout = str(config.layout, '1d') === '2d' ? '2d' : '1d';
  return {
    camera,
    widthMm: Math.max(1, num(config.widthMm, 100)),
    heightMm: Math.max(1, num(config.sheetHeightMm, 75)),
    widthPx: Math.min(MAX_VIEW_PX, Math.max(MIN_VIEW_PX, Math.round(num(config.viewPx, 512)))),
    viewDistanceMm: Math.max(10, num(config.viewDistanceMm, 400)),
    coneDeg: coneFromConfig(config),
    layout,
    views: Math.min(MAX_VIEWS, Math.max(MIN_VIEWS, Math.round(num(config.views, 12)))),
    grid: clampGrid(num(config.grid, DEFAULT_GRID)),
    background: hexToRgb(str(config.background, '#ffffff')),
    supersample: Math.min(3, Math.max(1, Math.round(num(config.supersample, 1)))),
    splatBudget: Math.max(0, Math.round(num(config.splatBudget, 0))) || undefined,
    frontMarginMm: Math.max(0, num(config.frontMarginMm, 0)),
  };
}

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [255, 255, 255];
  const v = parseInt(m[1], 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

/** How many views a configuration will produce. */
export const viewCount = (o: SplatViewOptions): number =>
  o.layout === '2d' ? o.grid * o.grid : Math.max(1, Math.round(o.views));

/** Geometry report for the node's Info output. */
export function describeSplatViews(
  config: NodeConfig,
  o: SplatViewOptions,
  render: {
    nearMm: number;
    farMm: number;
    coverage: number;
    drawn: number;
    considered: number;
    culled: number;
    offSheet: number;
    thinned: number;
    scanned: number;
  },
  disparity: { mm: number; lenslets: number },
  placement: string,
): string {
  const lpi = Math.max(1, num(config.lpi, 45));
  const across = (o.widthMm * lpi) / 25.4;
  const viewPy = Math.round((o.widthPx * o.heightMm) / o.widthMm);
  const n = viewCount(o);
  const fromLens = str(config.coneMode, 'lens') === 'lens';

  const lines = [
    o.layout === '2d'
      ? `${o.grid}×${o.grid} grid — ${n} views · ${o.widthPx}×${viewPy} px each`
      : `${n} views · ${o.widthPx}×${viewPy} px each`,
    `Sheet ${o.widthMm}×${o.heightMm} mm, viewed from ${o.viewDistanceMm} mm`,
    `Cone ${o.coneDeg.toFixed(1)}°${
      fromLens
        ? ` (solved from ${lpi} LPI / ${num(config.lensHeightMm, 0.9)} mm / RI ${num(config.ri, 1.5)})`
        : ' (set by hand)'
    }`,
    `Scale ${o.camera.scale} scene units per mm — the sheet spans ` +
      `${(o.camera.scale * o.widthMm).toFixed(3)} units of the scene`,
    placement,
    `Cull: ${render.culled.toLocaleString()} in front of the sheet` +
      (num(config.frontMarginMm, 0) > 0 ? ` or within ${num(config.frontMarginMm, 0)} mm behind it` : '') +
      `, ${render.offSheet.toLocaleString()} off the sheet in every view, from ` +
      `${render.scanned.toLocaleString()} scanned`,
    render.thinned > 0
      ? `Budget: thinned ${render.thinned.toLocaleString()} of the ${(
          render.considered + render.thinned
        ).toLocaleString()} that survived, leaving ${render.considered.toLocaleString()} — the thinning ` +
        `happens after the culls, so every splat it spends is one that could have been seen`
      : `Budget: none — all ${render.considered.toLocaleString()} surviving splats are drawn`,
    `Drew ${render.drawn.toLocaleString()} of ${render.considered.toLocaleString()}, covering ` +
      `${(render.coverage * 100).toFixed(0)}% of the frame`,
    `Parallax ${disparity.lenslets.toFixed(2)} lenslets per view step at the far edge of the cloud ` +
      `(${disparity.mm.toFixed(3)} mm at ${lpi} LPI)`,
    `Each view will print at ${Math.round(across)} px across — one pixel per lenticule`,
  ];

  if (disparity.lenslets > MAX_HAZE_LENSLETS) {
    lines.push(
      `⚠ ${disparity.lenslets.toFixed(2)} lenslets per step is far past the line — the back of the scene ` +
        `will double rather than soften. Move the camera closer to what matters, raise the scale so the ` +
        `sheet spans more of the scene, add views, or raise LPI.`,
    );
  } else if (disparity.lenslets > MAX_STEP_LENSLETS) {
    lines.push(
      `· ${disparity.lenslets.toFixed(2)} lenticules per step is over the ${MAX_STEP_LENSLETS} the lens ` +
        `resolves. The back of the scene will read as haze rather than detail, which is what distance ` +
        `looks like anyway — the sheet plane stays sharp. Past ${MAX_HAZE_LENSLETS} it doubles.`,
    );
  }
  if (render.considered === 0) {
    lines.push(
      '⚠ Every splat was culled. The camera position *is* the sheet, and the whole scene is in front ' +
        'of it — fly backwards until the scene is ahead of you, or press “Frame the scene”.',
    );
  } else if (render.culled > render.considered) {
    lines.push(
      `· More of the scene was culled than kept. That is normal once the camera is inside a capture — ` +
        `the sheet is a plane through it and everything nearer than that plane cannot be printed — but ` +
        `if you meant to have the whole scene, fly back until it is all ahead of you.`,
    );
  }
  if (render.coverage < 0.2 && render.considered > 0) {
    lines.push(
      `⚠ The cloud covers only ${(render.coverage * 100).toFixed(0)}% of the frame — mostly paper. ` +
        `Reframe in the Splat Camera editor, or lower the scale so the sheet spans less of the scene.`,
    );
  }
  if (o.widthPx < across) {
    lines.push(
      `⚠ Rendering ${o.widthPx} px wide but the print resolves ${Math.round(across)} — the views are ` +
        `being upsampled. Raise view pixels to at least ${Math.round(across)}.`,
    );
  }
  return lines.join('\n');
}

function gatherCloud(inputs: ComputeContext['inputs']): SplatValue | undefined {
  return asSplat(inputs.splat);
}

export const splatViewsNode: NodeDefinition = {
  type: 'splatViews',
  label: 'Splat → Views',
  category: 'UV',
  description:
    'Render a splat scene from every eye position a lens shows, and send the whole run down one wire. ' +
    'Choose a horizontal run for a Lenticular Print, or a square grid for a Lens Grid Print — the same ' +
    'window either way, with the sheet plane pin-sharp and everything off it separating as you move. ' +
    'Unlike the heightmap route, nothing here is invented: a splat scene is a real 3D scene, so an edge ' +
    'moving aside uncovers what was actually behind it. Wire a Splat Camera into Camera to say where ' +
    'you are standing — that camera is the sheet plane, and anything in front of it is culled, since a ' +
    'print cannot show what would come out of the paper. Manual: click Run.',
  autoRun: false,
  inputs: [
    { id: 'splat', label: 'Splat cloud', type: 'splat', required: true },
    { id: 'camera', label: 'Camera', type: 'transform' },
  ],
  outputs: [
    { id: 'views', label: 'Views', type: 'sequence' },
    { id: 'depth', label: 'Depth (centre)', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    {
      kind: 'select',
      key: 'layout',
      label: 'Layout',
      options: [
        { value: '1d', label: 'Horizontal run (Lenticular Print)' },
        { value: '2d', label: 'Square grid (Lens Grid Print)' },
      ],
    },
    { kind: 'number', key: 'views', label: 'Views (run)', min: MIN_VIEWS, max: MAX_VIEWS, step: 1 },
    { kind: 'number', key: 'grid', label: 'Grid (n×n)', min: MIN_GRID, max: MAX_GRID, step: 1 },
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
    { kind: 'color', key: 'background', label: 'Paper colour', advanced: true },
    { kind: 'number', key: 'supersample', label: 'Supersample (1–3)', min: 1, max: 3, step: 1, advanced: true },
    {
      kind: 'number',
      key: 'frontMarginMm',
      label: 'Cull plane (mm behind the sheet)',
      min: 0,
      step: 1,
      advanced: true,
    },
    {
      kind: 'number',
      key: 'splatBudget',
      label: 'Splat budget (0 = all of them, spent after the culls)',
      min: 0,
      max: 1200000,
      step: 50000,
      advanced: true,
    },
    { kind: 'boolean', key: 'mirrorViews', label: 'Order for the lens (right eye first)', advanced: true },
    { kind: 'boolean', key: 'flipDepth', label: 'Depth output: white = far', advanced: true },
  ],
  defaultConfig: () => ({
    layout: '1d',
    views: 12,
    grid: DEFAULT_GRID,
    widthMm: 100,
    sheetHeightMm: 75,
    viewDistanceMm: 400,
    viewPx: 512,
    coneMode: 'lens',
    lpi: 45,
    lensHeightMm: 0.9,
    ri: 1.5,
    coneDeg: 53,
    background: '#ffffff',
    // 1, not the mesh renderer's 2: a splat is already a smooth falloff rather
    // than a hard-edged triangle, so there is far less aliasing to average away
    // and the fourfold cost buys very little.
    supersample: 1,
    // 0 is the sheet itself: everything that would come out of the print is
    // dropped. Raise it to push the cull deeper into the scene.
    frontMarginMm: 0,
    splatBudget: 0,
    mirrorViews: true,
    flipDepth: false,
  }),
  compute: async ({ inputs, config, onProgress, signal }) => {
    const cloud = gatherCloud(inputs);
    if (!cloud) throw new Error('Connect a cloud to the Splat cloud input (Gaussian Splat Input).');
    const wired = asTransform(inputs.camera);
    const o = splatViewOptionsFromConfig(
      config,
      // No camera wired is not an error: frame the whole cloud, which is a
      // sensible picture and shows what a Splat Camera would then adjust.
      wired ?? framingCamera(cloud, Math.max(1, num(config.widthMm, 100)), Math.max(10, num(config.viewDistanceMm, 400))),
    );
    const n = viewCount(o);
    onProgress?.(`Rendering ${n} views of ${cloud.count.toLocaleString()} splats at ${o.widthPx} px…`);

    const { splatViewChunks, describePlacementOf } = await import('../lib/splat/render');
    const render = await runChunked(splatViewChunks(cloud, o), { onProgress, signal });

    // The step between adjacent eyes, and what the far edge of the cloud does
    // across it — the number that decides whether the print reads as depth.
    const eyes = render.offsetsMm;
    const stepMm = eyes.length > 1 ? Math.abs(eyes[1] - eyes[0]) : 0;
    const disparity = disparityAtDepth(stepMm, -render.farMm, o.viewDistanceMm, num(config.lpi, 45));

    // A horizontal run goes out reversed, because a lenticule shows its
    // leftmost strip to an eye on the right; a grid goes out in gridCells
    // order, which is what Lens Grid Print reads and which it inverts itself.
    const views =
      o.layout === '1d' && bool(config.mirrorViews, true) ? [...render.views].reverse() : render.views;
    return {
      views: { kind: 'sequence', frames: views },
      depth: bool(config.flipDepth, false) ? invertRaster(render.depth) : render.depth,
      info: {
        kind: 'text',
        text: describeSplatViews(config, o, render, disparity, describePlacementOf(render)),
      },
    };
  },
};

/** White ↔ black, for a depth map that wants far = white. */
function invertRaster(img: { kind: 'image'; width: number; height: number; data: Uint8ClampedArray }) {
  const out = { kind: 'image' as const, width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) };
  for (let i = 0; i < out.data.length; i += 4) {
    out.data[i] = 255 - out.data[i];
    out.data[i + 1] = 255 - out.data[i + 1];
    out.data[i + 2] = 255 - out.data[i + 2];
  }
  return out;
}

export const splatNodes: NodeDefinition[] = [splatInputNode, splatCameraNode, splatViewsNode];
