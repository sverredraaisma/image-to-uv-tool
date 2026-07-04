// A small pool of image-op workers with a job queue. Falls back to running the
// op synchronously (still async signature) when workers aren't available or
// fail to start, so callers can always `await` runImageOp regardless.

import type { NodeConfig, RasterImage } from '../types';
import { runHeavyOp } from './heavyOps';

export type RunImageOp = (name: string, img: RasterImage, config: NodeConfig) => Promise<RasterImage>;

interface Pending {
  resolve: (img: RasterImage) => void;
  reject: (err: Error) => void;
}

export function createImageWorkerPool(size?: number): RunImageOp {
  const runSync: RunImageOp = (name, img, config) => Promise.resolve(runHeavyOp(name, img, config));

  if (typeof Worker === 'undefined') return runSync;

  const count = Math.max(1, size ?? Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1));
  const workers: Worker[] = [];
  const pending = new Map<number, Pending>();
  let nextId = 1;
  let round = 0;

  try {
    for (let i = 0; i < count; i++) {
      const worker = new Worker(new URL('./imageOp.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const { id, width, height, buffer, error } = e.data as {
          id: number;
          width?: number;
          height?: number;
          buffer?: ArrayBuffer;
          error?: string;
        };
        const p = pending.get(id);
        if (!p) return;
        pending.delete(id);
        if (error || !buffer) p.reject(new Error(error ?? 'Worker returned no data'));
        else
          p.resolve({ kind: 'image', width: width!, height: height!, data: new Uint8ClampedArray(buffer) });
      };
      worker.onerror = () => {
        /* individual jobs reject via their own timeout/lifecycle */
      };
      workers.push(worker);
    }
  } catch {
    return runSync; // worker construction blocked (e.g. CSP) — stay synchronous
  }

  return (name, img, config) =>
    new Promise<RasterImage>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      // Transfer a *copy* of the pixels so the caller's source image isn't
      // detached; the worker transfers the result buffer back (zero-copy).
      const copy = new Uint8ClampedArray(img.data);
      const worker = workers[round++ % workers.length];
      try {
        worker.postMessage({ id, name, width: img.width, height: img.height, buffer: copy.buffer, config }, [
          copy.buffer,
        ]);
      } catch (err) {
        pending.delete(id);
        // Fall back to synchronous execution for this job.
        try {
          resolve(runHeavyOp(name, img, config));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(err)));
        }
      }
    });
}
