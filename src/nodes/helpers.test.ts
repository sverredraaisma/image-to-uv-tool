import { describe, it, expect } from 'vitest';
import { asImage, asImages, asText, bool, num, str } from './helpers';
import type { RasterImage, TextValue } from '../types';

const img: RasterImage = { kind: 'image', width: 1, height: 1, data: new Uint8ClampedArray(4) };
const txt: TextValue = { kind: 'text', text: 'hi' };

describe('num', () => {
  it('passes numbers through, parses numeric strings, else falls back', () => {
    expect(num(3)).toBe(3);
    expect(num('-1.5')).toBe(-1.5);
    expect(num('')).toBe(0); // empty string -> NaN -> fallback (number fields store strings)
    expect(num('abc', 7)).toBe(7);
    expect(num(null, 9)).toBe(9);
    expect(num(undefined, 9)).toBe(9);
    expect(num(NaN, 5)).toBe(5);
  });
});

describe('str', () => {
  it('stringifies, but null/undefined use the fallback', () => {
    expect(str('x')).toBe('x');
    expect(str(0)).toBe('0');
    expect(str(null, 'def')).toBe('def');
    expect(str(undefined, 'def')).toBe('def');
  });
});

describe('bool', () => {
  it('only accepts real booleans, else falls back', () => {
    expect(bool(true)).toBe(true);
    expect(bool(false, true)).toBe(false);
    expect(bool('true', false)).toBe(false); // string is not a boolean
    expect(bool(undefined, true)).toBe(true);
  });
});

describe('asImage / asImages / asText', () => {
  it('asImage returns an image, unwrapping the first of an array', () => {
    expect(asImage(img)).toBe(img);
    expect(asImage([img, txt])).toBe(img);
    expect(asImage(txt)).toBeUndefined();
    expect(asImage(undefined)).toBeUndefined();
  });
  it('asImages filters to just the images', () => {
    expect(asImages([img, txt, img])).toEqual([img, img]);
    expect(asImages(txt)).toEqual([]);
    expect(asImages(undefined)).toEqual([]);
  });
  it('asText returns text, unwrapping the first of an array', () => {
    expect(asText(txt)).toBe('hi');
    expect(asText([txt, img])).toBe('hi');
    expect(asText(img)).toBeUndefined();
  });
});
