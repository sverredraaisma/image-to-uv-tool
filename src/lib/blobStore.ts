// Content-addressed blob store. Image bytes (data URLs) are large; keeping them
// inside the persisted graph blows past localStorage's ~5 MB quota and taxes
// every JSON.stringify. Instead the graph stores a short content-hash reference
// and the bytes live here (IndexedDB in the browser, a much larger quota).
//
// The store logic is backend-agnostic (inject a BlobBackend) so it is fully
// unit-testable without IndexedDB; the browser wires in `indexedDbBackend()`.

export interface BlobBackend {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  keys(): Promise<string[]>;
  delete(key: string): Promise<void>;
}

const REF_PREFIX = 'blob_';

/** Is this string one of our content-hash references (not raw image bytes)? */
export function isBlobRef(s: unknown): s is string {
  return typeof s === 'string' && s.startsWith(REF_PREFIX);
}

/**
 * Fast 64-bit-ish content hash (two mixed FNV-1a lanes). Not cryptographic —
 * it only needs to be collision-safe enough to de-duplicate identical uploads,
 * and it works everywhere without a secure context (unlike crypto.subtle).
 */
export function contentHash(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  const hex = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  return REF_PREFIX + hex(h1) + hex(h2) + s.length.toString(16);
}

export interface BlobStore {
  /** Store a data URL, returning its content-hash reference (deduped). */
  put(dataUrl: string): Promise<string>;
  /** Resolve a reference back to its data URL (null if unknown). */
  get(ref: string): Promise<string | null>;
  /** Delete every stored blob whose ref is not in `keep`. */
  gc(keep: Iterable<string>): Promise<number>;
}

export function createBlobStore(backend: BlobBackend): BlobStore {
  return {
    async put(dataUrl) {
      const ref = contentHash(dataUrl);
      if ((await backend.get(ref)) == null) await backend.put(ref, dataUrl);
      return ref;
    },
    get(ref) {
      return backend.get(ref);
    },
    async gc(keep) {
      const keepSet = keep instanceof Set ? keep : new Set(keep);
      let removed = 0;
      for (const key of await backend.keys()) {
        if (!keepSet.has(key)) {
          await backend.delete(key);
          removed++;
        }
      }
      return removed;
    },
  };
}

/** In-memory backend — the default fallback and the test double. */
export function memoryBackend(seed?: Map<string, string>): BlobBackend {
  const map = seed ?? new Map<string, string>();
  return {
    get: (k) => Promise.resolve(map.get(k) ?? null),
    put: (k, v) => {
      map.set(k, v);
      return Promise.resolve();
    },
    keys: () => Promise.resolve([...map.keys()]),
    delete: (k) => {
      map.delete(k);
      return Promise.resolve();
    },
  };
}

/** IndexedDB-backed store (browser). Falls back to memory if IDB is missing. */
export function indexedDbBackend(dbName = 'node-image-tool-blobs', storeName = 'blobs'): BlobBackend {
  if (typeof indexedDB === 'undefined') return memoryBackend();

  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const req = indexedDB.open(dbName, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(storeName)) req.result.createObjectStore(storeName);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });

  const tx = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    return new Promise<T>((resolve, reject) => {
      const request = run(db.transaction(storeName, mode).objectStore(storeName));
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  };

  return {
    get: (k) => tx<string | null>('readonly', (s) => s.get(k)).then((v) => v ?? null),
    put: (k, v) => tx('readwrite', (s) => s.put(v, k)).then(() => undefined),
    keys: () => tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).then((ks) => ks.map(String)),
    delete: (k) => tx('readwrite', (s) => s.delete(k)).then(() => undefined),
  };
}
