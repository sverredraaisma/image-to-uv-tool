// Wavefront OBJ → the same triangle-soup mesh value STL parses to, but with the
// two things STL cannot carry: texture coordinates and vertex colours.
//
// What is deliberately *not* here is `mtllib`. A .mtl is a second file that
// names a third one for the image, and a browser handed a single uploaded file
// can fetch neither. In a node graph the texture wants to be a wire anyway —
// any image node can feed it, including ones that generate or fetch the map —
// so the mesh brings the UVs and the render node takes the picture separately.
//
// Pure: no DOM. Directly unit-testable.

import type { StlValue } from '../types';
import { MAX_IMPORT_TRIANGLES } from './stl';

/** OBJ indices are 1-based, and negative means "counting back from here". */
function resolveIndex(raw: number, count: number): number {
  return raw < 0 ? count + raw : raw - 1;
}

/**
 * Parse OBJ text. Handles the vertex-colour extension (`v x y z r g b`), any
 * mix of `f v`, `f v/vt`, `f v//vn` and `f v/vt/vn`, and polygons of any size
 * (fanned into triangles). Normals are read past and dropped: winding gives the
 * true face normal, and a stored one is as often wrong as right.
 */
export function parseObj(text: string): StlValue {
  const px: number[] = [];
  const uv: number[] = [];
  const vc: number[] = [];
  // Face corners, as (position, uv) index pairs — uv may be -1.
  const faces: number[][] = [];
  let sawColour = false;
  let maxColour = 0;

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1).trim();

    if (key === 'v') {
      const n = rest.split(/\s+/);
      px.push(parseFloat(n[0]) || 0, parseFloat(n[1]) || 0, parseFloat(n[2]) || 0);
      // The extension: three more numbers on the line are a colour.
      if (n.length >= 6) {
        sawColour = true;
        const c = [parseFloat(n[3]) || 0, parseFloat(n[4]) || 0, parseFloat(n[5]) || 0];
        maxColour = Math.max(maxColour, ...c);
        vc.push(...c);
      } else {
        vc.push(1, 1, 1);
      }
    } else if (key === 'vt') {
      const n = rest.split(/\s+/);
      uv.push(parseFloat(n[0]) || 0, parseFloat(n[1]) || 0);
    } else if (key === 'f') {
      const corners = rest.split(/\s+/).map((part) => {
        const [v, vt] = part.split('/');
        return [
          resolveIndex(parseInt(v, 10), px.length / 3),
          vt ? resolveIndex(parseInt(vt, 10), uv.length / 2) : -1,
        ];
      });
      // Fan from the first corner: correct for any convex polygon, and the
      // concave ones OBJ allows are rare enough to accept the odd artefact.
      for (let i = 2; i < corners.length; i++) {
        faces.push([...corners[0], ...corners[i - 1], ...corners[i]]);
      }
    }
    // mtllib / usemtl / vn / o / g / s: skipped, see the note at the top.
  }

  if (faces.length > MAX_IMPORT_TRIANGLES) {
    throw new Error(
      `Mesh too large: ${faces.length.toLocaleString()} triangles (limit ${MAX_IMPORT_TRIANGLES.toLocaleString()}). Decimate it first.`,
    );
  }

  // Colours are conventionally 0–1 floats, but plenty of tools write 0–255.
  // Nothing declares which, so the only signal is whether anything exceeds 1.
  const colourScale = maxColour > 1.001 ? 1 : 255;
  const count = faces.length;
  const triangles = new Float32Array(count * 9);
  const uvs = new Float32Array(count * 6);
  const colours = new Uint8Array(count * 9);
  let anyUv = false;

  faces.forEach((face, f) => {
    for (let c = 0; c < 3; c++) {
      const vi = face[c * 2];
      const ti = face[c * 2 + 1];
      const at = f * 9 + c * 3;
      if (vi >= 0 && vi * 3 + 2 < px.length) {
        triangles[at] = px[vi * 3];
        triangles[at + 1] = px[vi * 3 + 1];
        triangles[at + 2] = px[vi * 3 + 2];
        // Round rather than let the Uint8Array truncate: 0.5 is 128, not 127.
        colours[at] = Math.round(vc[vi * 3] * colourScale);
        colours[at + 1] = Math.round(vc[vi * 3 + 1] * colourScale);
        colours[at + 2] = Math.round(vc[vi * 3 + 2] * colourScale);
      }
      if (ti >= 0 && ti * 2 + 1 < uv.length) {
        anyUv = true;
        uvs[f * 6 + c * 2] = uv[ti * 2];
        uvs[f * 6 + c * 2 + 1] = uv[ti * 2 + 1];
      }
    }
  });

  return {
    kind: 'stl',
    triangleCount: count,
    triangles,
    ...(anyUv ? { uvs } : {}),
    ...(sawColour ? { colours } : {}),
  };
}
