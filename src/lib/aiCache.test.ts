import { describe, it, expect } from 'vitest';
import { aiCacheKey, isCacheable } from './aiCache';

describe('aiCacheKey', () => {
  it('is stable regardless of input key order', () => {
    const a = aiCacheKey('owner/model', { prompt: 'a cat', seed: 7, scale: 4 });
    const b = aiCacheKey('owner/model', { scale: 4, seed: 7, prompt: 'a cat' });
    expect(a).toBe(b);
  });

  it('changes when the model, a value, or the image bytes change', () => {
    const base = aiCacheKey('owner/model', { prompt: 'x', seed: 1 });
    expect(aiCacheKey('owner/other', { prompt: 'x', seed: 1 })).not.toBe(base);
    expect(aiCacheKey('owner/model', { prompt: 'y', seed: 1 })).not.toBe(base);
    expect(aiCacheKey('owner/model', { prompt: 'x', seed: 2 })).not.toBe(base);
    expect(aiCacheKey('owner/model', { prompt: 'x', seed: 1, image: 'data:AAAA' })).not.toBe(base);
  });
});

describe('isCacheable', () => {
  it('caches only deterministic (seeded) runs', () => {
    expect(isCacheable({ prompt: 'x', seed: 5 })).toBe(true);
    expect(isCacheable({ prompt: 'x' })).toBe(false); // random generation stays fresh
  });
});
