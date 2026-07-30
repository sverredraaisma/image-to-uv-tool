import { describe, it, expect } from 'vitest';
import { parseObj } from './obj';
import { parseMesh } from './mesh';
import { stlToBinary } from './stl';
import type { StlValue } from '../types';

const TRI = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';

describe('parseObj', () => {
  it('reads positions and faces', () => {
    const m = parseObj(TRI);
    expect(m.triangleCount).toBe(1);
    expect([...m.triangles]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect(m.uvs).toBeUndefined();
    expect(m.colours).toBeUndefined();
  });

  it('fans a polygon into triangles', () => {
    // A quad is two triangles; a pentagon is three.
    const quad = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1 2 3 4\n');
    expect(quad.triangleCount).toBe(2);
    // Both fan from the first corner, so they share it and meet on the diagonal.
    expect([...quad.triangles.slice(0, 3)]).toEqual([0, 0, 0]);
    expect([...quad.triangles.slice(9, 12)]).toEqual([0, 0, 0]);
    expect(parseObj('v 0 0 0\nv 1 0 0\nv 2 1 0\nv 1 2 0\nv 0 2 0\nf 1 2 3 4 5\n').triangleCount).toBe(3);
  });

  it('accepts every face syntax, and negative indices', () => {
    const uv = 'vt 0 0\nvt 1 0\nvt 0 1\n';
    const vs = 'v 0 0 0\nv 1 0 0\nv 0 1 0\n';
    const plain = parseObj(vs + 'f 1 2 3\n');
    for (const f of ['f 1/1 2/2 3/3', 'f 1//1 2//2 3//3', 'f 1/1/1 2/2/2 3/3/3', 'f -3 -2 -1']) {
      const m = parseObj(vs + uv + f + '\n');
      expect(m.triangleCount).toBe(1);
      expect(m.triangles).toEqual(plain.triangles);
    }
    // …and the ones that name texture coordinates actually pick them up.
    expect([...parseObj(vs + uv + 'f 1/1 2/2 3/3\n').uvs!]).toEqual([0, 0, 1, 0, 0, 1]);
    expect(parseObj(vs + uv + 'f 1//1 2//2 3//3\n').uvs).toBeUndefined(); // those are normals
  });

  it('reads vertex colours, in either convention', () => {
    // 0–1 floats, which is what most exporters write…
    const unit = parseObj('v 0 0 0 1 0.5 0\nv 1 0 0 1 0.5 0\nv 0 1 0 1 0.5 0\nf 1 2 3\n');
    expect([...unit.colours!.slice(0, 3)]).toEqual([255, 128, 0]);
    // …and 0–255, which some do. Nothing declares which; only the values tell.
    const bytes = parseObj('v 0 0 0 255 128 0\nv 1 0 0 255 128 0\nv 0 1 0 255 128 0\nf 1 2 3\n');
    expect([...bytes.colours!.slice(0, 3)]).toEqual([255, 128, 0]);
  });

  it('gives every corner of a face its own colour, so faces can be flat', () => {
    const m = parseObj('v 0 0 0 1 0 0\nv 1 0 0 1 0 0\nv 0 1 0 0 0 1\nf 1 2 3\n');
    expect([...m.colours!]).toEqual([255, 0, 0, 255, 0, 0, 0, 0, 255]);
  });

  it('ignores comments, blank lines, normals and material directives', () => {
    const m = parseObj(
      '# a comment\n\nmtllib thing.mtl\nusemtl red\no cube\ng part\ns off\nvn 0 0 1\n' + TRI,
    );
    expect(m.triangleCount).toBe(1);
    expect([...m.triangles]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });

  it('survives a file with no faces at all', () => {
    expect(parseObj('v 0 0 0\nv 1 0 0\n').triangleCount).toBe(0);
  });
});

describe('parseMesh', () => {
  const stl: StlValue = {
    kind: 'stl',
    triangleCount: 1,
    triangles: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  };
  const bytes = (s: string) => new TextEncoder().encode(s);

  it('picks the format off the filename', () => {
    expect(parseMesh(bytes(TRI), 'cube.obj').triangleCount).toBe(1);
    expect(parseMesh(stlToBinary(stl), 'cube.stl').triangleCount).toBe(1);
    expect(parseMesh(stlToBinary(stl), 'CUBE.STL').triangleCount).toBe(1);
  });

  it('sniffs the bytes when the name is unhelpful, as a reloaded graph’s may be', () => {
    expect(parseMesh(bytes(TRI)).triangleCount).toBe(1); // OBJ by its v/f lines
    expect(parseMesh(stlToBinary(stl)).triangleCount).toBe(1); // binary STL
    // An ASCII STL has "facet normal", which OBJ never does.
    expect(
      parseMesh(
        bytes(
          'solid x\nfacet normal 0 0 1\nouter loop\nvertex 0 0 0\nvertex 1 0 0\nvertex 0 1 0\nendloop\nendfacet\nendsolid x\n',
        ),
      ).triangleCount,
    ).toBe(1);
  });

  it('refuses an empty or meshless file', () => {
    expect(() => parseMesh(new Uint8Array(0))).toThrow(/empty/i);
    expect(() => parseMesh(bytes('# nothing but a comment\n'), 'x.obj')).toThrow(/no triangles/i);
  });
});
