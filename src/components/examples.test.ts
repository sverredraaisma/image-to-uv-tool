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

  it('print at the nodes own default settings, not demo-tuned ones', () => {
    // The defaults are the common UV-flatbed numbers (1440 PPI, 45 LPI, 0.9 mm
    // of varnish at RI 1.5). An example that quietly halved them would teach
    // people the wrong settings. Grid size is the artwork's choice, not the
    // printer's, so a 2×2 spinner may override it; the asset keys carry the
    // upload and have no default.
    const allowedOverrides: Record<string, string[]> = {
      lensGrid: ['grid'],
      animationInput: ['src', 'srcRef', 'name'],
    };
    const problems: string[] = [];
    for (const ex of EXAMPLES) {
      for (const n of ex.graph.nodes) {
        const def = getNodeDefSafe(n.type);
        if (!def || !['lenticular', 'lensGrid', 'animationInput'].includes(n.type)) continue;
        const defaults = def.defaultConfig();
        const allowed = allowedOverrides[n.type] ?? [];
        for (const [key, value] of Object.entries(defaults)) {
          if (allowed.includes(key)) continue;
          if (n.config[key] !== value) {
            problems.push(`${ex.name} · ${n.type}.${key}: ${String(n.config[key])} ≠ ${String(value)}`);
          }
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('address the animation through the deploy base path, not the bundle', async () => {
    // A hardcoded /fireplace-fire.gif 404s on a GitHub Pages project site, and
    // inlining it as a data URL would put ~272 KB in every visitor's download.
    // Re-imported under a subpath base, so a root-absolute path fails here.
    vi.stubEnv('BASE_URL', '/image-to-uv-tool/');
    vi.resetModules();
    try {
      const { EXAMPLES: deployed } = await import('./examples');
      const gif = deployed.flatMap((ex) => ex.graph.nodes).find((n) => n.type === 'animationInput');
      expect(gif?.config.src).toBe('/image-to-uv-tool/fireplace-fire.gif');
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
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
