// Minimal Qdrant REST client for the embed worker. The deployment runs
// Qdrant tailnet-only at 100.64.0.9:6333 with no API key; nothing here talks
// to PostgreSQL. Zero-dependency: global fetch, injectable for tests.
//
// Upserts stall while Qdrant optimizes segments after mass inserts (hit live
// 2026-09-19: ~31k points in, wait=true PUTs exceeded the 60s fetch timeout
// and killed the run) — so transient failures (timeouts, network, 5xx) retry
// with backoff; a definitive 4xx fails fast.
class FatalQdrantError extends Error {}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export function createQdrant({
  url,
  collection,
  timeoutMs = 120000,
  maxAttempts = 5,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  fetchImpl = fetch,
} = {}) {
  if (!url || !collection) throw new Error("qdrant client requires url and collection");
  const base = url.replace(/\/+$/, "");

  async function call(path, body, method = body === undefined ? "GET" : "POST") {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetchImpl(`${base}${path}`, {
          method,
          headers: body === undefined ? undefined : { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (res.ok) return res.json();
        const text = (await res.text().catch(() => "")).slice(0, 200);
        const err = new Error(`qdrant ${path.split("?")[0]} HTTP ${res.status}: ${text}`);
        if (!RETRYABLE_STATUS.has(res.status)) throw new FatalQdrantError(err.message);
        lastErr = err;
      } catch (err) {
        if (err instanceof FatalQdrantError) throw err;
        lastErr = err; // timeout / network — retryable
      }
      if (attempt < maxAttempts) {
        const wait = Math.min(1000 * 2 ** (attempt - 1), 30000);
        console.error(`[qdrant] attempt ${attempt}/${maxAttempts} on ${path.split("?")[0]} failed (${String(lastErr?.message ?? lastErr).slice(0, 120)}); retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
    throw lastErr ?? new Error("qdrant request failed");
  }

  return {
    getPoint: (id, { withVector = false } = {}) =>
      call(`/collections/${collection}/points/${id}?with_vector=${withVector}&with_payload=false`).then((r) => r.result),

    // Payload law_id is a string in this collection (keyword), so filters take
    // the string form carried by the shard rows themselves. Upsert is PUT:
    // Qdrant's POST /points means "retrieve by ids" (hit live 2026-09-19).
    upsert: (points) =>
      call(`/collections/${collection}/points?wait=true`, { points }, "PUT"),

    deleteByLawIds: (lawIds) =>
      call(`/collections/${collection}/points/delete?wait=true`, {
        filter: { must: [{ key: "law_id", match: { any: lawIds } }] },
      }),

    countByLawIds: (lawIds, exact = true) =>
      call(`/collections/${collection}/points/count`, {
        filter: { must: [{ key: "law_id", match: { any: lawIds } }] },
        exact,
      }).then((r) => r.result.count),

    pointsByIds: (ids) =>
      call(`/collections/${collection}/points`, { ids, with_vector: false, with_payload: false })
        .then((r) => r.result ?? []),

    search: (vector, limit = 5) =>
      call(`/collections/${collection}/points/search`, { vector, limit, with_payload: true }).then((r) => r.result),
  };
}
