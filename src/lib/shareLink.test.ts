import { describe, it, expect } from 'vitest';
import { decodeGraphFromHash, encodeGraphToHash } from './shareLink';
import type { SavedGraph } from '../types';

const graph: SavedGraph = {
  version: 1,
  nodes: [
    { id: 'a', type: 'gradient', position: { x: 1, y: 2 }, config: { width: 256, emoji: '🎨' } },
    {
      id: 'b',
      type: 'imageInput',
      position: { x: 3, y: 4 },
      config: { src: 'data:image/png;base64,HUGE', srcRef: 'blob_x', name: 'pic.png' },
    },
  ],
  edges: [{ id: 'e', source: 'a', sourceHandle: 'out', target: 'b', targetHandle: 'in' }],
};

describe('shareLink', () => {
  it('round-trips the graph topology (URL-safe, unicode-safe)', () => {
    const encoded = encodeGraphToHash(graph);
    expect(encoded).not.toMatch(/[+/=]/); // URL-safe alphabet only
    const back = decodeGraphFromHash(encoded);
    expect(back?.nodes.map((n) => n.id)).toEqual(['a', 'b']);
    expect(back?.edges).toHaveLength(1);
    expect(back?.nodes[0].config.emoji).toBe('🎨'); // unicode survives
  });

  it('strips image bytes so the link stays small', () => {
    const back = decodeGraphFromHash(encodeGraphToHash(graph));
    const img = back?.nodes.find((n) => n.id === 'b');
    expect(img?.config.src).toBe('');
    expect(img?.config.srcRef).toBe('');
    expect(img?.config.name).toBe('pic.png'); // non-image config kept
  });

  it('returns null for garbage', () => {
    expect(decodeGraphFromHash('not-valid-base64!!!')).toBeNull();
    expect(decodeGraphFromHash(btoa('{"nope":1}'))).toBeNull();
  });
});
