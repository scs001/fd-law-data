// Incremental state for one legal source. `hashes` is the observed content
// hash by source_id; `failures` preserves retry evidence without losing the
// last successful hash for an item that later failed to refresh.
export function emptyState(source) {
  return {
    version: 1,
    source,
    hashes: {},
    failures: {},
    watermark: null,
    updatedAt: null,
  };
}

export async function loadState(s3, bucket, source) {
  const { stateKey } = await import("./storage.js");
  const buf = await s3.getObject(bucket, stateKey(source));
  if (!buf) return emptyState(source);
  try {
    const state = JSON.parse(buf.toString("utf8"));
    return {
      ...emptyState(source),
      ...state,
      hashes: state.hashes ?? {},
      failures: state.failures ?? {},
    };
  } catch (err) {
    // A corrupt state degrades to a full crawl; it never invents success.
    console.error(`[${source}] corrupt legal-source state: ${err.message}; treating as empty`);
    return emptyState(source);
  }
}

export async function saveState(s3, bucket, state) {
  const { stateKey, safeSegment } = await import("./storage.js");
  if (!state?.source) throw new Error("legal-source state requires source");
  const next = { ...state, updatedAt: new Date().toISOString() };
  await s3.putObject(bucket, stateKey(state.source), JSON.stringify(next, null, 1), {
    contentType: "application/json",
  });
  return next;
}

export function rememberSuccess(state, { sourceId, hash, watermark = null }) {
  if (!sourceId || !hash) throw new Error("rememberSuccess requires sourceId and hash");
  state.hashes[sourceId] = hash;
  delete state.failures[sourceId];
  if (watermark && (!state.watermark || String(watermark) > String(state.watermark))) state.watermark = watermark;
  return state;
}

export function rememberFailure(state, { sourceId, reason, kind = "detail" }) {
  const prior = state.failures[sourceId];
  state.failures[sourceId] = {
    sourceId,
    kind,
    reason: String(reason ?? "unknown").slice(0, 1000),
    attempts: (prior?.attempts ?? 0) + 1,
    firstSeenAt: prior?.firstSeenAt ?? new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),
  };
  return state;
}

// Entries that must be refreshed: always new items; changed items when the
// adapter can compare a list-level hash; unchanged items only in full mode.
export function selectTargets(entries, state, { mode = "incremental" } = {}) {
  const targets = [];
  const skipped = [];
  for (const entry of entries) {
    const sourceId = entry?.source_id;
    if (!sourceId) {
      skipped.push({ entry, reason: "missing source_id" });
      continue;
    }
    const knownHash = state.hashes[sourceId];
    if (mode !== "full" && knownHash && (!entry.hash || entry.hash === knownHash)) {
      skipped.push({ sourceId, reason: "unchanged" });
      continue;
    }
    targets.push(entry);
  }
  return { targets, skipped };
}

// Fresh entries go first; previously-failed entries are retried at the tail.
// Front-loading chronic failures made every run open with a >25% failure
// ratio and trip the maxFailureRatio abort before any good entry ran
// (mfa-treaty multilateral, 2026-09-26: 8 chronic timeouts blocked 190).
export function freshEntriesFirst(entries, state) {
  const failed = new Set(Object.keys(state.failures ?? {}));
  return [...entries].sort((a, b) => Number(failed.has(a.source_id)) - Number(failed.has(b.source_id)));
}
