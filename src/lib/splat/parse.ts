// Reading a Gaussian splat file.
//
// Two formats, because between them they cover everything a person is likely to
// have on disk:
//
//   • .ply — what the original INRIA implementation writes and what almost
//     every trainer and viewer still exchanges. A text header naming an
//     arbitrary list of per-vertex properties, then the rows as raw
//     little-endian binary. Verbose (248 bytes a splat at SH degree 3) but
//     completely self-describing, which is why the header is parsed properly
//     here rather than assumed.
//   • .splat — the compact 32-byte-per-splat layout from the antimatter15
//     viewer, which most web tools export. No header at all: the file *is* the
//     array, so the only validation possible is that its length divides by 32.
//
// The stored values are not the values you render. A trainer optimises
// unconstrained numbers and squashes them at the last moment, so scales come
// back as logarithms, opacity as a logit, and colour as the DC term of a
// spherical-harmonic series. Undoing all three is what `decodePly` is mostly
// doing, and getting any of them wrong gives you a cloud that parses cleanly
// and renders as fog.
//
// This module is fetched on demand — see `nodes/splat.ts`.

import type { SplatValue } from '../../types';
import type { ChunkProgress } from '../chunked';
import { MAX_SPLATS } from './cloud';

/**
 * The zeroth spherical-harmonic basis function, 1/(2√π).
 *
 * The DC coefficient is not a colour: it is the constant term of a series whose
 * basis function carries this factor. `colour = 0.5 + C0 · f_dc` recovers the
 * albedo the trainer meant, and the 0.5 is the mid-grey the series is centred
 * on. Skip the constant and everything comes out washed out but plausible,
 * which is the worst kind of wrong.
 */
export const SH_C0 = 0.28209479177387814;

const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));

/** Bytes of each PLY scalar type, by every spelling the format allows. */
const PLY_TYPE_BYTES: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

interface PlyProperty {
  name: string;
  type: string;
  offset: number;
}

export interface PlyHeader {
  /** Byte offset the vertex data starts at. */
  dataStart: number;
  count: number;
  stride: number;
  properties: Map<string, PlyProperty>;
  /** Highest SH band present in the file, 0–3. Only the DC term is kept. */
  shDegree: number;
}

/** Find `end_header` and read the vertex element's property list. */
export function parsePlyHeader(bytes: Uint8Array): PlyHeader {
  // The header is ASCII, so it is safe to decode a bounded prefix of the file
  // rather than the (potentially gigabyte) whole.
  const probe = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, Math.min(bytes.length, 65536)));
  const marker = probe.indexOf('end_header');
  if (!probe.startsWith('ply') || marker < 0) {
    throw new Error('Not a PLY file — no “ply” magic or no end_header in the first 64 KB.');
  }
  const eol = probe.indexOf('\n', marker);
  const dataStart = eol + 1;
  const lines = probe.slice(0, marker).split(/\r?\n/);

  const format = lines.find((l) => l.startsWith('format'))?.trim() ?? '';
  if (!/binary_little_endian/.test(format)) {
    throw new Error(
      `PLY is “${format.replace('format', '').trim() || 'unknown'}” — only binary_little_endian is ` +
        'supported. Re-export from SuperSplat or any splat tool to convert it.',
    );
  }

  const properties = new Map<string, PlyProperty>();
  let count = 0;
  let stride = 0;
  let inVertex = false;
  let shCoeffs = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('element ')) {
      const [, name, n] = line.split(/\s+/);
      inVertex = name === 'vertex';
      if (inVertex) count = parseInt(n, 10) || 0;
      continue;
    }
    if (!inVertex || !line.startsWith('property ')) continue;
    const [, type, name] = line.split(/\s+/);
    const size = PLY_TYPE_BYTES[type];
    if (!size) throw new Error(`PLY property “${name}” has unsupported type “${type}”.`);
    properties.set(name, { name, type, offset: stride });
    stride += size;
    if (name.startsWith('f_rest_')) shCoeffs++;
  }

  for (const need of ['x', 'y', 'z', 'scale_0', 'rot_0', 'opacity', 'f_dc_0']) {
    if (!properties.has(need)) {
      throw new Error(
        `PLY has no “${need}” property — it looks like a plain point cloud or mesh, not a Gaussian ` +
          'splat file.',
      );
    }
  }
  // 3 per band per channel: 9 coefficients is degree 1, 24 is degree 2, 45 is 3.
  const perChannel = shCoeffs / 3;
  const shDegree = perChannel >= 15 ? 3 : perChannel >= 8 ? 2 : perChannel >= 3 ? 1 : 0;
  return { dataStart, count, stride, properties, shDegree };
}

/** Read one scalar out of a packed PLY row. */
function readScalar(view: DataView, at: number, type: string): number {
  switch (type) {
    case 'float':
    case 'float32':
      return view.getFloat32(at, true);
    case 'double':
    case 'float64':
      return view.getFloat64(at, true);
    case 'uchar':
    case 'uint8':
      return view.getUint8(at);
    case 'char':
    case 'int8':
      return view.getInt8(at);
    case 'ushort':
    case 'uint16':
      return view.getUint16(at, true);
    case 'short':
    case 'int16':
      return view.getInt16(at, true);
    case 'uint':
    case 'uint32':
      return view.getUint32(at, true);
    default:
      return view.getInt32(at, true);
  }
}

/**
 * How to walk a file of `count` splats while keeping at most {@link MAX_SPLATS}.
 *
 * The stride is applied *while reading*, not afterwards. Reading everything and
 * thinning at the end would allocate four or five times the arrays it keeps —
 * on a capture large enough to need thinning, that is the allocation most
 * likely to fail — and it buys nothing, because an even stride over the whole
 * file is the same set of splats whichever end you do it from.
 */
function walk(count: number): { total: number; step: number; dropped: number } {
  const total = Math.min(count, MAX_SPLATS);
  return { total, step: count > MAX_SPLATS ? count / MAX_SPLATS : 1, dropped: count - total };
}

/**
 * Decode a PLY splat file, a band of rows at a time.
 *
 * A file past {@link MAX_SPLATS} is strided rather than truncated — see
 * {@link walk}. Stopping early would keep whichever corner of the scene the
 * trainer happened to write first; a stride keeps all of it, at lower density.
 */
export function* parsePlyChunks(bytes: Uint8Array, name = ''): Generator<ChunkProgress, SplatValue> {
  const header = parsePlyHeader(bytes);
  const { total, step, dropped } = walk(header.count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const p = header.properties;

  const positions = new Float32Array(total * 3);
  const scales = new Float32Array(total * 3);
  const rotations = new Float32Array(total * 4);
  const colours = new Uint8ClampedArray(total * 4);

  const prop = (n: string) => p.get(n);
  const px = prop('x')!,
    py = prop('y')!,
    pz = prop('z')!;
  const s0 = prop('scale_0')!,
    s1 = prop('scale_1') ?? s0,
    s2 = prop('scale_2') ?? s0;
  const r0 = prop('rot_0')!,
    r1 = prop('rot_1') ?? r0,
    r2 = prop('rot_2') ?? r0,
    r3 = prop('rot_3') ?? r0;
  const op = prop('opacity')!;
  const c0 = prop('f_dc_0')!,
    c1 = prop('f_dc_1') ?? c0,
    c2 = prop('f_dc_2') ?? c0;

  const BAND = 50_000;
  for (let i = 0; i < total; i++) {
    const src = step > 1 ? Math.min(header.count - 1, Math.floor(i * step)) : i;
    const row = header.dataStart + src * header.stride;
    if (row + header.stride > bytes.byteLength) {
      throw new Error(`PLY ends after ${i.toLocaleString()} of ${header.count.toLocaleString()} splats.`);
    }
    const at = (q: PlyProperty) => readScalar(view, row + q.offset, q.type);

    positions[i * 3] = at(px);
    positions[i * 3 + 1] = at(py);
    positions[i * 3 + 2] = at(pz);
    // Stored as logarithms so the optimiser can move freely and never produce a
    // negative radius.
    scales[i * 3] = Math.exp(at(s0));
    scales[i * 3 + 1] = Math.exp(at(s1));
    scales[i * 3 + 2] = Math.exp(at(s2));
    // PLY writes the quaternion scalar-first (rot_0 = w); everything downstream
    // here wants x, y, z, w.
    const qw = at(r0),
      qx = at(r1),
      qy = at(r2),
      qz = at(r3);
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    rotations[i * 4] = qx / len;
    rotations[i * 4 + 1] = qy / len;
    rotations[i * 4 + 2] = qz / len;
    rotations[i * 4 + 3] = qw / len;

    colours[i * 4] = (0.5 + SH_C0 * at(c0)) * 255;
    colours[i * 4 + 1] = (0.5 + SH_C0 * at(c1)) * 255;
    colours[i * 4 + 2] = (0.5 + SH_C0 * at(c2)) * 255;
    // Opacity is a logit, for the same reason the scales are logarithms.
    colours[i * 4 + 3] = sigmoid(at(op)) * 255;

    if (i % BAND === BAND - 1) {
      yield { done: Math.floor(i / BAND) + 1, total: Math.ceil(total / BAND), what: 'Reading splats' };
    }
  }

  return { kind: 'splat', count: total, positions, scales, rotations, colours, name, droppedCount: dropped };
}

/** Bytes per splat in the .splat format: 12 position, 12 scale, 4 colour, 4 rotation. */
export const SPLAT_RECORD_BYTES = 32;

/**
 * Decode the compact .splat layout.
 *
 * Everything is already decoded here — scales are radii, opacity is the colour's
 * alpha, and the quaternion is stored as four bytes biased by 128 — so unlike
 * the PLY path there is nothing to undo. The quaternion is scalar-first, as in
 * the PLY it was converted from.
 */
export function* parseSplatChunks(bytes: Uint8Array, name = ''): Generator<ChunkProgress, SplatValue> {
  if (bytes.byteLength === 0 || bytes.byteLength % SPLAT_RECORD_BYTES !== 0) {
    throw new Error(
      `A .splat file is a flat array of ${SPLAT_RECORD_BYTES}-byte records, but this one is ` +
        `${bytes.byteLength.toLocaleString()} bytes, which does not divide. It may be a .ply that was ` +
        'renamed, or truncated.',
    );
  }
  const count = bytes.byteLength / SPLAT_RECORD_BYTES;
  const { total, step, dropped } = walk(count);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const positions = new Float32Array(total * 3);
  const scales = new Float32Array(total * 3);
  const rotations = new Float32Array(total * 4);
  const colours = new Uint8ClampedArray(total * 4);

  const BAND = 50_000;
  for (let i = 0; i < total; i++) {
    const at = (step > 1 ? Math.min(count - 1, Math.floor(i * step)) : i) * SPLAT_RECORD_BYTES;
    for (let a = 0; a < 3; a++) {
      positions[i * 3 + a] = view.getFloat32(at + a * 4, true);
      scales[i * 3 + a] = view.getFloat32(at + 12 + a * 4, true);
    }
    for (let a = 0; a < 4; a++) colours[i * 4 + a] = view.getUint8(at + 24 + a);
    const qw = (view.getUint8(at + 28) - 128) / 128;
    const qx = (view.getUint8(at + 29) - 128) / 128;
    const qy = (view.getUint8(at + 30) - 128) / 128;
    const qz = (view.getUint8(at + 31) - 128) / 128;
    const len = Math.hypot(qx, qy, qz, qw) || 1;
    rotations[i * 4] = qx / len;
    rotations[i * 4 + 1] = qy / len;
    rotations[i * 4 + 2] = qz / len;
    rotations[i * 4 + 3] = qw / len;

    if (i % BAND === BAND - 1) {
      yield { done: Math.floor(i / BAND) + 1, total: Math.ceil(total / BAND), what: 'Reading splats' };
    }
  }

  return { kind: 'splat', count: total, positions, scales, rotations, colours, name, droppedCount: dropped };
}

/** Which of the two decoders a file wants, by its magic rather than its name. */
export function* parseSplatFileChunks(bytes: Uint8Array, name = ''): Generator<ChunkProgress, SplatValue> {
  const isPly = bytes.length >= 3 && bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79;
  return yield* isPly ? parsePlyChunks(bytes, name) : parseSplatChunks(bytes, name);
}

/** {@link parseSplatFileChunks}, run straight through. */
export function parseSplatFile(bytes: Uint8Array, name = ''): SplatValue {
  const gen = parseSplatFileChunks(bytes, name);
  let step = gen.next();
  while (!step.done) step = gen.next();
  return step.value;
}
