import { describe, it, expect, vi } from 'vitest';
import { createSafeStorage, type StorageLike } from './safeStorage';

describe('createSafeStorage', () => {
  it('passes reads and writes through to the backend', () => {
    const store = new Map<string, string>();
    const backend: StorageLike = {
      getItem: (k) => store.get(k) ?? null,
      setItem: (k, v) => void store.set(k, v),
      removeItem: (k) => void store.delete(k),
    };
    const s = createSafeStorage(backend);
    s.setItem('a', '1');
    expect(s.getItem('a')).toBe('1');
    s.removeItem('a');
    expect(s.getItem('a')).toBe(null);
  });

  it('swallows write errors and notifies once', () => {
    const backend: StorageLike = {
      getItem: () => {
        throw new Error('read blocked');
      },
      setItem: () => {
        throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    const onError = vi.fn();
    const s = createSafeStorage(backend, { onError });

    expect(() => s.setItem('a', 'x')).not.toThrow();
    expect(() => s.setItem('a', 'y')).not.toThrow();
    expect(s.getItem('a')).toBe(null); // read error swallowed
    expect(onError).toHaveBeenCalledTimes(1); // only the first failure notifies
  });

  it('debounces writes, coalescing a burst into the last value', () => {
    vi.useFakeTimers();
    try {
      const store = new Map<string, string>();
      const backend: StorageLike = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      };
      const s = createSafeStorage(backend, { debounceMs: 300 });
      s.setItem('k', '1');
      s.setItem('k', '2');
      s.setItem('k', '3');
      expect(store.has('k')).toBe(false); // nothing written yet
      vi.advanceTimersByTime(300);
      expect(store.get('k')).toBe('3'); // only the final value is written
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not drop a second key written within the debounce window', () => {
    vi.useFakeTimers();
    try {
      const store = new Map<string, string>();
      const backend: StorageLike = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      };
      const s = createSafeStorage(backend, { debounceMs: 300 });
      s.setItem('a', '1');
      s.setItem('b', '2');
      vi.advanceTimersByTime(300);
      expect(store.get('a')).toBe('1'); // both keys survived the shared window
      expect(store.get('b')).toBe('2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('removeItem only cancels its own key, not another pending write', () => {
    vi.useFakeTimers();
    try {
      const store = new Map<string, string>();
      const backend: StorageLike = {
        getItem: (k) => store.get(k) ?? null,
        setItem: (k, v) => void store.set(k, v),
        removeItem: (k) => void store.delete(k),
      };
      const s = createSafeStorage(backend, { debounceMs: 300 });
      s.setItem('a', '1');
      s.removeItem('b'); // must not cancel the pending write to 'a'
      vi.advanceTimersByTime(300);
      expect(store.get('a')).toBe('1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-notifies on a later failure after a successful write', () => {
    let fail = true;
    const backend: StorageLike = {
      getItem: () => null,
      setItem: () => {
        if (fail) throw new DOMException('quota', 'QuotaExceededError');
      },
      removeItem: () => {},
    };
    const onError = vi.fn();
    const s = createSafeStorage(backend, { onError });
    s.setItem('a', 'x'); // fails -> notify (1)
    fail = false;
    s.setItem('a', 'y'); // succeeds -> re-arm
    fail = true;
    s.setItem('a', 'z'); // fails again -> notify (2)
    expect(onError).toHaveBeenCalledTimes(2);
  });
});
