// Reading a SOG bundle — the Self-Organizing Gaussians format.
//
// SOG is the odd one out among the three formats this tool reads, and the
// reason is worth stating because it decides the shape of everything below: a
// SOG file does not store splats. It stores *textures* of splats. The encoder
// sorts the cloud so that neighbouring gaussians end up next to each other in a
// 2D image, at which point every attribute becomes a smooth picture that an
// ordinary image codec compresses extremely well. A scene that is 1.4 GB of
// PLY is a few tens of megabytes of lossless WebP.
//
// So there is no record layout here. There is a `meta.json` and half a dozen
// images, each pixel of which is one gaussian, and decoding means undoing four
// separate quantisation schemes:
//
//   • Positions are 16-bit per axis, split across two 8-bit textures (a low
//     byte and a high byte), normalised into a per-axis range, and stored
//     through a log transform so that near detail gets more of the 16 bits than
//     far detail does.
//   • Scales and colours are codebook indices: the byte is not a value, it is a
//     lookup into a 256-entry table in the metadata.
//   • Rotations use the smallest-three scheme — the largest quaternion
//     component is dropped and rebuilt from the other three, with a tag byte
//     saying which one went.
//   • Opacity alone is what it looks like: a plain 0–255 alpha.
//
// The decode below follows PlayCanvas's own reader, which is the authority on
// this format (`splat-transform`, `src/lib/readers/read-sog.ts`).
//
// One consequence of it being images: WebP cannot be decoded in JavaScript
// worth the name, so this module does not try. It takes already-decoded RGBA
// rasters and is a pure function of them; the browser's own image decoder does
// the actual WebP work, at the edge, in `loadSogBundle`. That keeps the part
// with all the arithmetic in it testable in Node, which is where the bugs are.
//
// This module is fetched on demand — see `nodes/splat.ts`.

import type { RasterImage, SplatValue } from '../../types';
import type { ChunkProgress } from '../chunked';
import { MAX_SPLATS, decimate } from './cloud';
import { SH_C0 } from './parse';
import { readZip } from '../zip';

/** The subset of `meta.json` this reader needs. */
export interface SogMeta {
  version: number;
  count: number;
  means: { mins: number[]; maxs: number[]; files: string[] };
  scales: { codebook: number[]; files: string[] };
  quats: { files: string[] };
  sh0: { codebook: number[]; files: string[] };
}

/** The decoded textures, by the role they play rather than by file name. */
export interface SogTextures {
  meansLow: RasterImage;
  meansHigh: RasterImage;
  quats: RasterImage;
  scales: RasterImage;
  sh0: RasterImage;
}

/**
 * Which of the (w, x, y, z) slots the three stored components fill, for each
 * value of the tag byte.
 *
 * The smallest-three scheme drops whichever component is largest — it can
 * always be rebuilt, since the quaternion is a unit vector — and the tag says
 * which one that was. Row `m` of this table lists the three that survived, in
 * order, when component `m` was the one dropped.
 */
const QUAT_SLOTS = [
  [1, 2, 3],
  [0, 2, 3],
  [0, 1, 3],
  [0, 1, 2],
];

/** Dropping the largest component bounds the rest by this, which sets the scale. */
const SQRT2 = Math.SQRT2;

/** Undo the log transform positions are stored through. */
export const unlog = (v: number): number => Math.sign(v) * (Math.exp(Math.abs(v)) - 1);

/** Validate and normalise a parsed meta.json, or say precisely what is wrong. */
export function parseSogMeta(raw: unknown): SogMeta {
  const m = raw as Partial<SogMeta> & { version?: number };
  if (!m || typeof m !== 'object') throw new Error('SOG meta.json is not an object.');
  if (m.version !== 2) {
    throw new Error(
      `SOG meta.json says version ${m.version ?? '(none)'} — this reader handles version 2. ` +
        'Re-export with a current splat-transform to convert it.',
    );
  }
  const count = Number(m.count);
  if (!Number.isFinite(count) || count < 1) throw new Error('SOG meta.json has no usable splat count.');
  const need = <T>(v: T | undefined, what: string): T => {
    if (v == null) throw new Error(`SOG meta.json has no “${what}” section.`);
    return v;
  };
  const means = need(m.means, 'means');
  const scales = need(m.scales, 'scales');
  const sh0 = need(m.sh0, 'sh0');
  if (!Array.isArray(means.mins) || means.mins.length < 3 || !Array.isArray(means.maxs) || means.maxs.length < 3) {
    throw new Error('SOG meta.json “means” needs mins and maxs of three numbers each.');
  }
  for (const [name, table] of [
    ['scales', scales.codebook],
    ['sh0', sh0.codebook],
  ] as const) {
    if (!Array.isArray(table) || table.length === 0) {
      throw new Error(`SOG meta.json “${name}” has no codebook — its bytes would mean nothing.`);
    }
  }
  return {
    version: 2,
    count,
    means: { mins: means.mins, maxs: means.maxs, files: means.files ?? [] },
    scales: { codebook: scales.codebook, files: scales.files ?? [] },
    quats: { files: need(m.quats, 'quats').files ?? [] },
    sh0: { codebook: sh0.codebook, files: sh0.files ?? [] },
  };
}

/**
 * Turn the textures into a cloud, a band of splats at a time.
 *
 * Every texture is read at the same flat offset — pixel `i` of each is
 * gaussian `i` — which is what makes this a single pass rather than five.
 */
export function* decodeSogChunks(
  meta: SogMeta,
  tex: SogTextures,
  name = '',
): Generator<ChunkProgress, SplatValue> {
  const pixels = Math.min(
    tex.meansLow.width * tex.meansLow.height,
    tex.meansHigh.width * tex.meansHigh.height,
    tex.quats.width * tex.quats.height,
    tex.scales.width * tex.scales.height,
    tex.sh0.width * tex.sh0.height,
  );
  // The textures are padded out to a rectangle, so they hold at least `count`
  // splats and usually a few more; trailing pixels are not splats at all.
  const total = Math.min(meta.count, pixels);
  if (total < 1) {
    throw new Error(
      `SOG textures hold ${pixels} pixels but the metadata claims ${meta.count.toLocaleString()} splats — ` +
        'the bundle is inconsistent.',
    );
  }

  const lo = tex.meansLow.data;
  const hi = tex.meansHigh.data;
  const q = tex.quats.data;
  const s = tex.scales.data;
  const c = tex.sh0.data;
  const { mins, maxs } = meta.means;
  const scaleBook = meta.scales.codebook;
  const colourBook = meta.sh0.codebook;
  const lastScale = scaleBook.length - 1;
  const lastColour = colourBook.length - 1;

  const positions = new Float32Array(total * 3);
  const scales = new Float32Array(total * 3);
  const rotations = new Float32Array(total * 4);
  const colours = new Uint8ClampedArray(total * 4);
  const quat = [0, 0, 0, 0];

  const BAND = 50_000;
  for (let i = 0; i < total; i++) {
    const o = i * 4;

    for (let a = 0; a < 3; a++) {
      // 16 bits split across two textures: the low byte and the high byte of
      // the same axis, in the same pixel of each.
      const v = (lo[o + a] | (hi[o + a] << 8)) / 65535;
      positions[i * 3 + a] = unlog(mins[a] + (maxs[a] - mins[a]) * v);
      // The codebook holds logarithms, as every splat format's scales do.
      scales[i * 3 + a] = Math.exp(scaleBook[Math.min(lastScale, s[o + a])]);
    }

    // Smallest three: rebuild the dropped component from the other three.
    const dropped = Math.max(0, Math.min(3, q[o + 3] - 252));
    const slots = QUAT_SLOTS[dropped];
    let sum = 0;
    for (let k = 0; k < 3; k++) {
      const v = ((q[o + k] / 255) * 2 - 1) / SQRT2;
      quat[slots[k]] = v;
      sum += v * v;
    }
    quat[dropped] = Math.sqrt(Math.max(0, 1 - sum));
    // SOG orders the components (w, x, y, z); a cloud stores them (x, y, z, w).
    rotations[i * 4] = quat[1];
    rotations[i * 4 + 1] = quat[2];
    rotations[i * 4 + 2] = quat[3];
    rotations[i * 4 + 3] = quat[0];

    // The colour bytes are codebook indices, and the entries are DC
    // coefficients — so they go through the same SH constant a PLY's do.
    for (let k = 0; k < 3; k++) {
      colours[o + k] = (0.5 + colourBook[Math.min(lastColour, c[o + k])] * SH_C0) * 255;
    }
    // Opacity is the one field stored as what it means.
    colours[o + 3] = c[o + 3];

    if (i % BAND === BAND - 1) {
      yield { done: Math.floor(i / BAND) + 1, total: Math.ceil(total / BAND), what: 'Reading splats' };
    }
  }

  const cloud: SplatValue = {
    kind: 'splat',
    count: total,
    positions,
    scales,
    rotations,
    colours,
    name,
    droppedCount: meta.count - total,
  };
  return decimate(cloud, MAX_SPLATS);
}

/** Pick an entry by the metadata's own file list, falling back to its role name. */
function pickFile(files: Map<string, Uint8Array>, listed: string[], index: number, hint: string): Uint8Array {
  const named = listed[index];
  // The listed name wins: it is what the writer said it wrote. The hint is for
  // bundles whose `files` arrays are missing or short, which older writers
  // produced.
  const byList = named ? files.get(named) ?? files.get(named.replace(/^.*\//, '')) : undefined;
  if (byList) return byList;
  for (const [key, value] of files) {
    if (key.includes(hint)) return value;
  }
  throw new Error(`SOG bundle has no “${named || hint}” texture.`);
}

/** How an already-decoded image gets back here. See the note at the top. */
export type DecodeImage = (bytes: Uint8Array, mime: string) => Promise<RasterImage>;

export interface SogBundle {
  meta: SogMeta;
  textures: SogTextures;
}

/**
 * Open a bundled `.sog`, decode its images, and hand back what
 * {@link decodeSogChunks} needs.
 *
 * Only the single-file bundle is supported, not the loose directory form of
 * SOG — a file picker hands over one file, and a folder of seven is not
 * something this tool can accept.
 */
export async function loadSogBundle(bytes: Uint8Array, decodeImage: DecodeImage): Promise<SogBundle> {
  const files = await readZip(bytes);
  const metaBytes = files.get('meta.json') ?? [...files].find(([k]) => k.endsWith('meta.json'))?.[1];
  if (!metaBytes) {
    throw new Error(
      'This ZIP has no meta.json, so it is not a SOG bundle. If you have a SOG *folder*, bundle it into ' +
        'a single .sog first (splat-transform does this).',
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(metaBytes));
  } catch {
    throw new Error('SOG meta.json is not valid JSON.');
  }
  const meta = parseSogMeta(parsed);

  const image = async (listed: string[], index: number, hint: string) =>
    decodeImage(pickFile(files, listed, index, hint), 'image/webp');

  // means.files is [low, high] — the low byte first, as the writer emits it.
  const [meansLow, meansHigh, quats, scales, sh0] = await Promise.all([
    image(meta.means.files, 0, 'means_l'),
    image(meta.means.files, 1, 'means_u'),
    image(meta.quats.files, 0, 'quats'),
    image(meta.scales.files, 0, 'scales'),
    image(meta.sh0.files, 0, 'sh0'),
  ]);
  return { meta, textures: { meansLow, meansHigh, quats, scales, sh0 } };
}
