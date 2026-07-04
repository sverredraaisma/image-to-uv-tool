// 3MF export: a heightmap mesh packaged as a 3MF (an OPC/ZIP container of XML).
// Vertices are de-duplicated and triangles reference them by index.

import type { StlValue } from '../types';
import { makeZip } from './zip';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>
</Types>`;

const RELS = `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>
</Relationships>`;

/** Build the `3D/3dmodel.model` XML with de-duplicated, indexed geometry. */
export function meshToModelXml(stl: StlValue): string {
  const t = stl.triangles;
  const index = new Map<string, number>();
  const verts: number[] = [];
  const tris: [number, number, number][] = [];
  const vid = (x: number, y: number, z: number): number => {
    const k = `${x},${y},${z}`;
    let i = index.get(k);
    if (i === undefined) {
      i = verts.length / 3;
      index.set(k, i);
      verts.push(x, y, z);
    }
    return i;
  };
  for (let i = 0; i < stl.triangleCount; i++) {
    const b = i * 9;
    tris.push([
      vid(t[b], t[b + 1], t[b + 2]),
      vid(t[b + 3], t[b + 4], t[b + 5]),
      vid(t[b + 6], t[b + 7], t[b + 8]),
    ]);
  }
  const vXml: string[] = [];
  for (let i = 0; i < verts.length; i += 3) {
    vXml.push(`<vertex x="${verts[i]}" y="${verts[i + 1]}" z="${verts[i + 2]}"/>`);
  }
  const tXml = tris.map(([a, b, c]) => `<triangle v1="${a}" v2="${b}" v3="${c}"/>`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">
  <resources>
    <object id="1" type="model">
      <mesh>
        <vertices>${vXml.join('')}</vertices>
        <triangles>${tXml.join('')}</triangles>
      </mesh>
    </object>
  </resources>
  <build><item objectid="1"/></build>
</model>`;
}

export function stlToThreeMf(stl: StlValue): Uint8Array<ArrayBuffer> {
  const enc = (s: string) => new TextEncoder().encode(s);
  return makeZip([
    { name: '[Content_Types].xml', data: enc(CONTENT_TYPES) },
    { name: '_rels/.rels', data: enc(RELS) },
    { name: '3D/3dmodel.model', data: enc(meshToModelXml(stl)) },
  ]);
}
