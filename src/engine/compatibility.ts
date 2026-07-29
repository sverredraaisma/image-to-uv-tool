import type { PortType } from '../types';

// For each input port type, the set of output port types it accepts.
// Masks and images are freely interchangeable (a mask is just a grayscale
// image, and any image can be used as a mask).
//
// Sequences are interchangeable with images in both directions: a single image
// is a one-frame sequence, and a sequence plugged into an image input is used
// first-frame-first (multi-image inputs — the lenticular frames — get all of
// them). See `asImage` / `asImages` in nodes/helpers.
const ACCEPTS: Record<PortType, PortType[]> = {
  image: ['image', 'mask', 'sequence'],
  mask: ['mask', 'image', 'sequence'],
  text: ['text'],
  stl: ['stl'],
  sequence: ['sequence', 'image', 'mask'],
};

/** Can an output of `outputType` connect into an input of `inputType`? */
export function isCompatible(outputType: PortType, inputType: PortType): boolean {
  return ACCEPTS[inputType]?.includes(outputType) ?? false;
}
