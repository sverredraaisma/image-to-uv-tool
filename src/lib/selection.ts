// Composite selection: union of magic-wand seeds, rectangles and ellipses into
// a single black/white mask. Pure and testable (no canvas).

import type { RasterImage } from '../types';
import { createImage } from './image';
import { selectRegion, type Point } from './magicWand';

export interface RectShape {
  type: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface EllipseShape {
  type: 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
}
export type SelectionShape = RectShape | EllipseShape;

export interface SelectionSpec {
  /** Magic-wand seed points (flood-filled within `tolerance`). */
  points: Point[];
  tolerance: number;
  /** Rectangle / ellipse regions, unioned with the wand selection. */
  shapes: SelectionShape[];
}

/** Normalise a shape so width/height are positive (handles a drag up/left). */
function normalize(s: SelectionShape): SelectionShape {
  const x = s.width < 0 ? s.x + s.width : s.x;
  const y = s.height < 0 ? s.y + s.height : s.y;
  return { type: s.type, x, y, width: Math.abs(s.width), height: Math.abs(s.height) };
}

/** OR a shape into an existing selection buffer (length w*h). */
function paintShape(sel: Uint8Array, w: number, h: number, shape: SelectionShape): void {
  const s = normalize(shape);
  const x0 = Math.max(0, Math.floor(s.x));
  const y0 = Math.max(0, Math.floor(s.y));
  const x1 = Math.min(w, Math.ceil(s.x + s.width));
  const y1 = Math.min(h, Math.ceil(s.y + s.height));
  if (s.type === 'rect') {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sel[y * w + x] = 1;
    return;
  }
  // Ellipse inscribed in the (normalised) bounding box.
  const rx = s.width / 2;
  const ry = s.height / 2;
  if (rx <= 0 || ry <= 0) return;
  const cx = s.x + rx;
  const cy = s.y + ry;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const dx = (x + 0.5 - cx) / rx;
      const dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) sel[y * w + x] = 1;
    }
  }
}

/** Build the combined boolean selection (length w*h) from wand + shapes. */
export function buildSelection(img: RasterImage, spec: SelectionSpec): Uint8Array {
  const { width: w, height: h } = img;
  const sel = new Uint8Array(w * h);
  if (spec.points.length) {
    const wand = selectRegion(img, spec.points, spec.tolerance);
    for (let i = 0; i < sel.length; i++) if (wand[i]) sel[i] = 1;
  }
  for (const shape of spec.shapes) paintShape(sel, w, h, shape);
  return sel;
}

/** Opaque black/white mask image from the combined selection. */
export function buildSelectionMask(img: RasterImage, spec: SelectionSpec): RasterImage {
  const sel = buildSelection(img, spec);
  const out = createImage(img.width, img.height, [0, 0, 0, 255]);
  for (let p = 0; p < sel.length; p++) {
    if (sel[p]) {
      out.data[p * 4] = 255;
      out.data[p * 4 + 1] = 255;
      out.data[p * 4 + 2] = 255;
    }
  }
  return out;
}
