import type { StateStorage } from 'zustand/middleware';

export interface StorageLike {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

/**
 * Wrap a storage backend so quota/security errors never throw — an uncaught
 * QuotaExceededError (e.g. a large embedded image blowing the ~5 MB budget)
 * would otherwise abort the state update that triggered the persist. `onError`
 * fires once, the first time a write is dropped, so the app can warn the user.
 */
export function createSafeStorage(backend: StorageLike, onError?: () => void): StateStorage {
  let notified = false;
  return {
    getItem: (name) => {
      try {
        return backend.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      try {
        backend.setItem(name, value);
      } catch {
        if (!notified) {
          notified = true;
          onError?.();
        }
      }
    },
    removeItem: (name) => {
      try {
        backend.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}
