import { describe, it, expect } from 'vitest';
import { contentHash, createBlobStore, isBlobRef, memoryBackend } from './blobStore';

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
