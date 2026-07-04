// Save-format migration. The persisted/exported graph carries a `version`;
// this upgrades older shapes to the current one before sanitisation. Today only
// v1 exists, so it normalises the version field and is the seam where future
// `if (version < N) { …transform… }` steps go.

import type { SavedGraph } from '../types';

export const CURRENT_GRAPH_VERSION = 1;

export function migrateSavedGraph(raw: unknown): SavedGraph {
  const g = (raw ?? {}) as { version?: unknown; nodes?: unknown; edges?: unknown };
  const version = typeof g.version === 'number' ? g.version : 0;

  // Future migrations, applied in order, e.g.:
  //   if (version < 2) { /* rename a config key, split a node, … */ }
  void version;

  return {
    version: CURRENT_GRAPH_VERSION,
    nodes: Array.isArray(g.nodes) ? (g.nodes as SavedGraph['nodes']) : [],
    edges: Array.isArray(g.edges) ? (g.edges as SavedGraph['edges']) : [],
  };
}
