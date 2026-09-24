// Unified crawl runtime for wave-1 legal sources. Adapters only describe list
// and detail access; this module owns rate limiting, storage layout, snapshots,
// incremental state, retries, failure classification and coverage manifests.
import { createHash } from "node:crypto";
import { fetchWithRetry } from "../http.js";
import { putIfChanged } from "../s3.js";
import { assertTransportAllowed, proxyForSource } from "./session.js";
import { isSessionProxyFailure } from "./errors.js";
import {
  attachmentKey,
  manifestKey,
  rawKey,
  runDateUtc,
  runIdUtc,
  structuredPartKey,
} from "./storage.js";
import { loadState, rememberFailure, rememberSuccess, saveState, selectTargets, retryFailuresFirst } from "./state.js";

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
}

export function canonicalContentHash(document) {
  const material = {
    title: document.title ?? null,
    content: document.content ?? null,
    status: document.status ?? null,
    published_at: document.published_at ?? null,
    effective_at: document.effective_at ?? null,
    metadata: document.metadata ?? {},
  };
  return sha256(stableStringify(material));
}

export function createHttpHelpers({ rateMs = 1100, headers = {}, timeoutMs = 30000, authHeaders = null, fetchImpl = null } = {}) {
  const allHeaders = { ...DEFAULT_HEADERS, ...headers, ...(authHeaders ?? {}) };
  const doFetch = fetchImpl ?? ((url, opts = {}) => fetchWithRetry(url, opts, { timeoutMs }));
  // Proxy fetches bypass lib/http.js's global limiter, so enforce the same
  // source-wide interval here. This covers list, detail and attachments.
  let lastFetchAt = 0;
  async function request(url, opts = {}, localTimeoutMs = timeoutMs) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const wait = lastFetchAt + rateMs - Date.now();
        if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
        lastFetchAt = Date.now();
        return await doFetch(url, opts);
      } catch (err) {
        lastErr = err;
        if (err?.name === "StructureDriftError") throw err;
        if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
    throw lastErr;
  }
  // One global limiter intentionally matches lib/http.js: list, detail and
  // attachment calls share a source's budget rather than multiplying it.
  const original = globalThis.__legalSourcesRateMs;
  if (original !== rateMs) {
    // setMinInterval mutates module state; import lazily so tests can use rate 0.
    (async () => {
      const { setMinInterval } = await import("../http.js");
      setMinInterval(rateMs);
    })();
    globalThis.__legalSourcesRateMs = rateMs;
  }
  return {
    headers: allHeaders,
    async fetchText(url, opts = {}) {
      const res = await request(url, { ...opts, headers: { ...allHeaders, ...(opts.headers ?? {}) } });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.name = "SourceHttpError";
        err.status = res.status;
        throw err;
      }
      return res.text();
    },
    async fetchJson(url, opts = {}) {
      const text = await this.fetchText(url, opts);
      try {
        return JSON.parse(text);
      } catch (err) {
        const drift = new Error(`non-JSON response from ${url}: ${text.slice(0, 120)}`);
        drift.name = "StructureDriftError";
        throw drift;
      }
    },
    async fetchBuffer(url, opts = {}) {
      const res = await request(url, { ...opts, headers: { ...allHeaders, ...(opts.headers ?? {}) } }, 120000);
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.name = "SourceHttpError";
        err.status = res.status;
        throw err;
      }
      return { body: Buffer.from(await res.arrayBuffer()), contentType: res.headers?.get?.("content-type") ?? "application/octet-stream" };
    },
  };
}

function classifyFailure(err) {
  if (isSessionProxyFailure(err)) return "session";
  if (err?.name === "SourceHttpError" && (err.status === 401 || err.status === 403)) return "session";
  if (err?.name === "StructureDriftError") return "structure";
  if (err?.name === "SourceHttpError") return "http";
  return "adapter";
}

function normalizeDocument(input, source, entry) {
  const sourceId = input.source_id ?? entry.source_id;
  if (!sourceId) throw Object.assign(new Error("adapter returned a document without source_id"), { name: "StructureDriftError" });
  if (!input.title) throw Object.assign(new Error(`document ${sourceId} has no title`), { name: "StructureDriftError" });
  const doc = {
    source,
    source_id: String(sourceId),
    doc_type: input.doc_type ?? entry.doc_type ?? "document",
    title: String(input.title),
    published_at: input.published_at ?? entry.published_at ?? null,
    effective_at: input.effective_at ?? entry.effective_at ?? null,
    status: input.status ?? entry.status ?? null,
    authority: input.authority ?? entry.authority ?? null,
    language: input.language ?? entry.language ?? null,
    content: typeof input.content === "string" && input.content.trim() ? input.content : null,
    source_url: input.source_url ?? entry.url ?? null,
    metadata: input.metadata ?? {},
  };
  if (!doc.source_url) throw Object.assign(new Error(`document ${sourceId} has no source_url`), { name: "StructureDriftError" });
  return doc;
}

async function uploadArtifact(s3, bucket, source, sourceId, artifact, dryRun) {
  if (dryRun) return null;
  const kind = artifact.kind === "attachment" ? "attachment" : "raw";
  const key = kind === "attachment"
    ? attachmentKey(source, sourceId, artifact.filename)
    : rawKey(source, sourceId, artifact.filename);
  const body = Buffer.isBuffer(artifact.body) ? artifact.body : Buffer.from(String(artifact.body), "utf8");
  await putIfChanged(s3, bucket, key, body, { contentType: artifact.contentType ?? "application/octet-stream" });
  return key;
}

/**
 * @param {object} params
 * @param {string} params.source stable id, e.g. rmfyalk-case-library
 * @param {object} params.adapter {id?, mode?, rateMs?, list(filters, helpers),
 *   detail(entry, helpers)}
 * @param {'incremental'|'full'} [params.mode]
 * @param {Array} [params.entries] override adapter.list (tests / backfills)
 * @param {number} [params.maxFailureRatio] stop the run when exceeded
 */
export async function crawlLegalSource({
  s3,
  bucket,
  source,
  adapter,
  mode = "incremental",
  entries: entriesOverride = null,
  filters = {},
  dryRun = false,
  rateMs,
  partSize = 300,
  maxFailureRatio = 0.25,
  authHeaders = null,
  auth = null,
  fetchImpl = null,
  log = () => {},
} = {}) {
  if (!source || !adapter?.list || !adapter?.detail) throw new Error("crawlLegalSource requires source, adapter.list and adapter.detail");
  assertTransportAllowed(adapter);
  const effectiveRate = rateMs ?? adapter.rateMs ?? 1100;
  const helpers = createHttpHelpers({ rateMs: effectiveRate, headers: adapter.headers, authHeaders, fetchImpl });
  const proxy = proxyForSource(source);
  if (adapter.requiresProxy && !proxy) {
    const err = new Error(`${source} requires ${source.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_PROXY_URL`);
    err.name = "SessionProxyError";
    throw err;
  }

  const state = dryRun ? { source, hashes: {}, failures: {} } : await loadState(s3, bucket, source);
  const listed = entriesOverride
    ? { entries: entriesOverride, total: entriesOverride.length, pages: 1, unreachablePages: [] }
    : await adapter.list({ ...filters, mode, proxy }, helpers);
  const entries = retryFailuresFirst(listed.entries ?? [], state);
  const { targets, skipped } = selectTargets(entries, state, { mode });

  const runDate = runDateUtc();
  const runId = runIdUtc();
  const records = [];
  const failures = [];
  const parts = [];
  let openPart = [];
  let nextPart = 1;
  let emitted = 0;
  let skippedUnchanged = 0;
  let missingText = 0;
  let attachments = 0;
  let aborted = null;

  const flushPart = async (force = false) => {
    if (dryRun || (!force && openPart.length < partSize)) return;
    if (!openPart.length) return;
    const key = structuredPartKey(source, runDate, nextPart);
    await s3.putObject(bucket, key, openPart.map((r) => JSON.stringify(r)).join("\n") + "\n", {
      contentType: "application/x-ndjson",
      timeoutMs: 120000,
    });
    parts.push({ key, rows: openPart.length });
    nextPart++;
    openPart = [];
  };

  for (const entry of targets) {
    try {
      const detail = await adapter.detail(entry, helpers);
      const doc = normalizeDocument(detail.document ?? detail, source, entry);
      doc.content_hash = detail.hash ?? canonicalContentHash(doc);
      doc.fetched_at = new Date().toISOString();
      if (!doc.content) missingText++;
      if (state.hashes[doc.source_id] === doc.content_hash) {
        skippedUnchanged++;
        rememberSuccess(state, { sourceId: doc.source_id, hash: doc.content_hash });
        continue;
      }
      const rawKeys = [];
      for (const artifact of detail.artifacts ?? []) {
        const key = await uploadArtifact(s3, bucket, source, doc.source_id, artifact, dryRun);
        if (key) {
          rawKeys.push(key);
          if (key.includes("/attachments/")) attachments++;
        }
      }
      if (rawKeys.length) doc.metadata = { ...doc.metadata, object_keys: rawKeys };
      records.push(doc);
      emitted++;
      rememberSuccess(state, { sourceId: doc.source_id, hash: doc.content_hash, watermark: doc.published_at });
      openPart.push(doc);
      await flushPart();
    } catch (err) {
      const kind = classifyFailure(err);
      const failure = {
        sourceId: entry.source_id,
        kind,
        reason: String(err?.message ?? err).slice(0, 1000),
      };
      failures.push(failure);
      rememberFailure(state, failure);
      if (kind === "session") {
        aborted = { reason: "session/proxy failure", error: failure.reason };
        break;
      }
      const processed = records.length + failures.length;
      if (processed >= 10 && failures.length / processed > maxFailureRatio) {
        aborted = { reason: "failure threshold exceeded", error: failure.reason };
        break;
      }
    }
  }
  await flushPart(true);

  const manifest = {
    version: 1,
    source,
    mode,
    runDate,
    runId,
    proxyConfigured: Boolean(proxy),
    auth: auth ? {
      broker: auth.broker ?? null,
      account_id: auth.accountId ?? null,
      mode: auth.mode ?? null,
      fingerprint: auth.fingerprint ?? null,
      probe: auth.probe ?? null,
    } : null,
    coverage: {
      listed: listed.entries?.length ?? 0,
      sourceTotal: listed.total ?? null,
      pages: listed.pages ?? null,
      unreachablePages: listed.unreachablePages ?? [],
      planned: targets.length,
      skippedUnchanged,
      emitted,
      failures: failures.length,
      missingText,
      attachments,
      complete: !aborted && !(listed.unreachablePages ?? []).length,
    },
    filters,
    failures,
    aborted,
    parts,
    finishedAt: new Date().toISOString(),
  };

  if (!dryRun) {
    if (parts.length) {
      await putIfChanged(s3, bucket, manifestKey(source, runDate, runId), JSON.stringify(manifest, null, 1), {
        contentType: "application/json",
      });
    }
    await saveState(s3, bucket, state);
  }
  log(`[${source}] emitted=${emitted} skipped=${skippedUnchanged} failures=${failures.length} complete=${manifest.coverage.complete}`);
  return { manifest, records, state };
}
