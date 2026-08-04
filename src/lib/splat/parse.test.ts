import { describe, it, expect } from 'vitest';
import {
  SH_C0,
  SPLAT_RECORD_BYTES,
  parsePlyHeader,
  parseSplatFile,
  parseSplatChunks,
} from './parse';

/** Build a binary PLY with the given property list and rows of numbers. */
function plyFile(props: string[], rows: number[][], format = 'binary_little_endian 1.0'): Uint8Array {
  const header =
    `ply\nformat ${format}\nelement vertex ${rows.length}\n` +
    props.map((p) => `property float ${p}\n`).join('') +
    'end_header\n';
  const head = new TextEncoder().encode(header);
  const body = new Float32Array(rows.flat());
  const out = new Uint8Array(head.length + body.byteLength);
  out.set(head, 0);
  out.set(new Uint8Array(body.buffer), head.length);
  return out;
}

/** The properties the INRIA writer emits, in its own order, minus the SH rest. */
const PROPS = [
  'x',
  'y',
  'z',
  'nx',
  'ny',
  'nz',
  'f_dc_0',
  'f_dc_1',
  'f_dc_2',
  'opacity',
  'scale_0',
  'scale_1',
  'scale_2',
  'rot_0',
  'rot_1',
  'rot_2',
  'rot_3',
];

/** One splat: at (1,2,3), mid-grey, opaque-ish, radius e⁻² , identity rotation. */
const ROW = [1, 2, 3, 0, 0, 0, 0, 0, 0, 0, -2, -2, -2, 1, 0, 0, 0];

describe('splat file parsing', () => {
  it('reads a binary PLY header, offsets and all', () => {
    const h = parsePlyHeader(plyFile(PROPS, [ROW]));
    expect(h.count).toBe(1);
    // 17 float properties.
    expect(h.stride).toBe(17 * 4);
    expect(h.properties.get('x')?.offset).toBe(0);
    expect(h.properties.get('opacity')?.offset).toBe(9 * 4);
    expect(h.shDegree).toBe(0);
  });

  it('undoes the three transforms a trainer applies', () => {
    const cloud = parseSplatFile(plyFile(PROPS, [ROW]), 'one.ply');
    expect(cloud.count).toBe(1);
    expect([...cloud.positions]).toEqual([1, 2, 3]);
    // Scales are logarithms…
    expect(cloud.scales[0]).toBeCloseTo(Math.exp(-2), 6);
    // …opacity is a logit, and 0 is the middle of it…
    expect(cloud.colours[3]).toBe(128);
    // …and f_dc is a spherical-harmonic coefficient, not a colour: 0 is the
    // mid-grey the series is centred on, not black.
    expect(cloud.colours[0]).toBe(128);
    // The quaternion is stored scalar-first and comes out xyzw.
    expect([...cloud.rotations]).toEqual([0, 0, 0, 1]);
    expect(cloud.name).toBe('one.ply');
  });

  it('applies the SH constant, not a bare scale', () => {
    const bright = [...ROW];
    bright[6] = 1; // f_dc_0
    const cloud = parseSplatFile(plyFile(PROPS, [bright]));
    expect(cloud.colours[0]).toBe(Math.round((0.5 + SH_C0) * 255));
    expect(cloud.colours[1]).toBe(128); // the other channels untouched
  });

  it('normalises the quaternion it is given', () => {
    const skew = [...ROW];
    skew[13] = 2; // rot_0 = w
    skew[14] = 2; // rot_1 = x
    const cloud = parseSplatFile(plyFile(PROPS, [skew]));
    const [x, y, z, w] = cloud.rotations;
    expect(Math.hypot(x, y, z, w)).toBeCloseTo(1, 6);
  });

  it('counts the spherical-harmonic bands a file carries', () => {
    const withSh = [...PROPS, ...Array.from({ length: 9 }, (_, i) => `f_rest_${i}`)];
    const h = parsePlyHeader(plyFile(withSh, [[...ROW, ...Array(9).fill(0)]]));
    expect(h.shDegree).toBe(1);
  });

  it('refuses what it cannot read, with a reason', () => {
    expect(() => parsePlyHeader(new TextEncoder().encode('not a ply at all'))).toThrow(/Not a PLY/);
    expect(() => parsePlyHeader(plyFile(PROPS, [ROW], 'ascii 1.0'))).toThrow(/binary_little_endian/);
    // A plain point cloud has x/y/z but none of the splat properties.
    expect(() => parsePlyHeader(plyFile(['x', 'y', 'z'], [[1, 2, 3]]))).toThrow(/not a Gaussian splat/);
  });

  it('reads the compact .splat layout', () => {
    const buf = new ArrayBuffer(SPLAT_RECORD_BYTES);
    const v = new DataView(buf);
    v.setFloat32(0, 4, true);
    v.setFloat32(4, 5, true);
    v.setFloat32(8, 6, true);
    v.setFloat32(12, 0.1, true);
    v.setFloat32(16, 0.2, true);
    v.setFloat32(20, 0.3, true);
    v.setUint8(24, 200);
    v.setUint8(25, 100);
    v.setUint8(26, 50);
    v.setUint8(27, 255);
    // Quaternion bytes are biased by 128: w = 1, xyz = 0.
    v.setUint8(28, 255);
    v.setUint8(29, 128);
    v.setUint8(30, 128);
    v.setUint8(31, 128);

    const cloud = parseSplatFile(new Uint8Array(buf), 'one.splat');
    expect(cloud.count).toBe(1);
    expect([...cloud.positions]).toEqual([4, 5, 6]);
    // Already radii here — no exp, unlike the PLY path.
    expect(cloud.scales[0]).toBeCloseTo(0.1, 6);
    expect([...cloud.colours]).toEqual([200, 100, 50, 255]);
    expect(cloud.rotations[3]).toBeCloseTo(1, 6);
  });

  it('rejects a .splat whose length does not divide', () => {
    const gen = parseSplatChunks(new Uint8Array(33));
    expect(() => gen.next()).toThrow(/does not divide/);
  });

  it('picks the decoder by magic, not by the name it was given', () => {
    // PLY bytes, but called .splat.
    const cloud = parseSplatFile(plyFile(PROPS, [ROW]), 'lying.splat');
    expect(cloud.count).toBe(1);
    expect([...cloud.positions]).toEqual([1, 2, 3]);
  });

  it('reports progress a band at a time', () => {
    const rows = Array.from({ length: 3 }, () => ROW);
    const gen = parseSplatChunks(new Uint8Array(3 * SPLAT_RECORD_BYTES));
    let steps = 0;
    let step = gen.next();
    while (!step.done) {
      expect(step.value.what).toBe('Reading splats');
      steps++;
      step = gen.next();
    }
    // Three splats is well under one 50k band, so it finishes without yielding.
    expect(steps).toBe(0);
    expect(step.value.count).toBe(rows.length);
  });
});
