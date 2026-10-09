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
import {
  loadState,
  rememberFailure,
  rememberSuccess,
  saveState,
  selectTargets,
  freshEntriesFirst,
  stateKeyOf,
  stateSizeReport,
  warnStateSize,
  MAX_HASH_ENTRIES,
} from "./state.js";

const DEFAULT_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// Response size guards: a single giant page or attachment must fail that one
// item instead of ballooning the crawl process past its cgroup limit (the
// multilateral treaty library serves bodies large enough to OOM a 1Gi pod).
const MAX_TEXT_BYTES = 20 * 1024 * 1024;
const MAX_BUFFER_BYTES = 80 * 1024 * 1024;

function declaredLength(res) {
  const n = Number(res.headers?.get?.("content-length"));
  return Number.isFinite(n) && n >= 0 ? n : null;
}

async function boundedText(res, url) {
  const declared = declaredLength(res);
  if (declared != null && declared > MAX_TEXT_BYTES) {
    const err = new Error(`response too large (${declared} bytes): ${url}`);
    err.name = "SourceHttpError";
    err.status = 413;
    throw err;
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_TEXT_BYTES) {
    const err = new Error(`response too large: ${url}`);
    err.name = "SourceHttpError";
    err.status = 413;
    throw err;
  }
  return text;
}

async function boundedBuffer(res, url) {
  const declared = declaredLength(res);
  if (declared != null && declared > MAX_BUFFER_BYTES) {
    const err = new Error(`attachment too large (${declared} bytes): ${url}`);
    err.name = "SourceHttpError";
    err.status = 413;
    throw err;
  }
  if (!res.body || typeof res.body.getReader !== "function") {
    return Buffer.from(await res.arrayBuffer());
  }
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BUFFER_BYTES) {
      try { await reader.cancel(); } catch {}
      const err = new Error(`attachment too large (> ${MAX_BUFFER_BYTES} bytes): ${url}`);
      err.name = "SourceHttpError";
      err.status = 413;
      throw err;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

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

// Split a --entries spec into unique source ids (comma/whitespace/semicolon).
export function parseEntryIds(raw) {
  const tokens = Array.isArray(raw) ? raw : String(raw ?? "").split(/[\s,;]+/);
  return [...new Set(tokens.map((token) => String(token).trim()).filter(Boolean))];
}

// Resolve bare source ids into adapter entries. Adapters that can derive a
// detail entry from an id alone (fixed URL template, id == URL) expose
// entryFromId(sourceId); the rest require a JSON/JSONL file of full entries,
// because synthesizing a half entry would fetch a wrong or empty document.
export function entriesFromIds(sourceIds, adapter) {
  const ids = parseEntryIds(sourceIds);
  if (!ids.length) throw new Error("entries override requires at least one source id");
  if (typeof adapter?.entryFromId !== "function") {
    throw new Error(
      `adapter ${adapter?.id ?? "(unknown)"} cannot resolve entries from a bare source id; pass a JSON/JSONL file of full entries instead`,
    );
  }
  return ids.map((id) => adapter.entryFromId(id));
}

// Entries override for targeted re-fetches (runtime `entries` parameter). The
// spec is either a comma/whitespace separated source-id list or a JSON array /
// JSONL document of full entry objects.
export function parseEntriesOverride(raw, adapter) {
  const text = String(raw ?? "").trim();
  if (!text) throw new Error("entries override is empty");
  if (!text.startsWith("[") && !text.startsWith("{")) return entriesFromIds(text, adapter);
  let entries;
  if (text.startsWith("[")) {
    entries = JSON.parse(text);
  } else {
    try {
      entries = [JSON.parse(text)];
    } catch {
      // JSONL: one full entry object per line.
      entries = text.split("\n").map((line) => line.trim()).filter(Boolean).map((line) => JSON.parse(line));
    }
  }
  if (!Array.isArray(entries) || !entries.length) {
    throw new Error("entries override must be a non-empty JSON array (or JSONL) of entries");
  }
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !String(entry.source_id ?? "").trim()) {
      throw new Error(`entries override item is missing source_id: ${JSON.stringify(entry)?.slice(0, 120)}`);
    }
  }
  return entries.map((entry) => ({ ...entry, source_id: String(entry.source_id) }));
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
      return boundedText(res, url);
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
      return { body: await boundedBuffer(res, url), contentType: res.headers?.get?.("content-type") ?? "application/octet-stream" };
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
    state_key: input.state_key ?? entry.state_key ?? null,
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
 * @param {Array} [params.entries] override adapter.list (tests / backfills /
 *   --entries targeted re-fetches)
 * @param {() => Date} [params.now] injectable clock (tests); defaults to wall clock
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
  now = null,
  log = () => {},
  // Overridable so tests can trip the state size guard without seeding 20k
  // keys; production reads the module default (or LEGAL_STATE_MAX_HASHES).
  maxHashEntries = MAX_HASH_ENTRIES,
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

  // The crawl's own log channel (`log`) is what an operator reads in the
  // CronJob; the state size guard uses it so an over-bound state is seen on the
  // run that caused it, not in a quarterly audit.
  const warn = (message) => log(message);
  const state = dryRun ? { source, hashes: {}, failures: {} } : await loadState(s3, bucket, source);
  const listed = entriesOverride
    ? { entries: entriesOverride, total: entriesOverride.length, pages: 1, unreachablePages: [] }
    : await adapter.list({ ...filters, mode, proxy }, helpers);
  const entries = freshEntriesFirst(listed.entries ?? [], state);
  const { targets, skipped } = selectTargets(entries, state, { mode });

  const clock = now ?? (() => new Date());
  const runDate = runDateUtc(clock());
  const runId = runIdUtc(clock());
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
    // Part keys embed the run id so a later run never overwrites an earlier
    // run's evidence; see structuredPartKey for the fold-order contract.
    const key = structuredPartKey(source, runId, nextPart);
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
      // Row identity vs incremental identity: a versioned adapter emits
      // `URL@v-<content-hash>` as source_id so each revision is its own row,
      // and hands the canonical URL down as state_key so the NEXT run's list
      // lookup hits the hash written here. Without it the two sides never met.
      doc.state_key = detail.state_key ?? doc.state_key ?? entry.state_key ?? null;
      doc.content_hash = detail.hash ?? canonicalContentHash(doc);
      doc.fetched_at = new Date().toISOString();
      if (!doc.content) missingText++;
      // Incremental mode only: an unchanged hash means the snapshot already
      // holds this record. Full mode must never skip the write on hash
      // equality — that discards the freshly downloaded evidence and leaves
      // state.json claiming success with no part behind it (ccdi full5
      // re-downloaded 299 records and dropped every one of them).
      // stateKey (not source_id) is what the next run's list lookup reads.
      const stateKey = stateKeyOf(doc);
      if (mode !== "full" && state.hashes[stateKey] === doc.content_hash) {
        skippedUnchanged++;
        rememberSuccess(state, { sourceId: stateKey, hash: doc.content_hash });
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
      rememberSuccess(state, { sourceId: stateKey, hash: doc.content_hash, watermark: doc.published_at });
      openPart.push(doc);
      await flushPart();
      // Checkpoint the incremental state with every flushed part: a run
      // killed by a job deadline or node restart then resumes from the last
      // part instead of re-fetching hours of details.
      if (!dryRun && !openPart.length) await saveState(s3, bucket, state, { log: warn, max: maxHashEntries });
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

  // Recorded in the manifest as well as logged: a full crawl is the visible
  // symptom of a drifting identity key, and this is the number that shows
  // whether state is converging on the corpus or growing past it.
  const stateSize = stateSizeReport(state, { max: maxHashEntries });

  const manifest = {
    version: 1,
    source,
    mode,
    // True when adapter.list was bypassed for a targeted re-fetch: coverage
    // counts describe the requested entries, not the full catalog.
    entriesOverride: Boolean(entriesOverride),
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
    // State size is a first-class run fact: a count that climbs run after run
    // means the identity key is not stable, and emitting it here makes that
    // drift visible without opening the 2MB state file (rmfyalk 2026-10-10).
    state: {
      hashes: stateSize.hashes,
      maxHashes: stateSize.max,
      overMaxHashes: stateSize.exceeded,
    },
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
    await saveState(s3, bucket, state, { log: warn, max: maxHashEntries });
  }
  log(`[${source}] emitted=${emitted} skipped=${skippedUnchanged} failures=${failures.length} complete=${manifest.coverage.complete}`);
  return { manifest, records, state };
}
