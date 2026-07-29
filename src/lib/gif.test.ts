import { describe, it, expect } from 'vitest';
import { decodeGif, interlacedRows, isGif, lzwDecode } from './gif';

// --- A minimal GIF writer, so tests can state exactly what bytes to decode ---
//
// It never reuses dictionary entries (every pixel is emitted as a literal
// code), which is legal GIF and keeps the writer trivial — but it has to grow
// the code width on the same schedule a real encoder does, or the decoder would
// read the codes at the wrong width.

function lzwLiterals(indices: number[], minCodeSize: number): number[] {
  const clear = 1 << minCodeSize;
  const end = clear + 1;
  let width = minCodeSize + 1;
  let next = end + 1;
  const out: number[] = [];
  let buffer = 0;
  let bits = 0;
  const emit = (code: number) => {
    buffer |= code << bits;
    bits += width;
    while (bits >= 8) {
      out.push(buffer & 0xff);
      buffer >>= 8;
      bits -= 8;
    }
  };
  emit(clear);
  indices.forEach((px, i) => {
    emit(px);
    if (i > 0) {
      next++;
      if (next === 1 << width && width < 12) width++;
    }
  });
  emit(end);
  if (bits > 0) out.push(buffer & 0xff);
  return out;
}

interface FrameSpec {
  indices: number[];
  width: number;
  height: number;
  left?: number;
  top?: number;
  delayCs?: number;
  disposal?: number;
  transparentIndex?: number;
}

function buildGif(opts: {
  width: number;
  height: number;
  palette: [number, number, number][]; // exactly 4 entries
  frames: FrameSpec[];
}): Uint8Array {
  const b: number[] = [];
  const u16 = (n: number) => b.push(n & 0xff, (n >> 8) & 0xff);
  b.push(...[...'GIF89a'].map((c) => c.charCodeAt(0)));
  u16(opts.width);
  u16(opts.height);
  b.push(0x81, 0, 0); // global table, 4 entries
  for (const [r, g, bl] of opts.palette) b.push(r, g, bl);

  for (const f of opts.frames) {
    b.push(0x21, 0xf9, 0x04);
    b.push(((f.disposal ?? 0) << 2) | (f.transparentIndex === undefined ? 0 : 1));
    u16(f.delayCs ?? 10);
    b.push(f.transparentIndex ?? 0, 0x00);

    b.push(0x2c);
    u16(f.left ?? 0);
    u16(f.top ?? 0);
    u16(f.width);
    u16(f.height);
    b.push(0x00); // no local table, not interlaced
    b.push(2); // LZW minimum code size
    const data = lzwLiterals(f.indices, 2);
    for (let at = 0; at < data.length; at += 255) {
      const chunk = data.slice(at, at + 255);
      b.push(chunk.length, ...chunk);
    }
    b.push(0x00);
  }
  b.push(0x3b);
  return new Uint8Array(b);
}

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const PALETTE: [number, number, number][] = [RED, GREEN, BLUE, [0, 0, 0]];

const pixel = (img: { width: number; data: Uint8ClampedArray }, x: number, y: number) => {
  const at = (y * img.width + x) * 4;
  return [img.data[at], img.data[at + 1], img.data[at + 2], img.data[at + 3]];
};

describe('isGif', () => {
  it('accepts both signatures and rejects anything else', () => {
    expect(isGif(new Uint8Array([...'GIF89a'].map((c) => c.charCodeAt(0))))).toBe(true);
    expect(isGif(new Uint8Array([...'GIF87a'].map((c) => c.charCodeAt(0))))).toBe(true);
    expect(isGif(new Uint8Array([...'PNG   '].map((c) => c.charCodeAt(0))))).toBe(false);
    expect(isGif(new Uint8Array([0x47]))).toBe(false);
  });
});

describe('lzwDecode', () => {
  it('handles the KwKwK case, where a code names the entry being defined', () => {
    // minCodeSize 2 → clear=4, end=5, first free code=6, 3-bit codes.
    // Stream: clear, literal 0, code 6. Code 6 is not in the dictionary yet, so
    // it must decode as "previous string + its own first character" = 0,0.
    const codes = [4, 0, 6];
    let buffer = 0;
    let bits = 0;
    const bytes: number[] = [];
    for (const c of codes) {
      buffer |= c << bits;
      bits += 3;
      while (bits >= 8) {
        bytes.push(buffer & 0xff);
        buffer >>= 8;
        bits -= 8;
      }
    }
    if (bits) bytes.push(buffer & 0xff);
    expect([...lzwDecode(new Uint8Array(bytes), 2, 3)]).toEqual([0, 0, 0]);
  });

  it('rejects a corrupt stream instead of looping', () => {
    // A first code after the clear that is not a literal is malformed.
    expect(() => lzwDecode(new Uint8Array([0x34, 0x00]), 2, 4)).toThrow(/Corrupt/);
  });
});

describe('interlacedRows', () => {
  it('emits the four GIF passes, every row exactly once', () => {
    expect(interlacedRows(8)).toEqual([0, 4, 2, 6, 1, 3, 5, 7]);
    const rows = interlacedRows(13);
    expect(new Set(rows).size).toBe(13);
    expect([...rows].sort((a, b) => a - b)).toEqual([...Array(13).keys()]);
  });
});

describe('decodeGif', () => {
  it('decodes a real-world 1×1 transparent GIF', () => {
    // The canonical transparent spacer GIF — bytes from a real encoder, so this
    // exercises the LZW path against something we did not write ourselves.
    const base64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const gif = decodeGif(bytes);
    expect(gif.width).toBe(1);
    expect(gif.height).toBe(1);
    expect(gif.frames).toHaveLength(1);
    expect(pixel(gif.frames[0].image, 0, 0)[3]).toBe(0); // transparent
  });

  it('decodes every frame with its palette colour and delay', () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: PALETTE,
        frames: [
          { indices: [0, 0, 0, 0], width: 2, height: 2, delayCs: 10 },
          { indices: [1, 1, 1, 1], width: 2, height: 2, delayCs: 5 },
        ],
      }),
    );
    expect(gif.frames).toHaveLength(2);
    expect(pixel(gif.frames[0].image, 1, 1)).toEqual([...RED, 255]);
    expect(pixel(gif.frames[1].image, 0, 0)).toEqual([...GREEN, 255]);
    expect(gif.frames.map((f) => f.delayMs)).toEqual([100, 50]);
  });

  it('composites a partial frame over the one before it', () => {
    // Frame 2 paints a single blue pixel at (1,1); the rest must stay red.
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: PALETTE,
        frames: [
          { indices: [0, 0, 0, 0], width: 2, height: 2, disposal: 1 },
          { indices: [2], width: 1, height: 1, left: 1, top: 1, disposal: 1 },
        ],
      }),
    );
    expect(pixel(gif.frames[1].image, 1, 1)).toEqual([...BLUE, 255]);
    expect(pixel(gif.frames[1].image, 0, 0)).toEqual([...RED, 255]);
  });

  it('leaves the pixels underneath a transparent index untouched', () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: PALETTE,
        frames: [
          { indices: [0, 0, 0, 0], width: 2, height: 2, disposal: 1 },
          { indices: [1, 1, 1, 1], width: 2, height: 2, disposal: 1, transparentIndex: 1 },
        ],
      }),
    );
    expect(pixel(gif.frames[1].image, 0, 0)).toEqual([...RED, 255]);
  });

  it('clears the frame rect when disposal is restore-to-background', () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: PALETTE,
        frames: [
          { indices: [0, 0, 0, 0], width: 2, height: 2, disposal: 2 },
          // A 1×1 frame at the origin: everything else was disposed to
          // transparent, so only (0,0) is opaque.
          { indices: [1], width: 1, height: 1, disposal: 1 },
        ],
      }),
    );
    expect(pixel(gif.frames[1].image, 0, 0)).toEqual([...GREEN, 255]);
    expect(pixel(gif.frames[1].image, 1, 1)[3]).toBe(0);
  });

  it('restores the previous canvas when disposal is restore-to-previous', () => {
    const gif = decodeGif(
      buildGif({
        width: 2,
        height: 2,
        palette: PALETTE,
        frames: [
          { indices: [0, 0, 0, 0], width: 2, height: 2, disposal: 1 },
          { indices: [1, 1, 1, 1], width: 2, height: 2, disposal: 3 },
          { indices: [2], width: 1, height: 1, disposal: 1 },
        ],
      }),
    );
    // Frame 3 paints one blue pixel onto the *restored* frame-1 canvas.
    expect(pixel(gif.frames[2].image, 0, 0)).toEqual([...BLUE, 255]);
    expect(pixel(gif.frames[2].image, 1, 1)).toEqual([...RED, 255]);
  });

  it('honours maxFrames and rejects non-GIF bytes', () => {
    const bytes = buildGif({
      width: 1,
      height: 1,
      palette: PALETTE,
      frames: [
        { indices: [0], width: 1, height: 1 },
        { indices: [1], width: 1, height: 1 },
        { indices: [2], width: 1, height: 1 },
      ],
    });
    expect(decodeGif(bytes, 2).frames).toHaveLength(2);
    expect(() => decodeGif(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))).toThrow(/Not a GIF/);
  });

  it('reads the NETSCAPE loop count', () => {
    const bytes = [...buildGif({ width: 1, height: 1, palette: PALETTE, frames: [] })];
    // Splice the application extension in just before the trailer.
    const app = [
      0x21,
      0xff,
      0x0b,
      ...[...'NETSCAPE2.0'].map((c) => c.charCodeAt(0)),
      0x03,
      0x01,
      0x03,
      0x00,
      0x00,
    ];
    const withLoop = new Uint8Array([
      ...bytes.slice(0, bytes.length - 1),
      ...app,
      // decodeGif throws without at least one frame, so add a 1×1 one.
      0x2c,
      0,
      0,
      0,
      0,
      1,
      0,
      1,
      0,
      0,
      2,
      ...(() => {
        const data = lzwLiterals([0], 2);
        return [data.length, ...data, 0];
      })(),
      0x3b,
    ]);
    expect(decodeGif(withLoop).loopCount).toBe(3);
  });
});
