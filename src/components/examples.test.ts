import { describe, it, expect } from 'vitest';
import '../nodes'; // register built-ins
import { EXAMPLES } from './examples';
import { getNodeDefSafe } from '../engine/registry';
import { nodePorts } from '../engine/ports';
import { sanitizeGraph, type SanitizeOptions } from '../engine/sanitize';
import { isCompatible } from '../engine/compatibility';

const opts: SanitizeOptions = {
  getPorts: (node) => {
    const d = getNodeDefSafe(node.type);
    return d ? nodePorts(node, d) : null;
  },
  isCompatible,
};

describe('empty-state examples', () => {
  it('reference only registered node types', () => {
    for (const ex of EXAMPLES) {
      for (const n of ex.graph.nodes) {
        expect(getNodeDefSafe(n.type), `${ex.name}: unknown type ${n.type}`).toBeTruthy();
      }
    }
  });

  it('survive sanitisation intact (valid edges, no cycles, correct handles/types)', () => {
    for (const ex of EXAMPLES) {
      const { nodes, edges } = sanitizeGraph(ex.graph, opts);
      expect(nodes).toHaveLength(ex.graph.nodes.length);
      expect(edges).toHaveLength(ex.graph.edges.length);
    }
  });
});
