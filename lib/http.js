// Rate-limited fetch with retry/backoff. One global limiter keeps flk pacing
// honest across list/detail/download calls (~1 req/s by default).
const MIN_INTERVAL_MS_DEFAULT = 1100;
let lastAt = 0;
let chain = Promise.resolve();

export function setMinInterval(ms) {
  minInterval = ms;
}
let minInterval = MIN_INTERVAL_MS_DEFAULT;

function gate() {
  const run = chain.then(async () => {
    const now = Date.now();
    const wait = lastAt + minInterval - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastAt = Date.now();
  });
  chain = run.catch(() => {});
  return run;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(url, opts = {}, { retries = 4, timeoutMs = 30000, rateLimit = true } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (rateLimit) await gate();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(timer);
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`HTTP ${res.status} for ${url}`);
        if (attempt < retries) {
          const ra = Number(res.headers.get("retry-after"));
          await sleep(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2 ** attempt * 1000);
          continue;
        }
        throw lastErr;
      }
      return res;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (attempt < retries) {
        await sleep(2 ** attempt * 1000);
        continue;
      }
    }
  }
  throw lastErr ?? new Error(`fetch failed: ${url}`);
}

export async function fetchJson(url, opts = {}, retryOpts = {}) {
  const res = await fetchWithRetry(url, opts, retryOpts);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}
