// Minimal bring-your-own-key OpenRouter chat client. OpenRouter's API is
// OpenAI-compatible and allows browser (CORS) requests, so no proxy is needed.

const DEFAULT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterOptions {
  apiKey: string;
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  /** Injected fetch (defaults to global fetch) — handy for tests. */
  fetchImpl?: typeof fetch;
  /** Override endpoint (tests / self-host). */
  url?: string;
  /** Optional OpenRouter attribution title (defaults to the app name). */
  title?: string;
  /** Optional OpenRouter attribution referer (omitted unless set). */
  referer?: string;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  error?: { message?: string };
}

export async function chatCompletion(
  model: string,
  messages: ChatMessage[],
  opts: OpenRouterOptions,
): Promise<string> {
  if (!opts.apiKey) throw new Error('Missing OpenRouter API key');
  if (!model) throw new Error('No OpenRouter model set');
  const fetchImpl = opts.fetchImpl ?? fetch;

  let resp: Response;
  try {
    resp = await fetchImpl(opts.url ?? DEFAULT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // Optional OpenRouter attribution. Kept to the app's own name rather
        // than a made-up GitHub repo; overridable by the caller.
        'X-Title': opts.title ?? 'image-to-uv-tool',
        ...(opts.referer ? { 'HTTP-Referer': opts.referer } : {}),
      },
      body: JSON.stringify({
        model,
        messages,
        ...(opts.temperature != null ? { temperature: opts.temperature } : {}),
        ...(opts.maxTokens != null ? { max_tokens: opts.maxTokens } : {}),
      }),
      signal: opts.signal,
    });
  } catch (err) {
    if (err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError') throw err;
    throw new Error('Could not reach OpenRouter — check your internet connection');
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    throw new Error(`OpenRouter error ${resp.status}: ${detail || resp.statusText}`);
  }

  const data = (await resp.json()) as ChatResponse;
  if (data.error) throw new Error(data.error.message || 'OpenRouter error');
  const text = data.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error('OpenRouter returned no content');
  return text;
}
