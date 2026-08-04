import type {
  DataValue,
  RasterImage,
  SequenceValue,
  SplatValue,
  TextValue,
  TransformValue,
} from '../types';

/**
 * Coerce a resolved input to a single image (first if it was a `multiple`).
 * A sequence collapses to its first frame. Most image nodes never see one:
 * `engine/sequenceMap.ts` runs them once per frame instead. This is the
 * fallback for the nodes that opt out of that.
 */
export function asImage(value: DataValue | DataValue[] | undefined): RasterImage | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (v?.kind === 'sequence') return v.frames[0];
  return v && v.kind === 'image' ? v : undefined;
}

/** Coerce a resolved input to an array of images, flattening any sequences. */
export function asImages(value: DataValue | DataValue[] | undefined): RasterImage[] {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  const out: RasterImage[] = [];
  for (const v of arr) {
    if (v.kind === 'image') out.push(v);
    else if (v.kind === 'sequence') out.push(...v.frames);
  }
  return out;
}

/** Coerce a resolved input to a sequence; a lone image becomes one frame. */
export function asSequence(value: DataValue | DataValue[] | undefined): SequenceValue | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  if (v?.kind === 'sequence') return v;
  if (v?.kind === 'image') return { kind: 'sequence', frames: [v] };
  return undefined;
}

/**
 * Coerce a resolved input to a splat cloud. Never copied — a cloud is tens of
 * megabytes of typed array, and every node downstream only reads it.
 */
export function asSplat(value: DataValue | DataValue[] | undefined): SplatValue | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.kind === 'splat' ? v : undefined;
}

/** Coerce a resolved input to a camera placement. */
export function asTransform(value: DataValue | DataValue[] | undefined): TransformValue | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.kind === 'transform' ? v : undefined;
}

export function asText(value: DataValue | DataValue[] | undefined): string | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.kind === 'text' ? (v as TextValue).text : undefined;
}

export function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : parseFloat(String(value));
  return Number.isFinite(n) ? n : fallback;
}

export function str(value: unknown, fallback = ''): string {
  return value == null ? fallback : String(value);
}

export function bool(value: unknown, fallback = false): boolean {
  return typeof value === 'boolean' ? value : fallback;
}
