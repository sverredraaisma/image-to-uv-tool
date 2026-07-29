// Animated-image input: a GIF / animated WebP / APNG decoded to its frames and
// emitted as one Sequence value, plus the node that pulls a single frame back
// out of a sequence.
//
// The Frames output is meant to be dropped straight onto the Lenticular Print
// node's Frames input: one wire carries the whole animation, and the frame
// shaping here (count, ping-pong, cycles) is what decides how the animation
// reads when you tilt the finished print.

import type { NodeDefinition, RasterImage } from '../types';
import { platform } from '../lib/platform';
import { downscaleToMax } from '../lib/image';
import { isBlobRef } from '../lib/blobStore';
import {
  describeSequence,
  shapeSequence,
  toSequenceValue,
  type FrameSequence,
  type LoopMode,
} from '../lib/sequence';
import { asSequence, bool, num, str } from './helpers';

/**
 * Hard cap on decoded frames. Frames are uncompressed RGBA: 240 frames of
 * 1000×1000 is already ~1 GB, and no lenticular print can resolve more than a
 * few dozen anyway.
 */
export const MAX_DECODED_FRAMES = 240;

export const animationInputNode: NodeDefinition = {
  type: 'animationInput',
  label: 'Animation Input',
  category: 'Input',
  description:
    'Upload an animated GIF, WebP or APNG and output all its frames as one Sequence. ' +
    'Wire Frames straight into a Lenticular Print — the whole animation then plays across the ' +
    'viewing angle and repeats. Frames trims the animation down to what a lenticule can actually ' +
    'resolve (PPI ÷ LPI strips); ping-pong makes tilting back play the motion in reverse instead of ' +
    'snapping. Any plain image node fed a Sequence sees its first frame.',
  autoRun: true,
  inputs: [],
  outputs: [
    { id: 'frames', label: 'Frames', type: 'sequence' },
    { id: 'first', label: 'First frame', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [
    { kind: 'number', key: 'frameCount', label: 'Frames (0 = all)', min: 0, max: 240, step: 1 },
    {
      kind: 'select',
      key: 'loop',
      label: 'Loop',
      options: [
        { value: 'forward', label: 'Forward' },
        { value: 'pingpong', label: 'Ping-pong' },
      ],
    },
    { kind: 'number', key: 'maxSize', label: 'Max size (px, 0 = original)', min: 0, step: 64 },
    { kind: 'number', key: 'cycles', label: 'Cycles per lens', min: 1, max: 8, step: 1, advanced: true },
    { kind: 'boolean', key: 'reverse', label: 'Reverse', advanced: true },
    { kind: 'number', key: 'ppi', label: 'Lenticular check: PPI', min: 1, step: 10, advanced: true },
    { kind: 'number', key: 'lpi', label: 'Lenticular check: LPI', min: 1, step: 1, advanced: true },
  ],
  defaultConfig: () => ({
    src: '',
    srcRef: '',
    name: '',
    // 8 frames fit comfortably under a 45 LPI lens at 1440 PPI (32 strips) and
    // still read as motion.
    frameCount: 8,
    loop: 'forward',
    maxSize: 0,
    cycles: 1,
    reverse: false,
    ppi: 1440,
    lpi: 45,
  }),
  compute: async ({ config, onProgress }) => {
    // Same storage shape as Image Input: inline bytes on legacy graphs,
    // otherwise an out-of-band blob reference.
    let src = str(config.src);
    if (!src && isBlobRef(config.srcRef)) src = (await platform.getBlob(config.srcRef)) ?? '';
    if (!src) return { frames: undefined, first: undefined, info: undefined };

    onProgress?.('Decoding frames…');
    const decoded = await platform.decodeAnimation(src, MAX_DECODED_FRAMES);

    const maxSize = num(config.maxSize, 0);
    const source: FrameSequence = {
      frames: decoded.frames.map((f) => (maxSize > 0 ? downscaleToMax(f.image, maxSize) : f.image)),
      delaysMs: decoded.frames.map((f) => f.delayMs),
    };

    const options = {
      frameCount: Math.max(0, Math.floor(num(config.frameCount, 0))),
      loop: (str(config.loop, 'forward') === 'pingpong' ? 'pingpong' : 'forward') as LoopMode,
      cycles: Math.max(1, Math.floor(num(config.cycles, 1))),
      reverse: bool(config.reverse, false),
    };
    const shaped = shapeSequence(source, options);

    return {
      frames: toSequenceValue(shaped),
      first: shaped.frames[0],
      info: {
        kind: 'text',
        text: describeSequence(
          { width: decoded.width, height: decoded.height, frames: decoded.frames.length },
          shaped,
          { ...options, ppi: num(config.ppi, 0), lpi: num(config.lpi, 0) },
        ),
      },
    };
  },
};

export const frameSelectNode: NodeDefinition = {
  type: 'frameSelect',
  label: 'Sequence Frame',
  category: 'Input',
  description:
    'Pull one frame out of a Sequence as a normal image, so the usual image nodes can work on it. ' +
    'Negative indices count from the end (-1 is the last frame); out-of-range clamps.',
  autoRun: true,
  inputs: [{ id: 'in', label: 'Sequence', type: 'sequence', required: true }],
  outputs: [
    { id: 'out', label: 'Image', type: 'image' },
    { id: 'info', label: 'Info', type: 'text' },
  ],
  configFields: [{ kind: 'number', key: 'index', label: 'Frame index', step: 1 }],
  defaultConfig: () => ({ index: 0 }),
  compute: ({ inputs, config }) => {
    const seq = asSequence(inputs.in);
    if (!seq || seq.frames.length === 0) return { out: undefined, info: undefined };
    const raw = Math.round(num(config.index, 0));
    const index = Math.min(seq.frames.length - 1, Math.max(0, raw < 0 ? seq.frames.length + raw : raw));
    const frame: RasterImage = seq.frames[index];
    return {
      out: frame,
      info: {
        kind: 'text',
        text: `Frame ${index + 1} of ${seq.frames.length} · ${frame.width}×${frame.height} px`,
      },
    };
  },
};

export const animationNodes: NodeDefinition[] = [animationInputNode, frameSelectNode];
