// Driving a chunked render from a node, an editor, or anywhere else that has a
// user waiting.
//
// The renderers in `lenticular.ts` come in two forms: a plain function that
// returns the finished raster, and a generator that yields after every band of
// rows. The plain one is right for tests and for anything small. This is the
// other caller: it runs the generator to the end, but hands the event loop back
// between chunks so the progress bar paints, a Cancel is noticed, and the tab
// stays alive through a render that takes a minute.
//
// The gap between chunks is where all of that happens, and it is the only
// reason this is async at all — the work itself is as synchronous as it ever
// was.

/** Progress of a chunked job: `done` of `total` chunks, and what is being built. */
export interface ChunkProgress {
  done: number;
  total: number;
  /** Which pass this is — 'Interlaced artwork', 'Depth map', 'Views'… */
  what: string;
}

export interface ChunkedRunOptions {
  /** Called after every chunk, with a 0–1 fraction of the whole job. */
  onProgress?: (message: string, fraction?: number) => void;
  /** Aborts between chunks — a chunk itself is not interruptible. */
  signal?: AbortSignal;
}

/**
 * Hand the event loop back, so the browser can paint and a click can land.
 *
 * It has to be a *macrotask*: awaiting a resolved promise only drains the
 * microtask queue, which happens without rendering anything. Which macrotask
 * matters more than it looks — `setTimeout(0)` is clamped to 4 ms once nested,
 * and 4 ms × 225 views is a second of the run spent waiting on a timer. So:
 * `scheduler.yield()` where it exists, a MessageChannel task (a macrotask with
 * no clamp) where it does not, and `setTimeout` only as a last resort.
 */
let channel: MessageChannel | null = null;
const waiting: (() => void)[] = [];

export function yieldToUi(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler?.yield) return scheduler.yield();
  if (typeof MessageChannel === 'undefined') {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = () => waiting.shift()?.();
    channel.port1.start?.();
  }
  return new Promise((resolve) => {
    waiting.push(resolve);
    channel!.port2.postMessage(0);
  });
}

/** Human-readable progress for one chunk: what is being built, and how far in. */
export const chunkMessage = (p: ChunkProgress): string => `${p.what} — chunk ${p.done} of ${p.total}`;

/**
 * Run a chunked render to completion, reporting progress and yielding to the UI
 * between chunks.
 *
 * Aborting throws the same `AbortError` the rest of the app uses, so a cancelled
 * render lands in the store's existing cancel path rather than as an error. The
 * generator is closed on the way out, which runs its `finally` blocks and lets
 * the half-built raster be collected.
 */
export async function runChunked<T>(
  gen: Generator<ChunkProgress, T>,
  { onProgress, signal }: ChunkedRunOptions = {},
): Promise<T> {
  try {
    // Before the first chunk as well as between them: the caller has just set a
    // "running" state and nothing has painted it yet, and the first chunk is
    // still millions of pixels of blocking work.
    await yieldToUi();
    for (;;) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const step = gen.next();
      if (step.done) return step.value;
      const { done, total } = step.value;
      onProgress?.(chunkMessage(step.value), total > 0 ? done / total : undefined);
      // Only the last chunk of a one-chunk render has nothing to wait for, and
      // paying one macrotask for it is cheaper than deciding not to.
      await yieldToUi();
    }
  } finally {
    gen.return?.(undefined as T);
  }
}
