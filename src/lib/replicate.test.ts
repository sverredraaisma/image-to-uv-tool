import { describe, it, expect, vi } from 'vitest';
import { firstOutputText, firstOutputUrl, runModel } from './replicate';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

const noSleep = () => Promise.resolve();
const method = (init?: RequestInit) => init?.method ?? 'GET';

describe('firstOutputUrl', () => {
  it('handles strings, arrays and objects', () => {
    expect(firstOutputUrl('http://x/a.png')).toBe('http://x/a.png');
    expect(firstOutputUrl(['http://x/a.png', 'http://x/b.png'])).toBe('http://x/a.png');
    expect(firstOutputUrl({ image: 'http://x/c.png' })).toBe('http://x/c.png');
    expect(firstOutputUrl(42)).toBe(null);
  });

  it('extracts from arbitrary object keys (e.g. depth maps) and honours preferredKey', () => {
    const out = { grey_depth: 'https://x/grey.png', color_depth: 'https://x/color.png' };
    expect(firstOutputUrl(out)).toBe('https://x/grey.png'); // first url-like
    expect(firstOutputUrl(out, 'color_depth')).toBe('https://x/color.png');
  });

  it('ignores non-url string fields', () => {
    expect(firstOutputUrl({ status: 'succeeded', result: 'https://x/y.png' })).toBe('https://x/y.png');
  });
});

describe('firstOutputText', () => {
  it('handles strings, arrays of chunks and objects', () => {
    expect(firstOutputText('a caption')).toBe('a caption');
    expect(firstOutputText(['hel', 'lo'])).toBe('hello');
    expect(firstOutputText({ caption: 'a cat' })).toBe('a cat');
    expect(firstOutputText({ foo: 'bar' })).toBe('bar');
    expect(firstOutputText(123)).toBe(null);
  });
});

describe('runModel', () => {
  it('rejects an invalid model slug', async () => {
    await expect(runModel('notaslug', {}, { apiKey: 'k' })).rejects.toThrow(/owner\/name/);
  });

  it('rejects a missing api key', async () => {
    await expect(runModel('owner/name', {}, { apiKey: '' })).rejects.toThrow(/api key/i);
  });

  it('translates a direct CORS/network failure into a proxy hint', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith('/models/owner/name') && method(init) === 'GET') {
        return jsonResponse({ latest_version: { id: 'v' } });
      }
      throw new TypeError('Failed to fetch'); // browser CORS/network rejection on POST
    });
    await expect(
      runModel(
        'owner/name',
        {},
        {
          apiKey: 'k',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
        },
      ),
    ).rejects.toThrow(/Proxy URL/);
  });

  it('points at the proxy host when a proxy is configured', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    await expect(
      runModel(
        'owner/name',
        {},
        {
          apiKey: 'k',
          proxyUrl: 'http://localhost:8787/v1',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
        },
      ),
    ).rejects.toThrow(/localhost:8787/);
  });

  it('preserves cancellation (AbortError) rather than translating it', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(
      runModel(
        'owner/name',
        {},
        {
          apiKey: 'k',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
        },
      ),
    ).rejects.toThrow(/Abort/);
  });

  it('resolves the latest version for a community model and runs it', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/owner/name') && method(init) === 'GET') {
        return jsonResponse({ latest_version: { id: 'ver1' } });
      }
      if (u.endsWith('/predictions') && method(init) === 'POST') {
        return jsonResponse({ id: 'p1', status: 'succeeded', output: 'http://img/out.png' });
      }
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    const out = await runModel(
      'owner/name',
      { image: 'data:...' },
      {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: noSleep,
      },
    );
    expect(out).toBe('http://img/out.png');
    const postCall = fetchImpl.mock.calls.find((c) => method(c[1]) === 'POST')!;
    expect(String(postCall[1]?.body)).toContain('"version":"ver1"');
  });

  it('falls back to the model-predictions endpoint for versionless official models', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/meta/sam-2') && method(init) === 'GET') {
        return jsonResponse({ latest_version: null });
      }
      if (u.endsWith('/models/meta/sam-2/predictions') && method(init) === 'POST') {
        return jsonResponse({ id: 'p1', status: 'succeeded', output: 'http://img/x.png' });
      }
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    const out = await runModel(
      'meta/sam-2',
      {},
      {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: noSleep,
      },
    );
    expect(out).toBe('http://img/x.png');
  });

  it('uses an explicit version without resolving the model', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/')) throw new Error('should not resolve version');
      if (u.endsWith('/predictions') && method(init) === 'POST') {
        return jsonResponse({ id: 'p1', status: 'succeeded', output: 'http://img/v.png' });
      }
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    const out = await runModel(
      'owner/name:ver9',
      {},
      {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: noSleep,
      },
    );
    expect(out).toBe('http://img/v.png');
    // never GET-ed the model to resolve a version
    expect(fetchImpl.mock.calls.some((c) => /\/models\/owner\/name$/.test(String(c[0])))).toBe(false);
    const postCall = fetchImpl.mock.calls.find((c) => method(c[1]) === 'POST')!;
    expect(String(postCall[1]?.body)).toContain('"version":"ver9"');
  });

  it('polls until the prediction settles', async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/a/b') && method(init) === 'GET') {
        return jsonResponse({ latest_version: { id: 'v' } });
      }
      if (u.endsWith('/predictions') && method(init) === 'POST') {
        return jsonResponse({ id: 'p', status: 'processing' });
      }
      if (u.includes('/predictions/p') && method(init) === 'GET') {
        polls += 1;
        return jsonResponse(
          polls >= 2
            ? { id: 'p', status: 'succeeded', output: 'http://x.png' }
            : { id: 'p', status: 'processing' },
        );
      }
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    const out = await runModel(
      'a/b',
      {},
      {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: noSleep,
      },
    );
    expect(out).toBe('http://x.png');
    expect(polls).toBeGreaterThanOrEqual(2);
  });

  it('gives a friendly error when the model does not exist (404)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ detail: 'not found' }, false, 404));
    await expect(
      runModel(
        'owner/missing',
        {},
        {
          apiKey: 'k',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
        },
      ),
    ).rejects.toThrow(/not found/i);
  });

  it('throws on a failed prediction', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/a/b')) return jsonResponse({ latest_version: { id: 'v' } });
      if (u.endsWith('/predictions') && method(init) === 'POST') {
        return jsonResponse({ id: 'p', status: 'failed', error: 'boom' });
      }
      throw new Error('unexpected');
    });
    await expect(
      runModel(
        'a/b',
        {},
        {
          apiKey: 'k',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
        },
      ),
    ).rejects.toThrow(/boom/);
  });

  it('surfaces HTTP errors from the prediction call', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/a/b')) return jsonResponse({ latest_version: { id: 'v' } });
      if (u.endsWith('/predictions') && method(init) === 'POST') {
        return jsonResponse({ detail: 'nope' }, false, 401);
      }
      throw new Error('unexpected');
    });
    await expect(
      runModel(
        'a/b',
        {},
        {
          apiKey: 'k',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
        },
      ),
    ).rejects.toThrow(/401/);
  });

  it('rides out a transient 429 during polling and still succeeds', async () => {
    let polls = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/a/b') && method(init) === 'GET')
        return jsonResponse({ latest_version: { id: 'v' } });
      if (u.endsWith('/predictions') && method(init) === 'POST')
        return jsonResponse({ id: 'p', status: 'processing' });
      if (u.includes('/predictions/p') && method(init) === 'GET') {
        polls += 1;
        if (polls === 1) return jsonResponse({ detail: 'rate limited' }, false, 429); // transient
        return jsonResponse({ id: 'p', status: 'succeeded', output: 'http://x.png' });
      }
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    const out = await runModel(
      'a/b',
      {},
      {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: noSleep,
      },
    );
    expect(out).toBe('http://x.png');
    expect(polls).toBe(2); // one 429, then success
  });

  it('gives up on a transient failure once retries are exhausted', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/a/b') && method(init) === 'GET')
        return jsonResponse({ latest_version: { id: 'v' } });
      if (u.endsWith('/predictions') && method(init) === 'POST')
        return jsonResponse({ id: 'p', status: 'processing' });
      if (u.includes('/predictions/p') && method(init) === 'GET')
        return jsonResponse({ detail: 'boom' }, false, 503);
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    await expect(
      runModel(
        'a/b',
        {},
        {
          apiKey: 'k',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
          maxPollRetries: 2,
        },
      ),
    ).rejects.toThrow(/503/);
  });

  it('times out a prediction stuck in starting', async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/models/a/b') && method(init) === 'GET')
        return jsonResponse({ latest_version: { id: 'v' } });
      if (u.endsWith('/predictions') && method(init) === 'POST')
        return jsonResponse({ id: 'p', status: 'starting' });
      if (u.includes('/predictions/p') && method(init) === 'GET')
        return jsonResponse({ id: 'p', status: 'starting' });
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    await expect(
      runModel(
        'a/b',
        {},
        {
          apiKey: 'k',
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl: noSleep,
          pollIntervalMs: 1000,
          maxDurationMs: 4000,
        },
      ),
    ).rejects.toThrow(/timed out/i);
  });

  it('cancels the remote prediction when the run is aborted', async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${method(init)} ${url}`);
      const u = String(url);
      if (u.endsWith('/models/a/b') && method(init) === 'GET')
        return jsonResponse({ latest_version: { id: 'v' } });
      if (u.endsWith('/predictions') && method(init) === 'POST')
        return jsonResponse({ id: 'p', status: 'processing' });
      if (u.endsWith('/predictions/p/cancel') && method(init) === 'POST') return jsonResponse({});
      if (u.includes('/predictions/p') && method(init) === 'GET')
        return jsonResponse({ id: 'p', status: 'processing' });
      throw new Error(`unexpected ${method(init)} ${u}`);
    });
    // Abort during the first poll sleep, then reject like a real aborted sleep.
    const sleepImpl = (_ms: number, signal?: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        controller.abort();
        if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError'));
        else resolve();
      });
    await expect(
      runModel(
        'a/b',
        {},
        {
          apiKey: 'k',
          signal: controller.signal,
          fetchImpl: fetchImpl as unknown as typeof fetch,
          sleepImpl,
        },
      ),
    ).rejects.toThrow(/Abort/);
    expect(calls).toContain('POST https://api.replicate.com/v1/predictions/p/cancel');
  });
});
