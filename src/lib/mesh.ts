// Which mesh format did the user just hand us?
//
// The filename usually answers it, but a graph reloaded from a saved file may
// have lost it, so the bytes get a vote too.

import type { StlValue } from '../types';
import { parseObj } from './obj';
import { parseStl } from './stl';

/** Does this look like OBJ text rather than an STL of either flavour? */
function looksLikeObj(bytes: Uint8Array): boolean {
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, 4096));
  // An ASCII STL says so within the first facet; OBJ has vertex or face lines.
  if (/facet\s+normal/i.test(head)) return false;
  return /^\s*(v|vt|vn|f|mtllib|usemtl|o|g)\s/m.test(head);
}

/**
 * Parse an uploaded mesh: OBJ if the name or the bytes say so, otherwise STL
 * (which handles both its own flavours). Throws with a readable message.
 */
export function parseMesh(input: ArrayBuffer | Uint8Array, name = ''): StlValue {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (bytes.length === 0) throw new Error('That file is empty.');

  const named = /\.obj$/i.test(name.trim());
  const mesh =
    named || (!/\.stl$/i.test(name.trim()) && looksLikeObj(bytes))
      ? parseObj(new TextDecoder('utf-8').decode(bytes))
      : parseStl(bytes);
  if (mesh.triangleCount === 0) {
    throw new Error('No triangles found — is that really a mesh file?');
  }
  return mesh;
}
