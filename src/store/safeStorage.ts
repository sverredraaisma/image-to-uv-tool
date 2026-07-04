import type { StateStorage } from 'zustand/middleware';

export interface StorageLike {
  getItem(name: string): string | null;
  setItem(name: string, value: string): void;
  removeItem(name: string): void;
}

export interface SafeStorageOptions {
  /** Fires once, the first time a write is dropped (e.g. quota exceeded). */
  onError?: () => void;
  /**
   * Coalesce rapid writes: a write is deferred this many ms and superseded by
   * later writes, so bursts (e.g. typing in a prompt with a big image embedded)
   * don't re-serialise the whole graph on every keystroke. Flushed on unload.
   */
  debounceMs?: number;
}

/**
 * Wrap a storage backend so quota/security errors never throw (an uncaught
 * QuotaExceededError would abort the state update that triggered the persist)
 * and, optionally, so writes are debounced to avoid megabyte writes per
 * keystroke.
 */
export function createSafeStorage(backend: StorageLike, options: SafeStorageOptions = {}): StateStorage {
  const { onError, debounceMs = 0 } = options;
  let notified = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Keyed by name so a second key's write in the debounce window can't drop the
  // first, and removeItem only cancels its own key's pending write.
  const pending = new Map<string, string>();

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (!pending.size) return;
    const entries = [...pending];
    pending.clear();
    for (const [name, value] of entries) {
      try {
        backend.setItem(name, value);
        // A successful write means storage isn't full right now, so re-arm the
        // notification for a future failure (the user may have freed space).
        notified = false;
      } catch {
        if (!notified) {
          notified = true;
          onError?.();
        }
      }
    }
  };

  if (debounceMs > 0 && typeof window !== 'undefined') {
    window.addEventListener('beforeunload', flush);
  }

  return {
    getItem: (name) => {
      try {
        return backend.getItem(name);
      } catch {
        return null;
      }
    },
    setItem: (name, value) => {
      pending.set(name, value);
      if (debounceMs <= 0) {
        flush();
        return;
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(flush, debounceMs);
    },
    removeItem: (name) => {
      pending.delete(name);
      try {
        backend.removeItem(name);
      } catch {
        /* ignore */
      }
    },
  };
}
