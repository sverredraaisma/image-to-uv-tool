import { describe, it, expect } from 'vitest';
import { bytesHash, contentHash, createBlobStore, isBlobRef, memoryBackend } from './blobStore';

describe('contentHash / isBlobRef', () => {
  it('is stable and content-addressed', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
    expect(contentHash('hello')).not.toBe(contentHash('world'));
    expect(isBlobRef(contentHash('x'))).toBe(true);
    expect(isBlobRef('data:image/png;base64,AAAA')).toBe(false);
    expect(isBlobRef(undefined)).toBe(false);
  });
});

describe('createBlobStore', () => {
  it('stores and resolves a blob by reference', async () => {
    const store = createBlobStore(memoryBackend());
    const ref = await store.put('data:image/png;base64,AAAA');
    expect(isBlobRef(ref)).toBe(true);
    expect(await store.get(ref)).toBe('data:image/png;base64,AAAA');
    expect(await store.get('blob_missing')).toBe(null);
  });

  it('de-duplicates identical content to the same ref and stores once', async () => {
    const map = new Map<string, string>();
    const store = createBlobStore(memoryBackend(map));
    const a = await store.put('same');
    const b = await store.put('same');
    expect(a).toBe(b);
    expect(map.size).toBe(1);
  });

  it('gc removes blobs whose ref is not kept', async () => {
    const map = new Map<string, string>();
    const store = createBlobStore(memoryBackend(map));
    const keep = await store.put('keep me');
    const drop = await store.put('drop me');
    const removed = await store.gc([keep]);
    expect(removed).toBe(1);
    expect(await store.get(keep)).toBe('keep me');
    expect(await store.get(drop)).toBe(null);
  });
});

describe('raw bytes', () => {
  it('stores and returns bytes without going through base64', async () => {
    const store = createBlobStore(memoryBackend());
    const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const ref = await store.putBytes(bytes);
    expect(isBlobRef(ref)).toBe(true);
    expect([...(await store.getBytes(ref))!]).toEqual([...bytes]);
  });

  it('dedupes identical bytes and separates different ones', async () => {
    const store = createBlobStore(memoryBackend());
    const a = await store.putBytes(new Uint8Array([1, 2, 3, 4, 5]));
    const b = await store.putBytes(new Uint8Array([1, 2, 3, 4, 5]));
    const c = await store.putBytes(new Uint8Array([1, 2, 3, 4, 6]));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it('hashes the tail as well as the whole words', async () => {
    // The fast path reads four bytes at a time; a difference in the leftover
    // bytes has to count too, or a truncated file could collide with a whole one.
    const base = [9, 9, 9, 9, 9, 9];
    for (let i = 0; i < base.length; i++) {
      const changed = [...base];
      changed[i] = 1;
      expect(bytesHash(new Uint8Array(changed))).not.toBe(bytesHash(new Uint8Array(base)));
    }
    // Length is in the hash, so a prefix is never the same reference.
    expect(bytesHash(new Uint8Array([1, 2, 3]))).not.toBe(bytesHash(new Uint8Array([1, 2, 3, 0])));
  });

  it('keeps the two kinds of value apart', async () => {
    // A text store and a byte store share a backend; neither may hand back the
    // other's shape rather than a miss.
    const store = createBlobStore(memoryBackend());
    const textRef = await store.put('data:text/plain;base64,aGk=');
    const byteRef = await store.putBytes(new Uint8Array([1, 2, 3]));
    expect(await store.getBytes(textRef)).toBeNull();
    expect(await store.get(byteRef)).toBeNull();
  });

  it('collects bytes and data URLs alike', async () => {
    const store = createBlobStore(memoryBackend());
    const keep = await store.putBytes(new Uint8Array([1, 2, 3]));
    await store.putBytes(new Uint8Array([4, 5, 6]));
    expect(await store.gc([keep])).toBe(1);
    expect(await store.getBytes(keep)).not.toBeNull();
  });
});
