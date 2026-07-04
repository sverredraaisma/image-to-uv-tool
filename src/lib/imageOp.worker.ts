// Web Worker: runs a named heavy image op off the main thread. Receives the
// RGBA buffer (transferred), runs the pure op, transfers the result back.

import { runHeavyOp } from './heavyOps';

interface Req {
  id: number;
  name: string;
  width: number;
  height: number;
  buffer: ArrayBuffer;
  config: Record<string, unknown>;
}

self.onmessage = (e: MessageEvent<Req>) => {
  const { id, name, width, height, buffer, config } = e.data;
  try {
    const img = { kind: 'image' as const, width, height, data: new Uint8ClampedArray(buffer) };
    const out = runHeavyOp(name, img, config);
    const outBuf = out.data.buffer as ArrayBuffer;
    (self as unknown as Worker).postMessage({ id, width: out.width, height: out.height, buffer: outBuf }, [
      outBuf,
    ]);
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
