import { describe, it, expect } from 'vitest';
import { createPipelineLibrary, isSavedPipeline, type SavedPipeline } from './pipelineLibrary';
import { memoryBackend } from './blobStore';

const sample: SavedPipeline = {
  version: 1,
  name: 'Edge kit',
  graph: {
    nodes: [{ id: 'a', type: 'invert', position: { x: 0, y: 0 }, config: {} }],
    edges: [],
  },
  inputs: [{ id: 'pin', label: 'In', type: 'image' }],
  outputs: [{ id: 'pout', label: 'Out', type: 'image' }],
};

describe('pipeline library', () => {
  it('saves, lists, loads and removes a pipeline', async () => {
    const lib = createPipelineLibrary(memoryBackend());
    expect(await lib.list()).toEqual([]);
    await lib.save(sample);
    expect(await lib.list()).toEqual(['Edge kit']);
    expect(await lib.load('Edge kit')).toEqual(sample);
    await lib.remove('Edge kit');
    expect(await lib.list()).toEqual([]);
    expect(await lib.load('Edge kit')).toBeNull();
  });

  it('rejects corrupt stored data on load', async () => {
    const backend = memoryBackend();
    await backend.put('pipeline:bad', '{ not json');
    const lib = createPipelineLibrary(backend);
    expect(await lib.load('bad')).toBeNull();
  });

  it('isSavedPipeline validates shape', () => {
    expect(isSavedPipeline(sample)).toBe(true);
    expect(isSavedPipeline({ name: 'x' })).toBe(false);
    expect(isSavedPipeline({ name: 'x', graph: { nodes: [], edges: [] }, inputs: [], outputs: [] })).toBe(
      true,
    );
    expect(isSavedPipeline(null)).toBe(false);
  });
});
