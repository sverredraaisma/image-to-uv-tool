// Named projects (saved workspaces). Stored in their own IndexedDB object store
// so image-heavy graphs don't hit localStorage's quota. A project holds the
// graph with blob *references* (config.srcRef); the referenced bytes live in the
// shared blob store, so switching projects is cheap and images survive.
//
// Backend-agnostic (inject a BlobBackend) so it's unit-testable without IndexedDB.

import type { BlobBackend } from './blobStore';
import { indexedDbBackend } from './blobStore';
import type { SavedGraph } from '../types';

const PREFIX = 'project:';
const key = (name: string) => PREFIX + name;

export interface ProjectStore {
  save(name: string, graph: SavedGraph): Promise<void>;
  load(name: string): Promise<SavedGraph | null>;
  list(): Promise<string[]>;
  remove(name: string): Promise<void>;
}

export function createProjectStore(backend: BlobBackend): ProjectStore {
  return {
    async save(name, graph) {
      await backend.put(key(name), JSON.stringify(graph));
    },
    async load(name) {
      const raw = await backend.get(key(name));
      if (!raw) return null;
      try {
        return JSON.parse(raw) as SavedGraph;
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

/** The app-wide project store (a dedicated IndexedDB store; memory fallback). */
export const projectStore = createProjectStore(indexedDbBackend('node-image-tool-projects', 'projects'));
