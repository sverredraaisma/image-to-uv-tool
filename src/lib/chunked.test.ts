import { describe, it, expect, vi } from 'vitest';
import { runChunked, chunkMessage } from './chunked';
import type { ChunkProgress } from './lenticular';

/** A stand-in render: `total` chunks that each note they ran. */
function* fakeRender(total: number, ran: number[] = []): Generator<ChunkProgress, string> {
  for (let done = 1; done <= total; done++) {
    ran.push(done);
    yield { done, total, what: 'Depth map' };
  }
  return 'finished';
}

describe('runChunked', () => {
  it('runs every chunk and returns what the render returned', async () => {
    const ran: number[] = [];
    await expect(runChunked(fakeRender(4, ran))).resolves.toBe('finished');
    expect(ran).toEqual([1, 2, 3, 4]);
  });

  it('reports each chunk with a fraction that reaches 1', async () => {
    const seen: [string, number | undefined][] = [];
    await runChunked(fakeRender(4), { onProgress: (m, f) => seen.push([m, f]) });
    expect(seen.map(([, f]) => f)).toEqual([0.25, 0.5, 0.75, 1]);
    expect(seen[0][0]).toBe('Depth map — chunk 1 of 4');
    expect(chunkMessage({ done: 2, total: 9, what: 'Interlaced artwork' })).toBe(
      'Interlaced artwork — chunk 2 of 9',
    );
  });

  it('hands the event loop back around every chunk', async () => {
    // Two renders started together interleave chunk for chunk. If the driver
    // ran a generator to the end without yielding, the log would be aaabbb —
    // and nothing else (a paint, a progress update, a click on Cancel) would
    // get a look in either.
    const order: string[] = [];
    const tagged = function* (tag: string): Generator<ChunkProgress, string> {
      for (let done = 1; done <= 3; done++) {
        order.push(tag);
        yield { done, total: 3, what: 'Views' };
      }
      return tag;
    };
    await Promise.all([runChunked(tagged('a')), runChunked(tagged('b'))]);
    expect(order.join('')).not.toBe('aaabbb');
    expect(order.filter((t) => t === 'a')).toHaveLength(3);
    expect(order.filter((t) => t === 'b')).toHaveLength(3);
  });

  it('yields once before the first chunk, so the caller’s spinner paints', async () => {
    const ran: number[] = [];
    const promise = runChunked(fakeRender(3, ran));
    // Synchronously after the call: nothing has been rendered yet.
    expect(ran).toEqual([]);
    await promise;
  });

  it('stops between chunks when aborted, and leaves the rest undone', async () => {
    const ran: number[] = [];
    const controller = new AbortController();
    const gen = fakeRender(50, ran);
    const promise = runChunked(gen, {
      signal: controller.signal,
      onProgress: (_m, f) => {
        if ((f ?? 0) >= 0.04) controller.abort();
      },
    });
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    // Two chunks at most: the one that triggered the abort, and no more.
    expect(ran.length).toBeLessThanOrEqual(2);
  });

  it('does not start at all if the signal is already aborted', async () => {
    const ran: number[] = [];
    await expect(runChunked(fakeRender(4, ran), { signal: AbortSignal.abort() })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(ran).toEqual([]);
  });

  it('closes the render on the way out, so a half-built raster can go', async () => {
    const gen = fakeRender(10);
    const close = vi.spyOn(gen, 'return');
    await runChunked(gen, { signal: AbortSignal.abort() }).catch(() => {});
    expect(close).toHaveBeenCalled();
  });
});
