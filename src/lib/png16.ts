// Minimal 16-bit greyscale PNG encoder.
//
// The browser canvas is 8-bit only, so a depth map destined for a UV printer
// (where one 8-bit step of a 0.9 mm gloss stack is a visible ~3.5 µm terrace)
// has to be written by hand. This produces a spec-compliant
// bit-depth-16 / colour-type-0 PNG, with its own deflate so the output is
// actually small — a lenticular lens array is extremely repetitive, and a
// stored (uncompressed) stream would be ~64 MB where this is a few MB.
//
// Pure: no DOM, no canvas — directly unit-testable (and worker-safe).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  // Chunked so the accumulators can't overflow a double's exact-integer range.
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 4096, data.length);
    for (; i < end; i++) {
      a += data[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---------------------------------------------------------------------------
// Deflate (RFC 1951), fixed-Huffman blocks with a greedy LZ77 matcher.
// ---------------------------------------------------------------------------

const LEN_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195,
  227, 258,
];
const LEN_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097,
  6145, 8193, 12289, 16385, 24577,
];
const DIST_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
];

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
/** Hash-chain positions probed per byte. Small = fast, still catches the
 *  row-to-row and lenticule-to-lenticule repeats that dominate this data. */
const MAX_CHAIN = 24;

/** Deflate bit stream: bits are packed LSB-first, Huffman codes MSB-first. */
class BitWriter {
  private buf = new Uint8Array(1 << 16);
  private len = 0;
  private bits = 0;
  private nbits = 0;

  private ensure(extra: number) {
    if (this.len + extra <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + extra) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.buf.subarray(0, this.len));
    this.buf = next;
  }

  /** Write `count` bits of `value`, least-significant bit first. */
  writeBits(value: number, count: number) {
    this.bits |= (value & ((1 << count) - 1)) << this.nbits;
    this.nbits += count;
    this.ensure(4);
    while (this.nbits >= 8) {
      this.buf[this.len++] = this.bits & 0xff;
      this.bits >>>= 8;
      this.nbits -= 8;
    }
  }

  /** Write a Huffman code, which is transmitted most-significant bit first. */
  writeCode(code: number, count: number) {
    let reversed = 0;
    for (let i = 0; i < count; i++) reversed |= ((code >>> (count - 1 - i)) & 1) << i;
    this.writeBits(reversed, count);
  }

  finish(): Uint8Array {
    if (this.nbits > 0) {
      this.ensure(1);
      this.buf[this.len++] = this.bits & 0xff;
      this.bits = 0;
      this.nbits = 0;
    }
    return this.buf.subarray(0, this.len);
  }
}

/** Emit a literal byte using the fixed literal/length code table. */
function writeLiteral(w: BitWriter, byte: number) {
  if (byte < 144) w.writeCode(0x30 + byte, 8);
  else w.writeCode(0x190 + byte - 144, 9);
}

function writeLengthDistance(w: BitWriter, length: number, distance: number) {
  let li = LEN_BASE.length - 1;
  while (LEN_BASE[li] > length) li--;
  const symbol = 257 + li;
  // 257–279 are 7-bit codes, 280–287 are 8-bit codes.
  if (symbol < 280) w.writeCode(symbol - 256, 7);
  else w.writeCode(0xc0 + symbol - 280, 8);
  w.writeBits(length - LEN_BASE[li], LEN_EXTRA[li]);

  let di = DIST_BASE.length - 1;
  while (DIST_BASE[di] > distance) di--;
  w.writeCode(di, 5); // fixed distance codes are 5 bits
  w.writeBits(distance - DIST_BASE[di], DIST_EXTRA[di]);
}

/** Raw DEFLATE stream (single fixed-Huffman block) of `data`. */
export function deflateFixed(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  w.writeBits(1, 1); // BFINAL
  w.writeBits(1, 2); // BTYPE = 01, fixed Huffman

  const n = data.length;
  const head = new Int32Array(1 << 15).fill(-1);
  const prev = new Int32Array(n < 1 ? 1 : n).fill(-1);
  const hash = (i: number) => ((data[i] << 10) ^ (data[i + 1] << 5) ^ data[i + 2]) & 0x7fff;

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const h = hash(i);
      let candidate = head[h];
      let chain = MAX_CHAIN;
      const limit = i - WINDOW;
      while (candidate >= 0 && candidate > limit && chain-- > 0) {
        let len = 0;
        const max = Math.min(MAX_MATCH, n - i);
        while (len < max && data[candidate + len] === data[i + len]) len++;
        if (len > bestLen) {
          bestLen = len;
          bestDist = i - candidate;
          if (len >= max) break;
        }
        candidate = prev[candidate];
      }
      prev[i] = head[h];
      head[h] = i;
    }

    if (bestLen >= MIN_MATCH) {
      writeLengthDistance(w, bestLen, bestDist);
      // Keep the hash chains populated across the skipped bytes, otherwise long
      // runs lose every future match anchor.
      for (let k = 1; k < bestLen; k++) {
        const j = i + k;
        if (j + MIN_MATCH > n) break;
        const h = hash(j);
        prev[j] = head[h];
        head[h] = j;
      }
      i += bestLen;
    } else {
      writeLiteral(w, data[i]);
      i++;
    }
  }

  w.writeCode(0, 7); // end-of-block (symbol 256)
  return w.finish();
}

/** zlib (RFC 1950) wrapper around {@link deflateFixed}. */
export function zlibCompress(data: Uint8Array): Uint8Array {
  const body = deflateFixed(data);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; // CMF: deflate, 32K window
  out[1] = 0x01; // FLG: no dict, (0x7801 % 31 === 0)
  out.set(body, 2);
  const sum = adler32(data);
  const tail = 2 + body.length;
  out[tail] = (sum >>> 24) & 0xff;
  out[tail + 1] = (sum >>> 16) & 0xff;
  out[tail + 2] = (sum >>> 8) & 0xff;
  out[tail + 3] = sum & 0xff;
  return out;
}

// ---------------------------------------------------------------------------
// PNG container
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function chunk(type: string, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, body.length, false);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)), false);
  return out;
}

/**
 * Encode a 16-bit greyscale PNG. `samples` is row-major, one value per pixel,
 * 0 = lowest, 65535 = highest.
 */
export function encodeGray16Png(width: number, height: number, samples: Uint16Array): Uint8Array {
  if (width < 1 || height < 1) throw new Error('encodeGray16Png: width and height must be >= 1');
  if (samples.length !== width * height) {
    throw new Error(`encodeGray16Png: expected ${width * height} samples, got ${samples.length}`);
  }

  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, width, false);
  iv.setUint32(4, height, false);
  ihdr[8] = 16; // bit depth
  ihdr[9] = 0; // colour type 0 = greyscale
  ihdr[10] = 0; // compression: deflate
  ihdr[11] = 0; // filter method 0
  ihdr[12] = 0; // no interlace

  // Filter type 0 (None) per scanline: the deflate pass above already turns the
  // repeated lens rows into long matches, so a predictor buys little here.
  const rowBytes = width * 2;
  const raw = new Uint8Array(height * (rowBytes + 1));
  for (let y = 0; y < height; y++) {
    const dst = y * (rowBytes + 1);
    raw[dst] = 0;
    const src = y * width;
    for (let x = 0; x < width; x++) {
      const v = samples[src + x];
      raw[dst + 1 + x * 2] = (v >>> 8) & 0xff;
      raw[dst + 2 + x * 2] = v & 0xff;
    }
  }

  const parts = [
    Uint8Array.from(PNG_SIGNATURE),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibCompress(raw)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
