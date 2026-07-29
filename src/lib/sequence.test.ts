import { describe, it, expect } from 'vitest';
import {
  describeSequence,
  framesPerLenticule,
  pingPong,
  repeatFrames,
  resampleFrames,
  sequenceDuration,
  shapeSequence,
  toSequenceValue,
  type FrameSequence,
} from './sequence';
import { createImage } from './image';

/** n frames, each a 1×1 image whose red channel is its index. */
const seq = (n: number, delay = 100): FrameSequence => ({
  frames: Array.from({ length: n }, (_, i) => createImage(1, 1, [i, 0, 0, 255])),
  delaysMs: Array.from({ length: n }, () => delay),
});

const reds = (frames: { data: Uint8ClampedArray }[]) => frames.map((f) => f.data[0]);

describe('resampleFrames', () => {
  it('spreads picks across the whole loop and always keeps the first', () => {
    expect(resampleFrames([0, 1, 2, 3, 4, 5, 6, 7], 4)).toEqual([0, 2, 4, 6]);
    expect(resampleFrames([0, 1, 2, 3, 4], 2)).toEqual([0, 3]);
    expect(resampleFrames([0, 1, 2], 1)).toEqual([0]);
  });

  it('never invents frames', () => {
    expect(resampleFrames([0, 1, 2], 10)).toEqual([0, 1, 2]);
    expect(resampleFrames([0, 1, 2], 0)).toEqual([0, 1, 2]);
    expect(resampleFrames([], 4)).toEqual([]);
  });
});

describe('pingPong', () => {
  it('reverses without repeating the endpoints, so the loop is seamless', () => {
    expect(pingPong([1, 2, 3, 4])).toEqual([1, 2, 3, 4, 3, 2]);
    expect(pingPong([1, 2])).toEqual([1, 2]);
    expect(pingPong([1])).toEqual([1]);
  });
});

describe('repeatFrames', () => {
  it('repeats the whole run back to back', () => {
    expect(repeatFrames([1, 2], 3)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(repeatFrames([1, 2], 1)).toEqual([1, 2]);
    expect(repeatFrames([1, 2], 0)).toEqual([1, 2]);
  });
});

describe('shapeSequence', () => {
  it('keeps frames and delays in step through every stage', () => {
    const source: FrameSequence = { frames: seq(4).frames, delaysMs: [10, 20, 30, 40] };
    const out = shapeSequence(source, { loop: 'pingpong' });
    expect(reds(out.frames)).toEqual([0, 1, 2, 3, 2, 1]);
    expect(out.delaysMs).toEqual([10, 20, 30, 40, 30, 20]);
  });

  it('resamples, then ping-pongs, then repeats', () => {
    const out = shapeSequence(seq(8), { frameCount: 4, loop: 'pingpong', cycles: 2 });
    expect(reds(out.frames)).toEqual([0, 2, 4, 6, 4, 2, 0, 2, 4, 6, 4, 2]);
  });

  it('reverses before looping', () => {
    const out = shapeSequence(seq(4), { reverse: true });
    expect(reds(out.frames)).toEqual([3, 2, 1, 0]);
  });

  it('passes the sequence through untouched by default', () => {
    const out = shapeSequence(seq(3));
    expect(reds(out.frames)).toEqual([0, 1, 2]);
    expect(out.delaysMs).toEqual([100, 100, 100]);
  });
});

describe('framesPerLenticule', () => {
  it('is the strip budget of one lenticule', () => {
    expect(framesPerLenticule(1440, 45)).toBe(32);
    expect(framesPerLenticule(1440, 45, 2)).toBe(16);
    expect(framesPerLenticule(0, 45)).toBe(0);
  });
});

describe('describeSequence / toSequenceValue', () => {
  it('reports the play time and whether the frames fit under a lens', () => {
    const shaped = shapeSequence(seq(40, 50), { frameCount: 8 });
    const text = describeSequence({ width: 64, height: 64, frames: 40 }, shaped, {
      frameCount: 8,
      ppi: 1440,
      lpi: 45,
    });
    expect(text).toContain('Source: 40 frames at 64×64');
    expect(text).toContain('Output: 8 frames at 1×1');
    expect(text).toContain(`${sequenceDuration(shaped.delaysMs)} ms`);
    expect(text).toContain('fits.');
  });

  it('warns when there are more frames than strips in a lenticule', () => {
    const shaped = shapeSequence(seq(40));
    const text = describeSequence({ width: 8, height: 8, frames: 40 }, shaped, { ppi: 1440, lpi: 45 });
    expect(text).toContain('too many frames');
  });

  it('wraps frames as a port value', () => {
    const value = toSequenceValue(seq(3));
    expect(value.kind).toBe('sequence');
    expect(value.frames).toHaveLength(3);
    expect(value.delaysMs).toEqual([100, 100, 100]);
  });
});
