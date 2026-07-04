import { describe, it, expect } from 'vitest';
import { makeZip } from './zip';
import { meshToModelXml, stlToThreeMf } from './threeMf';
import { createImage } from './image';
import { heightmapToStl } from './stl';

const u32 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset).getUint32(off, true);
const u16 = (b: Uint8Array, off: number) => new DataView(b.buffer, b.byteOffset).getUint16(off, true);

describe('makeZip', () => {
  it('writes a structurally valid STORED zip with the right entry count', () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    const zip = makeZip([
      { name: 'a.txt', data: enc('hello') },
      { name: 'b.txt', data: enc('world!') },
    ]);
    expect(u32(zip, 0)).toBe(0x04034b50); // first local file header
    // End-of-central-directory: scan for its signature near the end (no comment).
    const eocdOff = zip.length - 22;
    expect(u32(zip, eocdOff)).toBe(0x06054b50);
    expect(u16(zip, eocdOff + 10)).toBe(2); // total entries
  });
});

describe('3MF export', () => {
  const stl = heightmapToStl(createImage(2, 2, [255, 255, 255, 255]), {
    minWhite: -1,
    baseThickness: 0,
    depthRange: 10,
    width: 4,
  });

  it('de-duplicates vertices and indexes triangles within range', () => {
    const xml = meshToModelXml(stl);
    const vertexCount = (xml.match(/<vertex /g) ?? []).length;
    const triCount = (xml.match(/<triangle /g) ?? []).length;
    expect(triCount).toBe(stl.triangleCount);
    expect(vertexCount).toBeLessThan(stl.triangleCount * 3); // shared corners deduped
    expect(xml).not.toMatch(/NaN/);
    for (const m of xml.matchAll(/v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)) {
      for (let i = 1; i <= 3; i++) expect(Number(m[i])).toBeLessThan(vertexCount);
    }
  });

  it('packages a 3-entry 3MF zip', () => {
    const bytes = stlToThreeMf(stl);
    expect(u32(bytes, 0)).toBe(0x04034b50);
    expect(u16(bytes, bytes.length - 22 + 10)).toBe(3); // [Content_Types], .rels, model
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('3dmodel.model');
  });
});
