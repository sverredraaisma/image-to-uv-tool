import { describe, it, expect } from 'vitest';
import { isCompatible } from './compatibility';

describe('port compatibility', () => {
  it('matches identical types', () => {
    expect(isCompatible('image', 'image')).toBe(true);
    expect(isCompatible('text', 'text')).toBe(true);
    expect(isCompatible('stl', 'stl')).toBe(true);
  });
  it('treats image and mask as interchangeable', () => {
    expect(isCompatible('mask', 'image')).toBe(true);
    expect(isCompatible('image', 'mask')).toBe(true);
  });
  it('rejects incompatible types', () => {
    expect(isCompatible('text', 'image')).toBe(false);
    expect(isCompatible('image', 'text')).toBe(false);
    expect(isCompatible('stl', 'image')).toBe(false);
  });
});
