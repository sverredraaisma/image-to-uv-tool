// GIF87a/89a decoder. Pure: takes bytes, returns composited RGBA frames — no
// DOM, no canvas, so it is directly unit-testable and works identically in the
// browser and in Node.
//
// Why our own decoder rather than the browser's: an <img> only ever hands back
// the *current* frame of an animation, and WebCodecs' ImageDecoder (the only
// DOM API that exposes frames) is not available everywhere. GIF is the one
// animated format simple enough to decode by hand, and it is the format people
// actually have lying around, so it gets a first-class path. Everything else
// (animated WebP, APNG) goes through ImageDecoder in lib/canvas.ts.
//
// Frames come out *composited*: each one is a full logical-screen RGBA image
// with the previous frames' disposal already applied, which is what you want to
// interlace into a lenticular print.

import type { RasterImage } from '../types';

export interface AnimationFrame {
  image: RasterImage;
  /** Display duration of this frame in milliseconds. */
  delayMs: number;
}

export interface DecodedAnimation {
  width: number;
  height: number;
  frames: AnimationFrame[];
  /** 0 = loop forever (the usual), n = play n times. Undefined if unstated. */
  loopCount?: number;
}

/** Browsers clamp 0/1-centisecond GIF delays to this; match them. */
const MIN_DELAY_MS = 100;
const DEFAULT_DELAY_MS = 100;

/** Do these bytes start with a GIF signature? */
export function isGif(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 6 &&
    bytes[0] === 0x47 && // G
    bytes[1] === 0x49 && // I
    bytes[2] === 0x46 && // F
    bytes[3] === 0x38 && // 8
    (bytes[4] === 0x37 || bytes[4] === 0x39) && // 7 | 9
    bytes[5] === 0x61 // a
  );
}

/** A cursor over the byte stream that throws rather than reading past the end. */
class Reader {
  constructor(
    private readonly bytes: Uint8Array,
    public pos = 0,
  ) {}

  get done(): boolean {
    return this.pos >= this.bytes.length;
  }

  u8(): number {
    if (this.pos >= this.bytes.length) throw new Error('Truncated GIF (unexpected end of data)');
    return this.bytes[this.pos++];
  }

  u16(): number {
    return this.u8() | (this.u8() << 8);
  }

  skip(n: number): void {
    this.pos += n;
  }

  /** `n` raw bytes. */
  take(n: number): Uint8Array {
    if (this.pos + n > this.bytes.length) throw new Error('Truncated GIF (unexpected end of data)');
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Concatenate a chain of length-prefixed sub-blocks up to the 0 terminator. */
  subBlocks(): Uint8Array {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const size = this.u8();
      if (size === 0) break;
      const part = this.take(size);
      parts.push(part);
      total += part.length;
    }
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  /** Skip a chain of sub-blocks without keeping the bytes. */
  skipSubBlocks(): void {
    for (;;) {
      const size = this.u8();
      if (size === 0) break;
      this.skip(size);
    }
  }
}

/** RGB triplets, 3 bytes per entry. */
function readColorTable(r: Reader, entries: number): Uint8Array {
  return r.take(entries * 3);
}

/**
 * Variable-width LZW as GIF uses it: codes grow from `minCodeSize + 1` bits,
 * with a clear code and an end-of-information code above the literal alphabet.
 * Returns one palette index per pixel.
 */
export function lzwDecode(data: Uint8Array, minCodeSize: number, pixelCount: number): Uint8Array {
  if (minCodeSize < 2 || minCodeSize > 11) throw new Error(`Invalid LZW code size ${minCodeSize}`);
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const out = new Uint8Array(pixelCount);

  // Dictionary as prefix/suffix chains — no per-entry arrays, so no garbage.
  const MAX_CODES = 4096;
  const prefix = new Int32Array(MAX_CODES);
  const suffix = new Uint8Array(MAX_CODES);
  const first = new Uint8Array(MAX_CODES);
  const stack = new Uint8Array(MAX_CODES);

  const reset = () => {
    for (let i = 0; i < clearCode; i++) {
      prefix[i] = -1;
      suffix[i] = i;
      first[i] = i;
    }
    return { next: endCode + 1, width: minCodeSize + 1 };
  };

  let { next, width } = reset();
  let bitBuffer = 0;
  let bitCount = 0;
  let at = 0;
  let outAt = 0;
  let previous = -1;

  while (outAt < pixelCount) {
    while (bitCount < width) {
      if (at >= data.length) return out; // truncated stream: keep what we decoded
      bitBuffer |= data[at++] << bitCount;
      bitCount += 8;
    }
    const code = bitBuffer & ((1 << width) - 1);
    bitBuffer >>= width;
    bitCount -= width;

    if (code === clearCode) {
      ({ next, width } = reset());
      previous = -1;
      continue;
    }
    if (code === endCode) break;

    // The first code after a clear is always a literal, and defines nothing.
    if (previous < 0) {
      if (code >= clearCode) throw new Error('Corrupt GIF LZW stream');
      out[outAt++] = suffix[code];
      previous = code;
      continue;
    }

    let current = code;
    let stackTop = 0;
    // KwKwK: the code refers to the entry this step is about to define, whose
    // string is the previous string plus its own first character.
    if (current >= next) {
      stack[stackTop++] = first[previous];
      current = previous;
    }
    while (current >= clearCode) {
      stack[stackTop++] = suffix[current];
      current = prefix[current];
      if (current < 0 || stackTop >= MAX_CODES) throw new Error('Corrupt GIF LZW stream');
    }
    stack[stackTop++] = suffix[current]; // `current` is now a root literal

    while (stackTop > 0 && outAt < pixelCount) out[outAt++] = stack[--stackTop];

    // New entry: previous string + first character of the one just decoded.
    if (next < MAX_CODES) {
      prefix[next] = previous;
      suffix[next] = suffix[current];
      first[next] = first[previous];
      next++;
      if (next === 1 << width && width < 12) width++;
    }
    previous = code;
  }
  return out;
}

/** Row order of an interlaced GIF frame: the four passes, flattened. */
export function interlacedRows(height: number): number[] {
  const rows: number[] = [];
  for (const [start, step] of [
    [0, 8],
    [4, 8],
    [2, 4],
    [1, 2],
  ]) {
    for (let y = start; y < height; y += step) rows.push(y);
  }
  return rows;
}

interface GraphicControl {
  disposal: number;
  delayMs: number;
  transparentIndex: number;
}

/**
 * Decode every frame of a GIF into full-screen composited RGBA images.
 *
 * @param maxFrames Stop after this many frames (a 500-frame GIF at 1000×1000 is
 *   2 GB of RGBA; the caller decides what it can hold).
 */
export function decodeGif(bytes: Uint8Array, maxFrames = 512): DecodedAnimation {
  if (!isGif(bytes)) throw new Error('Not a GIF file');
  const r = new Reader(bytes, 6);

  const width = r.u16();
  const height = r.u16();
  const packed = r.u8();
  r.u8(); // background colour index — unused: we composite onto transparent
  r.u8(); // pixel aspect ratio
  if (width <= 0 || height <= 0) throw new Error('GIF has no pixels');

  const globalTable = packed & 0x80 ? readColorTable(r, 2 << (packed & 0x07)) : null;

  const frames: AnimationFrame[] = [];
  let loopCount: number | undefined;
  let control: GraphicControl | null = null;

  // The composition canvas, plus a snapshot for disposal method 3.
  const canvas = new Uint8ClampedArray(width * height * 4);
  let previousCanvas: Uint8ClampedArray | null = null;

  while (!r.done && frames.length < maxFrames) {
    const block = r.u8();

    if (block === 0x3b) break; // trailer

    if (block === 0x21) {
      const label = r.u8();
      if (label === 0xf9) {
        const size = r.u8(); // always 4
        const flags = r.u8();
        const delayCs = r.u16();
        const transparentIndex = r.u8();
        if (size > 4) r.skip(size - 4);
        r.u8(); // block terminator
        const delayMs = delayCs * 10;
        control = {
          disposal: (flags >> 2) & 0x07,
          // 0 and 1 centiseconds mean "as fast as possible"; browsers show
          // those at 100 ms, and a print made from them should match what the
          // user saw in their viewer.
          delayMs: delayMs < 20 ? (delayCs === 0 ? DEFAULT_DELAY_MS : MIN_DELAY_MS) : delayMs,
          transparentIndex: flags & 0x01 ? transparentIndex : -1,
        };
      } else if (label === 0xff) {
        const size = r.u8();
        const app = r.take(size);
        const name = String.fromCharCode(...app.subarray(0, 11));
        if (name === 'NETSCAPE2.0') {
          const data = r.subBlocks();
          if (data.length >= 3 && data[0] === 1) loopCount = data[1] | (data[2] << 8);
        } else {
          r.skipSubBlocks();
        }
      } else {
        r.skipSubBlocks();
      }
      continue;
    }

    if (block !== 0x2c) continue; // unknown block: skip the byte and resync

    // --- Image descriptor ---
    const left = r.u16();
    const top = r.u16();
    const fw = r.u16();
    const fh = r.u16();
    const flags = r.u8();
    const localTable = flags & 0x80 ? readColorTable(r, 2 << (flags & 0x07)) : null;
    const interlaced = !!(flags & 0x40);
    const table = localTable ?? globalTable;
    if (!table) throw new Error('GIF frame has no colour table');

    const minCodeSize = r.u8();
    const lzw = r.subBlocks();
    const indices = lzwDecode(lzw, minCodeSize, fw * fh);

    if (control?.disposal === 3) previousCanvas = canvas.slice();

    // --- Paint the frame onto the composition canvas ---
    const transparent = control?.transparentIndex ?? -1;
    const rows = interlaced ? interlacedRows(fh) : null;
    const paletteEntries = table.length / 3;
    for (let row = 0; row < fh; row++) {
      const y = (rows ? rows[row] : row) + top;
      if (y < 0 || y >= height) continue;
      for (let x = 0; x < fw; x++) {
        const px = x + left;
        if (px < 0 || px >= width) continue;
        const index = indices[row * fw + x];
        if (index === transparent) continue; // shows whatever is underneath
        const dst = (y * width + px) * 4;
        if (index < paletteEntries) {
          const src = index * 3;
          canvas[dst] = table[src];
          canvas[dst + 1] = table[src + 1];
          canvas[dst + 2] = table[src + 2];
        } else {
          canvas[dst] = canvas[dst + 1] = canvas[dst + 2] = 0;
        }
        canvas[dst + 3] = 255;
      }
    }

    frames.push({
      image: { kind: 'image', width, height, data: canvas.slice() },
      delayMs: control?.delayMs ?? DEFAULT_DELAY_MS,
    });

    // --- Disposal, applied *after* the frame has been captured ---
    const disposal = control?.disposal ?? 0;
    if (disposal === 2) {
      for (let y = top; y < Math.min(top + fh, height); y++) {
        for (let x = left; x < Math.min(left + fw, width); x++) {
          const dst = (y * width + x) * 4;
          canvas[dst] = canvas[dst + 1] = canvas[dst + 2] = canvas[dst + 3] = 0;
        }
      }
    } else if (disposal === 3 && previousCanvas) {
      canvas.set(previousCanvas);
    }
    control = null; // a GCE applies to exactly one frame
  }

  if (!frames.length) throw new Error('GIF contains no frames');
  return { width, height, frames, loopCount };
}
