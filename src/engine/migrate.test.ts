import { describe, it, expect } from 'vitest';
import { CURRENT_GRAPH_VERSION, migrateSavedGraph } from './migrate';

describe('migrateSavedGraph', () => {
  it('stamps the current version and passes nodes/edges through', () => {
    const g = migrateSavedGraph({
      nodes: [{ id: 'a', type: 't', position: { x: 0, y: 0 }, config: {} }],
      edges: [{ id: 'e', source: 'a', sourceHandle: 'o', target: 'a', targetHandle: 'i' }],
    });
    expect(g.version).toBe(CURRENT_GRAPH_VERSION);
    expect(g.nodes).toHaveLength(1);
    expect(g.edges).toHaveLength(1);
  });

  it('tolerates a versionless / junk graph', () => {
    expect(migrateSavedGraph(null)).toEqual({ version: CURRENT_GRAPH_VERSION, nodes: [], edges: [] });
    expect(migrateSavedGraph({ nodes: 'nope', edges: 42 })).toEqual({
      version: CURRENT_GRAPH_VERSION,
      nodes: [],
      edges: [],
    });
  });
});
