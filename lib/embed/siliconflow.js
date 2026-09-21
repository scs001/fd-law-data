// SiliconFlow embeddings client (OpenAI-compatible POST /embeddings), part of
// the incremental embed worker. The historical law_chunks_v2 corpus was
// produced by this service with plain chunk text (verified 2026-09-19: cosine
// 0.9999 against a stored point), so the worker must make the identical call.
// Zero-dependency: global fetch + injectable sleep/fetch for tests.
//
// Transient failures (429, 5xx, timeouts, network) retry with exponential
// backoff; a definitive 4xx fails fast — retrying cannot fix the payload.
class FatalEmbedError extends Error {}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);

export function createEmbedder({
  endpoint,
  apiKey,
  model,
  timeoutMs = 60000,
  maxAttempts = 6,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch,
  log = () => {},
} = {}) {
  if (!endpoint || !apiKey || !model) throw new Error("embedder requires endpoint, apiKey and model");

  async function embed(texts) {
    if (!texts.length) return { vectors: [], usage: null };
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetchImpl(`${endpoint.replace(/\/+$/, "")}/embeddings`, {
          method: "POST",
          headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) {
          const j = await res.json();
          const byIndex = new Map(j.data.map((d) => [d.index, d.embedding]));
          const vectors = texts.map((_, i) => byIndex.get(i));
          if (vectors.some((v) => !Array.isArray(v) || v.length === 0)) {
            throw new FatalEmbedError("embeddings response missing vectors for some inputs");
          }
          return { vectors, usage: j.usage ?? null };
        }
        const body = await res.text().catch(() => "");
        const err = new Error(`embeddings HTTP ${res.status}: ${body.slice(0, 200)}`);
        if (!RETRYABLE_STATUS.has(res.status)) throw new FatalEmbedError(err.message);
        lastErr = err;
      } catch (err) {
        if (err instanceof FatalEmbedError) throw err;
        lastErr = err; // timeout / network / malformed json — retryable
      }
      if (attempt < maxAttempts) {
        const wait = Math.min(1000 * 2 ** (attempt - 1), 30000);
        log(`[embed] attempt ${attempt}/${maxAttempts} failed (${String(lastErr?.message ?? lastErr).slice(0, 120)}); retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
    throw lastErr ?? new Error("embeddings failed");
  }

  return { embed };
}
