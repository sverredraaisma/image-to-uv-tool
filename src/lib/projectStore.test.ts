import { describe, it, expect } from 'vitest';
import { createProjectStore } from './projectStore';
import { memoryBackend } from './blobStore';
import type { SavedGraph } from '../types';

const graph = (n: number): SavedGraph => ({
  version: 1,
  nodes: [{ id: `a${n}`, type: 'gradient', position: { x: 0, y: 0 }, config: {} }],
  edges: [],
});

describe('projectStore', () => {
  it('saves, loads, lists and removes named projects', async () => {
    const store = createProjectStore(memoryBackend());
    await store.save('Alpha', graph(1));
    await store.save('Beta', graph(2));
    expect(await store.list()).toEqual(['Alpha', 'Beta']); // sorted

    const loaded = await store.load('Alpha');
    expect(loaded?.nodes[0].id).toBe('a1');

    await store.remove('Alpha');
    expect(await store.list()).toEqual(['Beta']);
    expect(await store.load('Alpha')).toBeNull();
  });

  it('overwrites a project saved under the same name', async () => {
    const store = createProjectStore(memoryBackend());
    await store.save('P', graph(1));
    await store.save('P', graph(9));
    expect((await store.load('P'))?.nodes[0].id).toBe('a9');
    expect(await store.list()).toEqual(['P']);
  });

  it('ignores non-project keys sharing the backend', async () => {
    const map = new Map<string, string>([['blob_x', 'data']]);
    const store = createProjectStore(memoryBackend(map));
    await store.save('P', graph(1));
    expect(await store.list()).toEqual(['P']);
  });
});
