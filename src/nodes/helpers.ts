import type { DataValue, RasterImage, TextValue } from '../types';

/** Coerce a resolved input to a single image (first if it was a `multiple`). */
export function asImage(value: DataValue | DataValue[] | undefined): RasterImage | undefined {
  const v = Array.isArray(value) ? value[0] : value;
  return v && v.kind === 'image' ? v : undefined;
}

/** Coerce a resolved input to an array of images. */
export function asImages(value: DataValue | DataValue[] | undefined): RasterImage[] {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  return arr.filter((v): v is RasterImage => v.kind === 'image');
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
