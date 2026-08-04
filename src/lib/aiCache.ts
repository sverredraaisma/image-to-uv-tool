// Cache of AI node results keyed by a hash of (model, resolved input). Lets an
// unchanged, deterministic run return instantly and for free — and survive a
// reload — instead of re-billing Replicate.
//
// Only *deterministic* runs are cached (those whose input carries a `seed`);
// a random generation stays fresh each run so caching never traps a variation.

import { contentHash, indexedDbBackend, type BlobBackend } from './blobStore';

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const obj = v as Record<string, unknown>;
  return (
    '{' +
    Object.keys(obj)
      .sort()
      .map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k]))
      .join(',') +
    '}'
  );
}

/** Stable content-hash of a model + its input (key order irrelevant). */
export function aiCacheKey(model: string, input: Record<string, unknown>): string {
  return contentHash(model + '|' + stableStringify(input));
}

/** Should this run be cached? Only when the input is deterministic (has a seed). */
export function isCacheable(input: Record<string, unknown>): boolean {
  return 'seed' in input;
}

export interface KeyedStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
}

function keyedStore(backend: BlobBackend): KeyedStore {
  return {
    // These stores only ever hold text; anything else under the key is
    // corrupt, and a miss is the right answer for a cache.
    get: async (k) => {
      const value = await backend.get(k);
      return typeof value === 'string' ? value : null;
    },
    put: (k, v) => backend.put(k, v),
  };
}

/** App-wide AI result cache (its own IndexedDB store; memory fallback). */
export const aiCache: KeyedStore = keyedStore(indexedDbBackend('node-image-tool-aicache', 'aicache'));
