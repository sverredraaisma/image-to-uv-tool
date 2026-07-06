import { describe, it, expect } from 'vitest';
import { buildSelection, buildSelectionMask } from './selection';
import { createImage } from './image';

const on = (sel: Uint8Array, w: number, x: number, y: number) => sel[y * w + x] === 1;

describe('buildSelection', () => {
  it('selects a rectangle region', () => {
    const img = createImage(10, 10, [0, 0, 0, 255]);
    const sel = buildSelection(img, {
      points: [],
      tolerance: 0,
      shapes: [{ type: 'rect', x: 2, y: 3, width: 4, height: 2 }],
    });
    expect(on(sel, 10, 3, 3)).toBe(true); // inside
    expect(on(sel, 10, 5, 4)).toBe(true); // inside (last col/row)
    expect(on(sel, 10, 6, 3)).toBe(false); // just outside width
    expect(on(sel, 10, 0, 0)).toBe(false);
  });

  it('selects an ellipse: centre in, corners out', () => {
    const img = createImage(11, 11, [0, 0, 0, 255]);
    const sel = buildSelection(img, {
      points: [],
      tolerance: 0,
      shapes: [{ type: 'ellipse', x: 0, y: 0, width: 11, height: 11 }],
    });
    expect(on(sel, 11, 5, 5)).toBe(true); // centre
    expect(on(sel, 11, 0, 0)).toBe(false); // corner outside the inscribed ellipse
    expect(on(sel, 11, 10, 10)).toBe(false);
  });

  it('normalises a shape dragged up/left (negative size)', () => {
    const img = createImage(10, 10, [0, 0, 0, 255]);
    const sel = buildSelection(img, {
      points: [],
      tolerance: 0,
      shapes: [{ type: 'rect', x: 6, y: 6, width: -4, height: -4 }],
    });
    expect(on(sel, 10, 3, 3)).toBe(true); // covers x∈[2,6), y∈[2,6)
    expect(on(sel, 10, 6, 6)).toBe(false);
  });

  it('unions the magic wand with shapes', () => {
    // Left half white, right half black; wand-seed the white, plus a rect on
    // the black side — the mask should cover both.
    const img = createImage(4, 2, [0, 0, 0, 255]);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 2; x++) img.data.set([255, 255, 255, 255], (y * 4 + x) * 4);
    const sel = buildSelection(img, {
      points: [{ x: 0, y: 0 }],
      tolerance: 10,
      shapes: [{ type: 'rect', x: 3, y: 0, width: 1, height: 2 }],
    });
    expect(on(sel, 4, 0, 0)).toBe(true); // wand-selected white
    expect(on(sel, 4, 3, 0)).toBe(true); // rect-selected black
    expect(on(sel, 4, 2, 0)).toBe(false); // neither
  });

  it('produces an opaque black/white mask image', () => {
    const img = createImage(4, 4, [0, 0, 0, 255]);
    const mask = buildSelectionMask(img, {
      points: [],
      tolerance: 0,
      shapes: [{ type: 'rect', x: 0, y: 0, width: 2, height: 2 }],
    });
    expect(mask.width).toBe(4);
    // (0,0) selected → white, opaque; (3,3) unselected → black, opaque.
    expect([...mask.data.slice(0, 4)]).toEqual([255, 255, 255, 255]);
    const last = (3 * 4 + 3) * 4;
    expect([...mask.data.slice(last, last + 4)]).toEqual([0, 0, 0, 255]);
  });
});
