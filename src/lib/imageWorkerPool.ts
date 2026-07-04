// A small pool of workers that run heavy image ops and STL generation off the
// main thread, with a job queue. Falls back to running synchronously (still an
// async signature) when workers aren't available or fail to start, so callers
// can always `await` regardless.

import type { NodeConfig, RasterImage, StlValue } from '../types';
import { runHeavyOp } from './heavyOps';
import { heightmapToStl, type HeightmapOptions } from './stl';

export type RunImageOp = (name: string, img: RasterImage, config: NodeConfig) => Promise<RasterImage>;
export type GenerateStl = (img: RasterImage, opts: HeightmapOptions) => Promise<StlValue>;

export interface ImageWorkerPool {
  runImageOp: RunImageOp;
  generateStl: GenerateStl;
}

interface Pending {
  resolve: (value: RasterImage | StlValue) => void;
  reject: (err: Error) => void;
}

export function createImageWorkerPool(size?: number): ImageWorkerPool {
  const sync: ImageWorkerPool = {
    runImageOp: (name, img, config) => Promise.resolve(runHeavyOp(name, img, config)),
    generateStl: (img, opts) => Promise.resolve(heightmapToStl(img, opts)),
  };

  if (typeof Worker === 'undefined') return sync;

  const count = Math.max(1, size ?? Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1));
  const workers: Worker[] = [];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let round = 0;

  try {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./imageOp.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const { id, width, height, buffer, triangleCount, error } = e.data as {
          id: number;
          width?: number;
          height?: number;
          buffer?: ArrayBuffer;
          triangleCount?: number;
          error?: string;
        };
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (error || !buffer) {
          p.reject(new Error(error ?? 'Worker returned no data'));
        } else if (triangleCount !== undefined) {
          p.resolve({ kind: 'stl', triangleCount, triangles: new Float32Array(buffer) });
        } else {
          p.resolve({ kind: 'image', width: width!, height: height!, data: new Uint8ClampedArray(buffer) });
        }
      };
      workers.push(worker);
    }
  } catch {
    return sync; // worker construction blocked (e.g. CSP) — stay synchronous
  }

  // Transfer a *copy* of the pixels so the caller's source image isn't detached;
  // the worker transfers its result buffer back (zero-copy).
  const dispatch = <T>(message: Record<string, unknown>, syncRun: () => T): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve: resolve as (v: RasterImage | StlValue) => void, reject });
      const worker = workers[round++ % workers.length];
      try {
        worker.postMessage({ id, ...message }, [message.buffer as ArrayBuffer]);
      } catch {
        pending.delete(id);
        try {
          resolve(syncRun());
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }
    });

  return {
    runImageOp: (name, img, config) => {
      const copy = new Uint8ClampedArray(img.data);
      return dispatch(
        { type: 'op', name, width: img.width, height: img.height, buffer: copy.buffer, config },
        () => runHeavyOp(name, img, config),
      );
    },
    generateStl: (img, opts) => {
      const copy = new Uint8ClampedArray(img.data);
      return dispatch({ type: 'stl', width: img.width, height: img.height, buffer: copy.buffer, opts }, () =>
        heightmapToStl(img, opts),
      );
    },
  };
}
