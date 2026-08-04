import { describe, it, expect } from 'vitest';
import { decodeSogChunks, loadSogBundle, parseSogMeta, unlog, type SogMeta } from './sog';
import { SH_C0 } from './parse';
import { makeZip } from '../zip';
import type { RasterImage } from '../../types';

/** A 1×n RGBA texture from a flat byte list. */
function tex(bytes: number[]): RasterImage {
  return {
    kind: 'image',
    width: bytes.length / 4,
    height: 1,
    data: new Uint8ClampedArray(bytes),
  };
}

const log = (v: number) => Math.sign(v) * Math.log(Math.abs(v) + 1);

/** Codebooks with a known, invertible shape: index i ↦ (i − 128)/64. */
const CODEBOOK = Array.from({ length: 256 }, (_, i) => (i - 128) / 64);

const meta = (over: Partial<SogMeta> = {}): SogMeta => ({
  version: 2,
  count: 1,
  means: { mins: [log(-10), log(-10), log(-10)], maxs: [log(10), log(10), log(10)], files: [] },
  scales: { codebook: CODEBOOK, files: [] },
  quats: { files: [] },
  sh0: { codebook: CODEBOOK, files: [] },
  ...over,
});

/** Encode a position the way the format does: log-transform, normalise, split. */
function encodePosition(value: number, min: number, max: number): { lo: number; hi: number } {
  const q = Math.round(((log(value) - min) / (max - min)) * 65535);
  return { lo: q & 0xff, hi: (q >> 8) & 0xff };
}

/** Encode a unit quaternion (w, x, y, z) with the smallest-three scheme. */
function encodeQuat(w: number, x: number, y: number, z: number): number[] {
  const comps = [w, x, y, z];
  let dropped = 0;
  for (let i = 1; i < 4; i++) if (Math.abs(comps[i]) > Math.abs(comps[dropped])) dropped = i;
  // The encoder flips the sign so the dropped component is positive; q and −q
  // are the same rotation, so this is free.
  const sign = comps[dropped] < 0 ? -1 : 1;
  const kept = comps.filter((_, i) => i !== dropped).map((v) => v * sign);
  const byte = (v: number) => Math.round(((v * Math.SQRT2 + 1) / 2) * 255);
  return [byte(kept[0]), byte(kept[1]), byte(kept[2]), 252 + dropped];
}

describe('SOG decoding', () => {
  it('rebuilds a position through the split 16-bit log encoding', () => {
    const m = meta();
    const target = 4.25;
    const { lo, hi } = encodePosition(target, m.means.mins[0], m.means.maxs[0]);
    const gen = decodeSogChunks(m, {
      meansLow: tex([lo, 0, 0, 255]),
      meansHigh: tex([hi, 0, 0, 255]),
      quats: tex([128, 128, 128, 255]),
      scales: tex([128, 128, 128, 255]),
      sh0: tex([128, 128, 128, 255]),
    });
    let step = gen.next();
    while (!step.done) step = gen.next();
    // 16 bits over a ±10 range, through a log, lands well inside a thousandth.
    expect(step.value.positions[0]).toBeCloseTo(target, 3);
    // Zero maps to the middle of the range, not to an edge.
    expect(step.value.positions[1]).toBeCloseTo(unlog(m.means.mins[1]), 3);
  });

  it('undoes the log transform the way the format defines it', () => {
    expect(unlog(0)).toBe(0);
    expect(unlog(log(7))).toBeCloseTo(7, 9);
    expect(unlog(log(-7))).toBeCloseTo(-7, 9);
    // The point of it: near values get more of the range than far ones.
    expect(Math.abs(log(1) - log(0))).toBeGreaterThan(Math.abs(log(101) - log(100)));
  });

  it('rebuilds every quaternion the smallest-three scheme can drop', () => {
    const cases: [number, number, number, number][] = [
      [1, 0, 0, 0], // w largest
      [0, 1, 0, 0], // x
      [0, 0, 1, 0], // y
      [0, 0, 0, 1], // z
      [0.5, 0.5, 0.5, 0.5],
      [-0.7071, 0, 0.7071, 0],
    ];
    for (const [w, x, y, z] of cases) {
      const gen = decodeSogChunks(meta(), {
        meansLow: tex([0, 0, 0, 255]),
        meansHigh: tex([0, 0, 0, 255]),
        quats: tex(encodeQuat(w, x, y, z)),
        scales: tex([128, 128, 128, 255]),
        sh0: tex([128, 128, 128, 255]),
      });
      let step = gen.next();
      while (!step.done) step = gen.next();
      // A cloud stores (x, y, z, w); SOG stores (w, x, y, z).
      const got = [...step.value.rotations];
      const want = [x, y, z, w];
      // The right comparison is the rotation, not the components: q and −q are
      // the same rotation and the encoder is free to flip, so |q·q'| ≈ 1 is
      // what "unchanged" means here.
      const dot = got.reduce((s, v, i) => s + v * want[i], 0);
      expect(Math.abs(dot)).toBeGreaterThan(0.9999);
      expect(Math.hypot(...got)).toBeCloseTo(1, 6);
      // Component-wise too, but at the format's real precision. Three
      // components quantised to 8 bits over [−√2/2, √2/2] is a step of
      // 0.0055, and the rebuilt fourth absorbs all three of their errors.
      const flip = dot < 0 ? -1 : 1;
      for (let i = 0; i < 4; i++) expect(Math.abs(got[i] * flip - want[i])).toBeLessThan(0.01);
    }
  });

  it('reads scales and colours as codebook indices, not as values', () => {
    const gen = decodeSogChunks(meta(), {
      meansLow: tex([0, 0, 0, 255]),
      meansHigh: tex([0, 0, 0, 255]),
      quats: tex([128, 128, 128, 255]),
      scales: tex([192, 128, 64, 255]),
      sh0: tex([192, 128, 64, 200]),
    });
    let step = gen.next();
    while (!step.done) step = gen.next();
    const c = step.value;
    // Codebook entries are logarithms, like every other format's scales.
    expect(c.scales[0]).toBeCloseTo(Math.exp(CODEBOOK[192]), 6);
    expect(c.scales[2]).toBeCloseTo(Math.exp(CODEBOOK[64]), 6);
    // Colour entries are SH DC coefficients, so they take the SH constant.
    expect(c.colours[0]).toBe(Math.round((0.5 + CODEBOOK[192] * SH_C0) * 255));
    expect(c.colours[1]).toBe(128); // CODEBOOK[128] is 0 → mid-grey
    // Opacity is the one field stored as what it means.
    expect(c.colours[3]).toBe(200);
  });

  it('ignores the padding pixels a texture is rounded up to', () => {
    // Four pixels of texture, but the metadata says there are only two splats.
    const four = (b: number[]) => tex([...b, ...b, ...b, ...b]);
    const gen = decodeSogChunks(meta({ count: 2 }), {
      meansLow: four([0, 0, 0, 255]),
      meansHigh: four([0, 0, 0, 255]),
      quats: four([128, 128, 128, 255]),
      scales: four([128, 128, 128, 255]),
      sh0: four([128, 128, 128, 255]),
    });
    let step = gen.next();
    while (!step.done) step = gen.next();
    expect(step.value.count).toBe(2);
  });

  it('refuses metadata it cannot trust, and says why', () => {
    expect(() => parseSogMeta({ version: 1, count: 5 })).toThrow(/version 1 .*handles version 2/s);
    expect(() => parseSogMeta({ version: 2 })).toThrow(/no usable splat count/);
    expect(() => parseSogMeta({ version: 2, count: 1 })).toThrow(/no “means” section/);
    expect(() =>
      parseSogMeta({ version: 2, count: 1, means: { mins: [0], maxs: [1] }, scales: {}, quats: {}, sh0: {} }),
    ).toThrow(/three numbers each/);
    expect(() =>
      parseSogMeta({
        version: 2,
        count: 1,
        means: { mins: [0, 0, 0], maxs: [1, 1, 1] },
        scales: {},
        quats: {},
        sh0: {},
      }),
    ).toThrow(/“scales” has no codebook/);
  });

  it('accepts the metadata a real bundle carries', () => {
    const m = parseSogMeta({
      version: 2,
      count: 12345,
      antialias: true,
      asset: { generator: 'splat-transform' },
      means: { mins: [-1, -2, -3], maxs: [1, 2, 3], files: ['means_l.webp', 'means_u.webp'] },
      scales: { codebook: CODEBOOK, files: ['scales.webp'] },
      quats: { files: ['quats.webp'] },
      sh0: { codebook: CODEBOOK, files: ['sh0.webp'] },
      shN: { count: 64, bands: 3, codebook: CODEBOOK, files: [] },
    });
    expect(m.count).toBe(12345);
    expect(m.means.files).toEqual(['means_l.webp', 'means_u.webp']);
  });
});

describe('SOG bundles', () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const flat = tex([0, 0, 0, 255]);

  /** A bundle whose "images" are labelled stubs, so the decoder can be tracked. */
  function bundle(names: string[], metaJson: unknown) {
    return makeZip([
      { name: 'meta.json', data: bytes(JSON.stringify(metaJson)) },
      ...names.map((n) => ({ name: n, data: bytes(`image:${n}`) })),
    ]);
  }

  const fullMeta = {
    version: 2,
    count: 1,
    means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ['means_l.webp', 'means_u.webp'] },
    scales: { codebook: CODEBOOK, files: ['scales.webp'] },
    quats: { files: ['quats.webp'] },
    sh0: { codebook: CODEBOOK, files: ['sh0.webp'] },
  };
  const NAMES = ['means_l.webp', 'means_u.webp', 'quats.webp', 'scales.webp', 'sh0.webp'];

  it('unpacks a bundle and decodes each texture once, in its right role', async () => {
    const seen: string[] = [];
    const decode = async (b: Uint8Array, mime: string) => {
      expect(mime).toBe('image/webp');
      seen.push(new TextDecoder().decode(b));
      return flat;
    };
    const { meta: m, textures } = await loadSogBundle(bundle(NAMES, fullMeta), decode);
    expect(m.count).toBe(1);
    // In the order the roles are read, and means_l before means_u — the one
    // ordering the format leaves to convention.
    expect(seen).toEqual([
      'image:means_l.webp',
      'image:means_u.webp',
      'image:quats.webp',
      'image:scales.webp',
      'image:sh0.webp',
    ]);
    expect(Object.keys(textures)).toHaveLength(5);
  });

  it('falls back to the role name when the file list is missing', async () => {
    const noFiles = {
      ...fullMeta,
      means: { mins: [0, 0, 0], maxs: [1, 1, 1] },
      scales: { codebook: CODEBOOK },
      quats: {},
      sh0: { codebook: CODEBOOK },
    };
    const seen: string[] = [];
    await loadSogBundle(bundle(NAMES, noFiles), async (b) => {
      seen.push(new TextDecoder().decode(b));
      return flat;
    });
    expect(seen[0]).toBe('image:means_l.webp');
    expect(seen[4]).toBe('image:sh0.webp');
  });

  it('says what is missing rather than decoding nothing', async () => {
    const short = bundle(['means_l.webp', 'means_u.webp'], fullMeta);
    await expect(loadSogBundle(short, async () => flat)).rejects.toThrow(/no “quats.webp” texture/);
  });

  it('rejects a ZIP that is not a SOG bundle at all', async () => {
    const notSog = makeZip([{ name: 'hello.txt', data: bytes('hi') }]);
    await expect(loadSogBundle(notSog, async () => flat)).rejects.toThrow(/no meta.json/);
  });

  it('rejects meta.json that is not JSON', async () => {
    const broken = makeZip([{ name: 'meta.json', data: bytes('{ nope') }]);
    await expect(loadSogBundle(broken, async () => flat)).rejects.toThrow(/not valid JSON/);
  });
});
