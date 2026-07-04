// Minimal bring-your-own-key Replicate client.
//
// CORS note: api.replicate.com does not send permissive CORS headers, so a
// direct browser call will usually be blocked. Set a `proxyUrl` (a small
// self-hosted proxy that forwards to api.replicate.com and adds CORS headers)
// to work around this. Left empty, calls go straight to Replicate.

const DEFAULT_BASE = 'https://api.replicate.com/v1';

export interface ReplicateOptions {
  apiKey: string;
  proxyUrl?: string | null;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /** Poll interval in ms (overridable for tests). */
  pollIntervalMs?: number;
  /** Cap on the (backed-off) poll interval in ms. */
  maxPollIntervalMs?: number;
  /** Give up polling after roughly this long. Guards a stuck prediction. */
  maxDurationMs?: number;
  /** Consecutive transient (429/5xx/network) poll failures tolerated. */
  maxPollRetries?: number;
  /** Injected fetch (defaults to global fetch) — handy for tests. */
  fetchImpl?: typeof fetch;
  /** Injected sleep (defaults to setTimeout) — handy for tests. */
  sleepImpl?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** A transient poll failure worth retrying (rate limit, upstream 5xx, network blip). */
function isTransientPollError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /error (429|5\d\d)\b/.test(err.message) || /Network request failed/.test(err.message);
}

interface Prediction {
  id: string;
  status: 'starting' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  output?: unknown;
  error?: string | null;
}

function baseUrl(proxyUrl?: string | null): string {
  const p = proxyUrl?.trim();
  return p ? p.replace(/\/+$/, '') : DEFAULT_BASE;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function isAbort(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

async function request<T>(url: string, init: RequestInit, opts: ReplicateOptions): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        ...(init.headers ?? {}),
      },
      signal: opts.signal,
    });
  } catch (err) {
    if (isAbort(err)) throw err; // preserve cancellation
    // fetch rejects (rather than returning a response) on a network-level
    // failure: CORS block, DNS, offline. Translate into an actionable hint.
    const host = hostOf(url);
    const hint =
      host === 'api.replicate.com'
        ? 'api.replicate.com blocks direct browser calls (CORS) — set a Proxy URL (see the README)'
        : `could not reach ${host} — is your proxy running?`;
    throw new Error(`Network request failed: ${hint}`);
  }
  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Replicate API error ${resp.status}: ${detail || resp.statusText}`);
  }
  return (await resp.json()) as T;
}

/**
 * Best-effort remote cancel so a cancelled/deleted node stops billing on
 * Replicate. Deliberately swallows all errors and never uses the run's abort
 * signal (which is already aborted by the time we call this).
 */
async function cancelPrediction(base: string, id: string, opts: ReplicateOptions): Promise<void> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  try {
    await fetchImpl(`${base}/predictions/${id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.apiKey}` },
    });
  } catch {
    /* best effort — the prediction may already have finished */
  }
}

interface ModelInfo {
  latest_version?: { id?: string } | null;
}

/**
 * Resolve a model's latest version id. Community models require running a
 * specific version via `/v1/predictions`; official models are versionless and
 * return `null` here so the caller falls back to the model-predictions endpoint.
 */
async function resolveLatestVersion(
  base: string,
  slug: string,
  opts: ReplicateOptions,
): Promise<string | null> {
  let model: ModelInfo;
  try {
    model = await request<ModelInfo>(`${base}/models/${slug}`, { method: 'GET' }, opts);
  } catch (err) {
    if (err instanceof Error && /error 404/.test(err.message)) {
      throw new Error(`Model "${slug}" not found on Replicate — check the model slug in the node's settings`);
    }
    throw err;
  }
  return model.latest_version?.id ?? null;
}

/**
 * Run a Replicate model and return its raw output. Accepts `owner/name` or
 * `owner/name:versionId`. For a bare `owner/name` it resolves the latest
 * version (community models) and falls back to the official model-predictions
 * endpoint for versionless official models. Uses `Prefer: wait`, then polls.
 */
export async function runModel(
  model: string,
  input: Record<string, unknown>,
  opts: ReplicateOptions,
): Promise<unknown> {
  if (!opts.apiKey) throw new Error('Missing Replicate API key');
  const [slug, explicitVersion] = model.split(':');
  if (!slug || !slug.includes('/')) {
    throw new Error(`Invalid model slug "${model}" (expected "owner/name")`);
  }
  const base = baseUrl(opts.proxyUrl);
  const sleep = opts.sleepImpl ?? defaultSleep;
  const headers = { 'Content-Type': 'application/json', Prefer: 'wait' };

  opts.onProgress?.('Resolving model…');
  const version = explicitVersion || (await resolveLatestVersion(base, slug, opts));

  opts.onProgress?.('Starting prediction…');
  let pred = version
    ? await request<Prediction>(
        `${base}/predictions`,
        { method: 'POST', headers, body: JSON.stringify({ version, input }) },
        opts,
      )
    : await request<Prediction>(
        `${base}/models/${slug}/predictions`,
        { method: 'POST', headers, body: JSON.stringify({ input }) },
        opts,
      );

  // Once the prediction exists, a cancel/abort must tell Replicate to stop it —
  // otherwise it keeps running and billing after the user cancels (H6).
  const onAbort = () => void cancelPrediction(base, pred.id, opts);
  if (opts.signal) {
    if (opts.signal.aborted) onAbort();
    else opts.signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const pollInterval = opts.pollIntervalMs ?? 1500;
    const maxPollInterval = opts.maxPollIntervalMs ?? 15_000;
    const maxDuration = opts.maxDurationMs ?? 5 * 60 * 1000;
    const maxRetries = opts.maxPollRetries ?? 6;
    let elapsed = 0;
    let failures = 0;

    while (pred.status === 'starting' || pred.status === 'processing') {
      if (elapsed >= maxDuration) {
        throw new Error(`Prediction timed out after ${Math.round(elapsed / 1000)}s (still ${pred.status})`);
      }
      opts.onProgress?.(`Prediction ${pred.status}…`);
      // Back off after a transient failure; steady interval while healthy.
      const wait = Math.min(pollInterval * 2 ** failures, maxPollInterval);
      await sleep(wait, opts.signal);
      elapsed += wait;
      try {
        pred = await request<Prediction>(`${base}/predictions/${pred.id}`, { method: 'GET' }, opts);
        failures = 0;
      } catch (err) {
        if (isAbort(err)) throw err;
        // Ride out a rate limit / upstream blip instead of failing the whole run
        // (and orphaning the still-running prediction).
        if (isTransientPollError(err) && failures < maxRetries) {
          failures++;
          continue;
        }
        throw err;
      }
    }

    if (pred.status !== 'succeeded') {
      throw new Error(pred.error || `Prediction ${pred.status}`);
    }
    return pred.output;
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
  }
}

const isUrlLike = (s: unknown): s is string => typeof s === 'string' && /^(https?:|data:)/.test(s);

/**
 * Extract a usable image URL from a model's output. Handles a bare URL string,
 * arrays, and objects (e.g. Depth Anything's `{ grey_depth, color_depth }`).
 * `preferredKey` lets a node pick a specific output field.
 */
export function firstOutputUrl(output: unknown, preferredKey?: string): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    for (const item of output) {
      const url = firstOutputUrl(item, preferredKey);
      if (url) return url;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if (preferredKey && isUrlLike(obj[preferredKey])) return obj[preferredKey] as string;
    for (const key of ['image', 'output', 'url', 'mask']) {
      if (isUrlLike(obj[key])) return obj[key] as string;
    }
    // Fallback: first URL-like property (grey_depth, color_depth, …).
    for (const v of Object.values(obj)) if (isUrlLike(v)) return v;
    for (const v of Object.values(obj)) {
      const url = firstOutputUrl(v, preferredKey);
      if (url) return url;
    }
  }
  return null;
}

/**
 * Extract text from a model's output. Handles a bare string, an array of string
 * chunks (some models stream tokens), and objects with a text-ish field.
 */
export function firstOutputText(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const parts = output.filter((x): x is string => typeof x === 'string');
    if (parts.length) return parts.join('');
    for (const item of output) {
      const t = firstOutputText(item);
      if (t != null) return t;
    }
    return null;
  }
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    for (const key of ['text', 'caption', 'answer', 'output', 'result']) {
      if (typeof obj[key] === 'string') return obj[key] as string;
    }
    for (const v of Object.values(obj)) if (typeof v === 'string') return v;
  }
  return null;
}
