import { describe, it, expect } from 'vitest';
// The reference decoder for these tests. @types/node is deliberately not a
// dependency of this browser-only project, so the import has no types here.
// @ts-expect-error untyped node built-in
import { inflateRawSync, inflateSync } from 'node:zlib';
import { deflateFixed, encodeGray16Png, zlibCompress } from './png16';

const inflateRaw = (data: Uint8Array): Uint8Array => new Uint8Array(inflateRawSync(data));
const inflate = (data: Uint8Array): Uint8Array => new Uint8Array(inflateSync(data));

/** Deterministic pseudo-random bytes — no Math.random in a test assertion path. */
function pseudoRandomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  let s = 12345;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (s >>> 16) & 0xff;
  }
  return out;
}

describe('deflateFixed', () => {
  it('round-trips an empty input', () => {
    expect(inflateRaw(deflateFixed(new Uint8Array(0)))).toEqual(new Uint8Array(0));
  });

  it('round-trips short literal-only data', () => {
    const data = Uint8Array.from([97, 98, 99]);
    expect(inflateRaw(deflateFixed(data))).toEqual(data);
  });

  it('round-trips data spanning both fixed literal code lengths (<144 and >=144)', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < 256; i++) data[i] = i;
    expect(inflateRaw(deflateFixed(data))).toEqual(data);
  });

  it('round-trips incompressible data', () => {
    const data = pseudoRandomBytes(20000);
    expect(inflateRaw(deflateFixed(data))).toEqual(data);
  });

  it('round-trips long runs (max-length matches)', () => {
    const data = new Uint8Array(5000).fill(7);
    expect(inflateRaw(deflateFixed(data))).toEqual(data);
  });

  it('round-trips repeated blocks at a long distance', () => {
    const block = pseudoRandomBytes(1000);
    const data = new Uint8Array(40000);
    for (let i = 0; i < data.length; i += block.length) data.set(block, i);
    expect(inflateRaw(deflateFixed(data))).toEqual(data);
    // The whole point of the LZ77 pass: repetition must actually shrink.
    expect(deflateFixed(data).length).toBeLessThan(data.length / 4);
  });

  it('round-trips through the zlib wrapper', () => {
    const data = pseudoRandomBytes(3000);
    expect(inflate(zlibCompress(data))).toEqual(data);
  });

  it('writes a zlib header whose check bits are valid', () => {
    const out = zlibCompress(new Uint8Array([1, 2, 3]));
    expect(out[0]).toBe(0x78);
    expect((out[0] * 256 + out[1]) % 31).toBe(0);
  });
});

describe('encodeGray16Png', () => {
  const samples = Uint16Array.from([0, 1, 65535, 4660, 258, 65280]);
  const png = encodeGray16Png(3, 2, samples);

  it('starts with the PNG signature', () => {
    expect([...png.slice(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('declares 16-bit greyscale in IHDR', () => {
    const view = new DataView(png.buffer, png.byteOffset);
    expect(view.getUint32(8)).toBe(13); // IHDR length
    expect(String.fromCharCode(...png.slice(12, 16))).toBe('IHDR');
    expect(view.getUint32(16)).toBe(3); // width
    expect(view.getUint32(20)).toBe(2); // height
    expect(png[24]).toBe(16); // bit depth
    expect(png[25]).toBe(0); // colour type: greyscale
    expect(png[26]).toBe(0); // deflate
    expect(png[27]).toBe(0); // adaptive filtering
    expect(png[28]).toBe(0); // no interlace
  });

  it('ends with an IEND chunk', () => {
    expect(String.fromCharCode(...png.slice(-8, -4))).toBe('IEND');
  });

  it('stores big-endian samples behind a filter-0 byte per scanline', () => {
    // Locate IDAT: signature (8) + IHDR chunk (12 + 13).
    const start = 8 + 25;
    const view = new DataView(png.buffer, png.byteOffset);
    const length = view.getUint32(start);
    expect(String.fromCharCode(...png.slice(start + 4, start + 8))).toBe('IDAT');
    const raw = inflate(png.slice(start + 8, start + 8 + length));
    expect([...raw]).toEqual([
      0,
      0x00,
      0x00,
      0x00,
      0x01,
      0xff,
      0xff, // row 0: filter 0, then 0, 1, 65535
      0,
      0x12,
      0x34,
      0x01,
      0x02,
      0xff,
      0x00, // row 1: filter 0, then 4660, 258, 65280
    ]);
  });

  it('rejects a sample count that does not match the dimensions', () => {
    expect(() => encodeGray16Png(4, 4, new Uint16Array(15))).toThrow(/expected 16 samples/);
  });

  it('rejects empty dimensions', () => {
    expect(() => encodeGray16Png(0, 4, new Uint16Array(0))).toThrow(/must be >= 1/);
  });

  it('compresses a repetitive lens-like field far below its raw size', () => {
    const width = 512;
    const height = 64;
    const data = new Uint16Array(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) data[y * width + x] = (x % 32) * 2000;
    }
    const out = encodeGray16Png(width, height, data);
    expect(out.length).toBeLessThan(data.byteLength / 10);
  });
});
