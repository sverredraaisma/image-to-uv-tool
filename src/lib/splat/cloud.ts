// A Gaussian splat cloud: the bits every other splat module needs, and none of
// the bits any one of them needs alone.
//
// This file is small on purpose. `parse.ts` and `render.ts` are the two heavy
// halves and are both fetched only when a graph actually contains a splat node
// (see `nodes/splat.ts`), so anything they *share* has to live somewhere that
// is cheap to load — otherwise the shared code drags one of them into the main
// bundle behind the other's back.

import type { SplatValue, TransformValue } from '../../types';

/**
 * Most splats an import will keep.
 *
 * A memory backstop, and nothing more. It is deliberately far above any figure
 * that would be chosen for quality, because quality is not decided here: the
 * renderer thins what it draws *after* culling, so the splats you can actually
 * see get the whole budget instead of a share of it. Throwing detail away at
 * the door would be throwing it away everywhere at once, permanently, to pay
 * for a part of the scene the camera may never point at.
 *
 * At 44 bytes a splat this is ~350 MB of typed arrays, which is the point where
 * a browser tab holding print rasters as well starts to be in real trouble.
 * Past it the import strides, because a cloud that will not fit is better
 * thinned than refused.
 */
export const MAX_IMPORT_SPLATS = 8_000_000;

/**
 * Does this file start with a ZIP local header, and so is possibly a bundled
 * `.sog`?
 *
 * It lives here, in the module both halves can afford to load, so that deciding
 * *which* reader a file needs does not require loading either of them.
 */
export const looksLikeZip = (bytes: Uint8Array): boolean =>
  bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

/** Axis-aligned extent of a cloud, ignoring the ellipsoid radii. */
export interface CloudBounds {
  min: [number, number, number];
  max: [number, number, number];
  centre: [number, number, number];
  size: [number, number, number];
  /** Half the diagonal — a single number for "how big is this scene". */
  radius: number;
}

export function cloudBounds(cloud: SplatValue): CloudBounds {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < cloud.count; i++) {
    for (let a = 0; a < 3; a++) {
      const v = cloud.positions[i * 3 + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  if (!Number.isFinite(min[0])) {
    return { min: [0, 0, 0], max: [0, 0, 0], centre: [0, 0, 0], size: [0, 0, 0], radius: 0 };
  }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  return {
    min,
    max,
    centre: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    size,
    radius: Math.hypot(size[0], size[1], size[2]) / 2,
  };
}

const DEG = Math.PI / 180;

/**
 * The camera's 3×3 basis, row-major, as world → camera.
 *
 * Yaw about Y, then pitch about X, then roll about Z — the order a person flies
 * in, where yaw is always about the world's up axis however far you have looked
 * down, so the horizon cannot drift. The rows are the camera's right, up and
 * backward axes in world space, which is exactly what a world → camera rotation
 * is, so this doubles as the matrix and as "which way am I facing".
 */
export function cameraBasis(rotationDeg: [number, number, number]): Float64Array {
  const [pitch, yaw, roll] = rotationDeg.map((d) => d * DEG);
  const cp = Math.cos(pitch),
    sp = Math.sin(pitch);
  const cy = Math.cos(yaw),
    sy = Math.sin(yaw);
  const cr = Math.cos(roll),
    sr = Math.sin(roll);

  // R = Ry(yaw) · Rx(pitch) · Rz(roll), camera → world; the transpose is
  // returned, because every caller wants world → camera.
  const m = new Float64Array(9);
  // camera → world, column vectors right / up / backward:
  const rx = cy * cr + sy * sp * sr,
    ry = cp * sr,
    rz = -sy * cr + cy * sp * sr;
  const ux = -cy * sr + sy * sp * cr,
    uy = cp * cr,
    uz = sy * sr + cy * sp * cr;
  const bx = sy * cp,
    by = -sp,
    bz = cy * cp;
  // Transposed into world → camera: the axes become the rows.
  m[0] = rx;
  m[1] = ry;
  m[2] = rz;
  m[3] = ux;
  m[4] = uy;
  m[5] = uz;
  m[6] = bx;
  m[7] = by;
  m[8] = bz;
  return m;
}

/** The camera's forward direction in world space (−Z of its own basis). */
export function cameraForward(rotationDeg: [number, number, number]): [number, number, number] {
  const m = cameraBasis(rotationDeg);
  return [-m[6], -m[7], -m[8]];
}

/** Right and up, in world space — what WASD and Space/Shift move along. */
export function cameraAxes(rotationDeg: [number, number, number]): {
  right: [number, number, number];
  up: [number, number, number];
  forward: [number, number, number];
} {
  const m = cameraBasis(rotationDeg);
  return { right: [m[0], m[1], m[2]], up: [m[3], m[4], m[5]], forward: [-m[6], -m[7], -m[8]] };
}

/**
 * A camera that frames the whole cloud, for a first look.
 *
 * The camera's position is the sheet plane, and everything in front of that
 * plane is discarded — so framing on the *centre* of the cloud would throw away
 * its whole front half. It goes on the near face of the bounding sphere
 * instead: the sheet just touches the scene, all of which is then behind the
 * paper. The same placement the mesh nodes call a setback of zero, and the
 * deepest window you can have without losing anything.
 */
export function framingCamera(cloud: SplatValue, widthMm: number, _viewDistanceMm = 400): TransformValue {
  const b = cloudBounds(cloud);
  const radius = Math.max(1e-6, b.radius);
  // The sheet spans the cloud's width; scale is what converts the two.
  const scale = (radius * 2) / Math.max(1, widthMm);
  const forward = cameraForward([0, 0, 0]);
  return {
    kind: 'transform',
    // Back off from the centre by the radius, along the view direction, so the
    // plane lands on the front of the scene rather than through the middle.
    position: [
      b.centre[0] - forward[0] * radius,
      b.centre[1] - forward[1] * radius,
      b.centre[2] - forward[2] * radius,
    ],
    rotationDeg: [0, 0, 0],
    scale,
  };
}

/** A transform's numbers, rounded for a report. */
export function describeCamera(t: TransformValue, widthMm = 100): string {
  const n = (v: number) => (Math.round(v * 1000) / 1000).toString();
  const [px, py, pz] = t.position;
  const [pitch, yaw, roll] = t.rotationDeg;
  return [
    `Position ${n(px)}, ${n(py)}, ${n(pz)} (scene units)`,
    `Facing yaw ${Math.round(yaw)}° · pitch ${Math.round(pitch)}° · roll ${Math.round(roll)}°`,
    `Scale ${n(t.scale)} scene units per mm — a ${widthMm} mm sheet spans ` +
      `${n(t.scale * widthMm)} units of the scene`,
  ].join('\n');
}
