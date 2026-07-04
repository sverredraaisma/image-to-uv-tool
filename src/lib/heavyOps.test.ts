import { describe, it, expect } from 'vitest';
import { HEAVY_OPS, runHeavyOp } from './heavyOps';
import { boxBlur, createImage, morphology, normalMap, sobel } from './image';

describe('heavyOps', () => {
  const img = createImage(5, 5, [120, 80, 40, 255]);
  img.data.set([255, 255, 255, 255], (2 * 5 + 2) * 4);

  it('runHeavyOp produces the same result as the underlying function', () => {
    expect([...runHeavyOp('blur', img, { radius: 2 }).data]).toEqual([...boxBlur(img, 2).data]);
    expect([...runHeavyOp('edgeDetect', img, {}).data]).toEqual([...sobel(img).data]);
    expect([...runHeavyOp('dilate', img, { radius: 1 }).data]).toEqual([
      ...morphology(img, 1, 'dilate').data,
    ]);
    expect([...runHeavyOp('normalMap', img, { strength: 2 }).data]).toEqual([...normalMap(img, 2).data]);
  });

  it('registers every offloadable op and rejects unknown ones', () => {
    for (const k of [
      'blur',
      'sharpen',
      'dilate',
      'erode',
      'edgeDetect',
      'normalMap',
      'pixelate',
      'vignette',
      'posterize',
      'seamlessTile',
      'rotateAngle',
      'outline',
    ]) {
      expect(typeof HEAVY_OPS[k]).toBe('function');
    }
    expect(() => runHeavyOp('nope', img, {})).toThrow(/Unknown image op/);
  });
});
