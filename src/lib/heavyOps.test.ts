import { describe, it, expect } from 'vitest';
import { HEAVY_OPS, runHeavyOp } from './heavyOps';
import { autoThreshold, boxBlur, createImage, despeckle, morphology, normalMap, sobel } from './image';

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
    // New gloss-prep ops route through the same registry with matching params.
    expect([...runHeavyOp('morphology', img, { op: 'close', radius: 1 }).data]).toEqual([
      ...morphology(img, 1, 'close').data,
    ]);
    expect([
      ...runHeavyOp('autoThreshold', img, { mode: 'otsu', percentile: 20, invert: false }).data,
    ]).toEqual([...autoThreshold(img, { mode: 'otsu', percentile: 20, invert: false }).data]);
    expect([...runHeavyOp('despeckle', img, { minArea: 9, minHoleArea: 0, threshold: 128 }).data]).toEqual([
      ...despeckle(img, { minArea: 9, minHoleArea: 0, threshold: 128 }).data,
    ]);
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
      'morphology',
      'highlightExtract',
      'autoThreshold',
      'despeckle',
    ]) {
      expect(typeof HEAVY_OPS[k]).toBe('function');
    }
    expect(() => runHeavyOp('nope', img, {})).toThrow(/Unknown image op/);
  });
});
