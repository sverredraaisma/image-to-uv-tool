import { describe, it, expect, vi } from 'vitest';
import { chatCompletion } from './openrouter';

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: 'OK',
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('chatCompletion', () => {
  it('rejects a missing api key', async () => {
    await expect(chatCompletion('m', [], { apiKey: '' })).rejects.toThrow(/api key/i);
  });

  it('returns the assistant message content', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ choices: [{ message: { content: 'hello there' } }] }));
    const out = await chatCompletion('meta-llama/llama-3.1-8b-instruct', [{ role: 'user', content: 'hi' }], {
      apiKey: 'k',
      fetchImpl: fetchImpl as unknown as typeof fetch,
      temperature: 0.5,
      maxTokens: 100,
    });
    expect(out).toBe('hello there');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toContain('openrouter.ai');
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe('meta-llama/llama-3.1-8b-instruct');
    expect(body.temperature).toBe(0.5);
    expect(body.max_tokens).toBe(100);
  });

  it('surfaces HTTP errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ error: { message: 'bad' } }, false, 429));
    await expect(
      chatCompletion('m', [{ role: 'user', content: 'x' }], {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/429/);
  });

  it('throws when there is no content', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ choices: [] }));
    await expect(
      chatCompletion('m', [{ role: 'user', content: 'x' }], {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no content/i);
  });

  it('translates a network failure into a friendly message', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(
      chatCompletion('m', [{ role: 'user', content: 'x' }], {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/check your internet connection/i);
  });

  it('preserves cancellation (AbortError)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));
    await expect(
      chatCompletion('m', [{ role: 'user', content: 'x' }], {
        apiKey: 'k',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/Abort/);
  });
});
