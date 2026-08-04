// Named, reusable pipelines saved in the browser. A pipeline is a subgraph plus
// its derived input/output ports; it's stored in its own IndexedDB store
// (memory fallback) so image-heavy inner graphs don't hit localStorage's quota.
//
// Backend-agnostic (inject a BlobBackend) so it's unit-testable without IndexedDB.

import type { BlobBackend } from './blobStore';
import { indexedDbBackend } from './blobStore';
import type { GraphEdge, GraphNode, PortSpec } from '../types';

const PREFIX = 'pipeline:';
const key = (name: string) => PREFIX + name;

export interface SavedPipeline {
  version: 1;
  name: string;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  inputs: PortSpec[];
  outputs: PortSpec[];
}

/** True if `v` has the shape of a saved pipeline (defensive file/JSON import). */
export function isSavedPipeline(v: unknown): v is SavedPipeline {
  const p = v as Partial<SavedPipeline> | null;
  return (
    !!p &&
    typeof p.name === 'string' &&
    !!p.graph &&
    Array.isArray(p.graph.nodes) &&
    Array.isArray(p.graph.edges) &&
    Array.isArray(p.inputs) &&
    Array.isArray(p.outputs)
  );
}

export interface PipelineLibrary {
  save(pipeline: SavedPipeline): Promise<void>;
  load(name: string): Promise<SavedPipeline | null>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

export function createPipelineLibrary(backend: BlobBackend): PipelineLibrary {
  return {
    async save(pipeline) {
      await backend.put(key(pipeline.name), JSON.stringify(pipeline));
    },
    async load(name) {
      const raw = await backend.get(key(name));
      if (typeof raw !== 'string') return null; // text-only store
      try {
        const parsed = JSON.parse(raw);
        return isSavedPipeline(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async list() {
      const keys = await backend.keys();
      return keys
        .filter((k) => k.startsWith(PREFIX))
        .map((k) => k.slice(PREFIX.length))
        .sort();
    },
    async remove(name) {
      await backend.delete(key(name));
    },
  };
}

/** The app-wide pipeline library (a dedicated IndexedDB store; memory fallback). */
export const pipelineLibrary = createPipelineLibrary(
  indexedDbBackend('node-image-tool-pipelines', 'pipelines'),
);
