import { describe, it, expect } from 'vitest';
import { formatRegion, parseRegion } from './region';

describe('region codec', () => {
  it('round-trips a region through text', () => {
    const r = { x: 5, y: 10, width: 40, height: 30 };
    expect(parseRegion(formatRegion(r))).toEqual(r);
  });

  it('rejects non-region / malformed text', () => {
    expect(parseRegion('not json')).toBeNull();
    expect(parseRegion('{"x":1}')).toBeNull(); // missing fields
    expect(parseRegion('{"x":1,"y":2,"width":"3","height":4}')).toBeNull(); // wrong type
    expect(parseRegion('42')).toBeNull();
  });

  it('drops extra keys and keeps only the rectangle', () => {
    const r = parseRegion('{"x":1,"y":2,"width":3,"height":4,"note":"hi"}');
    expect(r).toEqual({ x: 1, y: 2, width: 3, height: 4 });
  });
});
