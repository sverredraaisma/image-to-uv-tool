// Minimal ZIP writer and reader — enough to build and open container formats
// like 3MF and SOG without pulling in a zip dependency.
//
// The writer only ever STOREs. The reader has to do better than that, because
// it opens files other tools wrote: STORED is handled inline, and DEFLATE is
// handed to the platform's own `DecompressionStream`, which is the only reason
// `readZip` is async.

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

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

export function makeZip(entries: ZipEntry[]): Uint8Array<ArrayBuffer> {
  const enc = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = enc.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const local = new Uint8Array(30 + nameBytes.length + size);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // local file header signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, 0, true); // method 0 = stored
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true); // compressed size
    lv.setUint32(22, size, true); // uncompressed size
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(nameBytes, 30);
    local.set(entry.data, 30 + nameBytes.length);
    locals.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); // central dir header signature
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0, true); // flags
    cv.setUint16(10, 0, true); // method
    cv.setUint16(12, 0, true); // mod time
    cv.setUint16(14, 0, true); // mod date
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra len
    cv.setUint16(32, 0, true); // comment len
    cv.setUint16(34, 0, true); // disk number
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);
    centrals.push(central);

    offset += local.length;
  }

  const centralSize = centrals.reduce((s, c) => s + c.length, 0);
  const centralOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true); // end of central dir signature
  ev.setUint16(8, entries.length, true); // entries on this disk
  ev.setUint16(10, entries.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const l of locals) {
    out.set(l, p);
    p += l.length;
  }
  for (const c of centrals) {
    out.set(c, p);
    p += c.length;
  }
  out.set(eocd, p);
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

/** Longest an end-of-central-directory record can be, comment and all. */
const MAX_EOCD = 22 + 0xffff;

/**
 * Find the end-of-central-directory record.
 *
 * It has to be searched for backwards rather than read at a fixed offset,
 * because the record ends with a variable-length comment — so the only way to
 * locate it is to look for its signature from the end of the file, and the only
 * bound on how far back is the comment's own maximum length.
 */
function findEocd(view: DataView, length: number): number {
  const floor = Math.max(0, length - MAX_EOCD);
  for (let at = length - 22; at >= floor; at--) {
    if (view.getUint32(at, true) === EOCD_SIG) return at;
  }
  return -1;
}

/** Inflate a raw DEFLATE member using whatever the platform provides. */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const Ctor = (globalThis as { DecompressionStream?: typeof DecompressionStream }).DecompressionStream;
  if (!Ctor) {
    throw new Error(
      'This archive is DEFLATE-compressed and this browser has no DecompressionStream to unpack it.',
    );
  }
  // Fed from a ReadableStream rather than `new Blob(...).stream()`, and drained
  // by hand rather than through `new Response(...)`: both of those shortcuts
  // are missing from enough environments (jsdom among them) that the portable
  // spelling is worth the extra six lines.
  // Typed as BufferSource because that is what the decompression stream's
  // writable side accepts.
  const source = new ReadableStream<BufferSource>({
    start(controller) {
      controller.enqueue(data as BufferSource);
      controller.close();
    },
  });
  const reader = source.pipeThrough(new Ctor('deflate-raw')).getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value as Uint8Array);
    total += (value as Uint8Array).length;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Read a ZIP archive into its entries, by name.
 *
 * The central directory is the authority on what is in the file — the local
 * headers are a partial duplicate of it, and may lie about sizes when the
 * writer streamed the entry — so names and methods are read from there, and the
 * local header is consulted only to find where each entry's bytes actually
 * start (its name and extra fields can differ in length from the central one).
 */
export async function readZip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEocd(view, bytes.byteLength);
  if (eocd < 0) throw new Error('Not a ZIP archive — no end-of-central-directory record.');

  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  const decoder = new TextDecoder();

  for (let i = 0; i < count; i++) {
    if (at + 46 > bytes.byteLength || view.getUint32(at, true) !== CENTRAL_SIG) {
      throw new Error(`ZIP central directory ends after ${i} of ${count} entries.`);
    }
    const method = view.getUint16(at + 10, true);
    const compressedSize = view.getUint32(at + 20, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLen));

    if (view.getUint32(localAt, true) !== LOCAL_SIG) {
      throw new Error(`ZIP entry “${name}” points at no local header.`);
    }
    // The local header's own name/extra lengths, not the central ones.
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    else throw new Error(`ZIP entry “${name}” uses compression method ${method}, which is not supported.`);

    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
