// Encode a workflow graph into a URL-safe string so it can be shared as a link.
// Image bytes are stripped (topology + settings only) to keep the URL small —
// a shared link is a reusable *workflow template*, not the images.

import type { SavedGraph } from '../types';

function toBase64Url(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(s: string): string {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function stripImages(config: Record<string, unknown>): Record<string, unknown> {
  const c = { ...config };
  if ('src' in c) c.src = '';
  if ('srcRef' in c) c.srcRef = '';
  return c;
}

export function encodeGraphToHash(graph: SavedGraph): string {
  const stripped: SavedGraph = {
    version: graph.version,
    nodes: graph.nodes.map((n) => ({ ...n, config: stripImages(n.config) })),
    edges: graph.edges,
  };
  return toBase64Url(JSON.stringify(stripped));
}

export function decodeGraphFromHash(encoded: string): SavedGraph | null {
  try {
    const parsed = JSON.parse(fromBase64Url(encoded)) as SavedGraph;
    if (!Array.isArray(parsed.nodes) || !Array.isArray(parsed.edges)) return null;
    return parsed;
  } catch {
    return null;
  }
}
