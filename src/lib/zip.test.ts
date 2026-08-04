// The reader half of zip.ts. The writer is covered through threeMf.test.ts,
// which is what it exists for; this is about opening files other tools wrote.

import { describe, it, expect } from 'vitest';
import { makeZip, readZip } from './zip';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** Build a DEFLATE-compressed single-entry zip, the way real writers do. */
async function deflatedZip(name: string, text: string): Promise<Uint8Array> {
  const raw = enc(text);
  const source = new ReadableStream<BufferSource>({
    start(c) {
      c.enqueue(raw);
      c.close();
    },
  });
  const reader = source.pipeThrough(new CompressionStream('deflate-raw')).getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array);
  }
  const packed = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  parts.reduce((at, p) => (packed.set(p, at), at + p.length), 0);

  // CRC of the *uncompressed* bytes, as the format requires.
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let crc = 0xffffffff;
  for (const b of raw) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const nameBytes = enc(name);
  const local = new Uint8Array(30 + nameBytes.length + packed.length);
  const lv = new DataView(local.buffer);
  lv.setUint32(0, 0x04034b50, true);
  lv.setUint16(4, 20, true);
  lv.setUint16(8, 8, true); // method 8 = deflate
  lv.setUint32(14, crc, true);
  lv.setUint32(18, packed.length, true);
  lv.setUint32(22, raw.length, true);
  lv.setUint16(26, nameBytes.length, true);
  local.set(nameBytes, 30);
  local.set(packed, 30 + nameBytes.length);

  const central = new Uint8Array(46 + nameBytes.length);
  const cv = new DataView(central.buffer);
  cv.setUint32(0, 0x02014b50, true);
  cv.setUint16(10, 8, true); // method
  cv.setUint32(16, crc, true);
  cv.setUint32(20, packed.length, true);
  cv.setUint32(24, raw.length, true);
  cv.setUint16(28, nameBytes.length, true);
  cv.setUint32(42, 0, true); // local header offset
  central.set(nameBytes, 46);

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, 1, true);
  ev.setUint16(10, 1, true);
  ev.setUint32(12, central.length, true);
  ev.setUint32(16, local.length, true);

  const out = new Uint8Array(local.length + central.length + eocd.length);
  out.set(local, 0);
  out.set(central, local.length);
  out.set(eocd, local.length + central.length);
  return out;
}

describe('readZip', () => {
  it('round-trips what makeZip wrote', async () => {
    const zip = makeZip([
      { name: 'meta.json', data: enc('{"version":2}') },
      { name: 'nested/thing.bin', data: new Uint8Array([1, 2, 3, 250]) },
    ]);
    const files = await readZip(zip);
    expect([...files.keys()]).toEqual(['meta.json', 'nested/thing.bin']);
    expect(dec(files.get('meta.json')!)).toBe('{"version":2}');
    expect([...files.get('nested/thing.bin')!]).toEqual([1, 2, 3, 250]);
  });

  it('inflates a DEFLATE entry', async () => {
    // Real writers compress; the SOG bundles this reader exists for mostly do
    // not (WebP is already compressed) but nothing says they must not.
    const text = 'meta '.repeat(200);
    const files = await readZip(await deflatedZip('meta.json', text));
    expect(dec(files.get('meta.json')!)).toBe(text);
  });

  it('finds the directory past a trailing comment', async () => {
    // The end record is variable-length, so it has to be searched for backwards
    // — a fixed offset from the end would miss this.
    const zip = makeZip([{ name: 'a.txt', data: enc('hi') }]);
    const commented = new Uint8Array(zip.length + 5);
    commented.set(zip, 0);
    new DataView(commented.buffer).setUint16(zip.length - 2, 5, true); // comment length
    commented.set(enc('note!'), zip.length);
    const files = await readZip(commented);
    expect(dec(files.get('a.txt')!)).toBe('hi');
  });

  it('reads the data offset from the local header, not the central one', async () => {
    // The two headers carry independent extra-field lengths, and trusting the
    // central one puts the read at the wrong byte.
    const zip = makeZip([{ name: 'a.txt', data: enc('payload') }]);
    const files = await readZip(zip);
    expect(dec(files.get('a.txt')!)).toBe('payload');
  });

  it('refuses what is not a zip', async () => {
    await expect(readZip(enc('ply\nformat binary_little_endian'))).rejects.toThrow(/Not a ZIP archive/);
    await expect(readZip(new Uint8Array(0))).rejects.toThrow(/Not a ZIP archive/);
  });

  it('names the entry it cannot decompress', async () => {
    const zip = makeZip([{ name: 'odd.bin', data: enc('x') }]);
    // Rewrite the method in the central directory to something exotic.
    const eocd = zip.length - 22;
    const centralAt = new DataView(zip.buffer).getUint32(eocd + 16, true);
    new DataView(zip.buffer).setUint16(centralAt + 10, 99, true);
    await expect(readZip(zip)).rejects.toThrow(/“odd.bin” uses compression method 99/);
  });
});
