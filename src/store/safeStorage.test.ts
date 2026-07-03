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
    const s = createSafeStorage(backend, onError);

    expect(() => s.setItem('a', 'x')).not.toThrow();
    expect(() => s.setItem('a', 'y')).not.toThrow();
    expect(s.getItem('a')).toBe(null); // read error swallowed
    expect(onError).toHaveBeenCalledTimes(1); // only the first failure notifies
  });
});
