import type { PortType } from '../types';

// For each input port type, the set of output port types it accepts.
// Masks and images are freely interchangeable (a mask is just a grayscale
// image, and any image can be used as a mask).
const ACCEPTS: Record<PortType, PortType[]> = {
  image: ['image', 'mask'],
  mask: ['mask', 'image'],
  text: ['text'],
  stl: ['stl'],
};

/** Can an output of `outputType` connect into an input of `inputType`? */
export function isCompatible(outputType: PortType, inputType: PortType): boolean {
  return ACCEPTS[inputType]?.includes(outputType) ?? false;
}
