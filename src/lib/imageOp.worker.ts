// Web Worker: runs a heavy image op OR builds a heightmap STL off the main
// thread. Receives the RGBA buffer (transferred), runs the pure code, transfers
// the result buffer back.

import { runHeavyOp } from './heavyOps';
import { heightmapToStl, type HeightmapOptions } from './stl';

interface OpReq {
  id: number;
  type?: 'op';
  name: string;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  config: Record<string, unknown>;
}
interface StlReq {
  id: number;
  type: 'stl';
  width: number;
  height: number;
  buffer: ArrayBuffer;
  opts: HeightmapOptions;
}

const post = (msg: unknown, transfer?: Transferable[]) =>
  (self as unknown as Worker).postMessage(msg, transfer ?? []);

self.onmessage = (e: MessageEvent<OpReq | StlReq>) => {
  const msg = e.data;
  try {
    const img = {
      kind: 'image' as const,
      width: msg.width,
      height: msg.height,
      data: new Uint8ClampedArray(msg.buffer),
    };
    if (msg.type === 'stl') {
      const stl = heightmapToStl(img, msg.opts);
      const buf = stl.triangles.buffer as ArrayBuffer;
      post({ id: msg.id, triangleCount: stl.triangleCount, buffer: buf }, [buf]);
    } else {
      const out = runHeavyOp(msg.name, img, msg.config);
      const buf = out.data.buffer as ArrayBuffer;
      post({ id: msg.id, width: out.width, height: out.height, buffer: buf }, [buf]);
    }
  } catch (err) {
    post({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
  }
};
