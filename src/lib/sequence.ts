// Frame-sequence shaping: everything between "here are the 47 frames the GIF
// decoder found" and "here are the 8 frames that go under a lenticular lens".
//
// Pure array maths over frames — no pixels are touched, so this is cheap and
// directly unit-testable.
//
// The lenticular constraint is what drives the API: one lenticule is only so
// many printer pixels wide (at 1440 PPI / 45 LPI, 32 of them), and every frame
// needs at least one strip inside it. A 47-frame GIF cannot be printed; a
// resampled 8-frame version of the same motion can. Ping-pong and cycles then
// decide what tilting the print *feels* like: forward-only replays the loop and
// snaps back at the lens edge, ping-pong reverses so the motion never snaps.

import type { RasterImage, SequenceValue } from '../types';

export interface FrameSequence {
  frames: RasterImage[];
  /** Per-frame duration in ms, same length as `frames`. */
  delaysMs: number[];
}

export type LoopMode = 'forward' | 'pingpong';

/** Pick `count` evenly spaced items, always keeping the first. */
export function resampleFrames<T>(items: T[], count: number): T[] {
  if (count <= 0 || items.length === 0) return items.slice();
  if (count >= items.length) return items.slice();
  const out: T[] = [];
  for (let i = 0; i < count; i++) {
    // Spread the picks across the whole loop (i * n / count), not across
    // n-1 — the frame after the last one is frame 0 again.
    out.push(items[Math.min(items.length - 1, Math.round((i * items.length) / count))]);
  }
  return out;
}

/**
 * Append the sequence in reverse, minus both endpoints, so playing the result
 * on a loop never repeats a frame and never jumps: 1 2 3 4 → 1 2 3 4 3 2.
 */
export function pingPong<T>(items: T[]): T[] {
  if (items.length < 3) return items.slice();
  return [...items, ...items.slice(1, -1).reverse()];
}

/** Repeat the whole sequence `cycles` times back to back. */
export function repeatFrames<T>(items: T[], cycles: number): T[] {
  const n = Math.max(1, Math.floor(cycles));
  if (n === 1) return items.slice();
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(...items);
  return out;
}

export interface ShapeOptions {
  /** Keep only this many frames (0 / undefined = all of them). */
  frameCount?: number;
  loop?: LoopMode;
  /** Play the shaped sequence this many times per lenticule. */
  cycles?: number;
  reverse?: boolean;
}

/**
 * Apply the node's frame-shaping config: trim to a frame count, optionally
 * reverse, ping-pong, then repeat. Delays travel with their frames so the
 * on-screen preview matches the timing of the source.
 */
export function shapeSequence(seq: FrameSequence, options: ShapeOptions = {}): FrameSequence {
  // Shape an index list once and apply it to both arrays, so frames and delays
  // can never drift apart.
  let indices = seq.frames.map((_, i) => i);
  if (options.frameCount && options.frameCount > 0) {
    indices = resampleFrames(indices, Math.floor(options.frameCount));
  }
  if (options.reverse) indices = indices.slice().reverse();
  if (options.loop === 'pingpong') indices = pingPong(indices);
  indices = repeatFrames(indices, options.cycles ?? 1);
  return {
    frames: indices.map((i) => seq.frames[i]),
    delaysMs: indices.map((i) => seq.delaysMs[i] ?? 100),
  };
}

/** Total play time of a sequence, in milliseconds. */
export function sequenceDuration(delaysMs: number[]): number {
  return delaysMs.reduce((a, b) => a + b, 0);
}

/** Wrap frames as a port value. */
export function toSequenceValue(seq: FrameSequence): SequenceValue {
  return { kind: 'sequence', frames: seq.frames, delaysMs: seq.delaysMs };
}

/**
 * How many frames fit under one lenticule, i.e. how many the lenticular node
 * can actually resolve at these print settings. Below 2 the print is a still.
 */
export function framesPerLenticule(ppi: number, lpi: number, stripSamples = 1): number {
  if (!(ppi > 0) || !(lpi > 0)) return 0;
  return Math.floor(ppi / lpi / Math.max(1, stripSamples));
}

/** One-line human summary of a sequence, for the Info output. */
export function describeSequence(
  source: { width: number; height: number; frames: number },
  shaped: FrameSequence,
  options: ShapeOptions & { ppi?: number; lpi?: number; stripSamples?: number } = {},
): string {
  const lines = [
    `Source: ${source.frames} frame${source.frames === 1 ? '' : 's'} at ${source.width}×${source.height}`,
    `Output: ${shaped.frames.length} frame${shaped.frames.length === 1 ? '' : 's'} at ` +
      `${shaped.frames[0]?.width ?? 0}×${shaped.frames[0]?.height ?? 0}`,
    `Timing: ${Math.round(sequenceDuration(shaped.delaysMs))} ms per play-through`,
    `Loop: ${options.loop === 'pingpong' ? 'ping-pong (reverses, never snaps back)' : 'forward'}` +
      `${(options.cycles ?? 1) > 1 ? ` × ${options.cycles} cycles per lens` : ''}`,
  ];
  const fit = framesPerLenticule(options.ppi ?? 0, options.lpi ?? 0, options.stripSamples ?? 1);
  if (fit > 0) {
    lines.push(
      `Lenticular: ${fit} frames fit per lenticule at ${options.ppi} PPI / ${options.lpi} LPI` +
        (shaped.frames.length > fit
          ? ` — too many frames, the print will alias. Lower the frame count to ${fit} or below.`
          : ' — fits.'),
    );
  }
  return lines.join('\n');
}
