// Upper bound on `hashes`. Sized from the audit behind the identity-key fix
// (2026-10-10): the largest steady-state corpus is gov-rules at ~10.6k entries,
// so 20,000 leaves ~1.9x headroom, while a key that rotates per request
// (rmfyalk, +~5.8k dead keys per run) trips the bound within the first week
// instead of growing silently for months — the leak was only noticed after
// three. Exceeding it is a WARNING, never a prune: silently dropping keys would
// make the next run re-fetch the corpus with nothing in the logs to explain it.
export const DEFAULT_MAX_HASH_ENTRIES = 20000;

export const MAX_HASH_ENTRIES = (() => {
  const raw = Number(process.env.LEGAL_STATE_MAX_HASHES);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_MAX_HASH_ENTRIES;
})();

export function stateSizeReport(state, { max = MAX_HASH_ENTRIES } = {}) {
  const hashes = Object.keys(state?.hashes ?? {}).length;
  return { source: state?.source ?? null, hashes, max, exceeded: hashes > max };
}

// Loud but non-fatal: the caller decides what to do with the report. Returns
// null when the state is within bounds so callers can stay silent.
export function warnStateSize(state, { log = console.warn, max = MAX_HASH_ENTRIES } = {}) {
  const report = stateSizeReport(state, { max });
  if (!report.exceeded) return null;
  log(
    `[${report.source}] incremental state holds ${report.hashes} hash keys, over the ${report.max} bound `
    + `(${process.env.LEGAL_STATE_MAX_HASHES ? "LEGAL_STATE_MAX_HASHES" : "default"}): the identity key is `
    + `probably not stable and every run will re-fetch the corpus; nothing was pruned`,
  );
  return report;
}

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

// The size guard lives here rather than at each call site so no save path can
// bypass it (runtime.js checkpoints mid-run and again at the end). console.warn
// by default: production crawlers pass no logger, and an alarm nobody sees is
// how the 17,461-key leak stayed invisible for three months.
export async function saveState(s3, bucket, state, { log = console.warn, max = MAX_HASH_ENTRIES } = {}) {
  const { stateKey, safeSegment } = await import("./storage.js");
  if (!state?.source) throw new Error("legal-source state requires source");
  warnStateSize(state, { log, max });
  const next = { ...state, updatedAt: new Date().toISOString() };
  await s3.putObject(bucket, stateKey(state.source), JSON.stringify(next, null, 1), {
    contentType: "application/json",
  });
  return next;
}

// Identity the incremental state is keyed by. This is `source_id` unless the
// document/entry says otherwise: versioned adapters (party-regulation) keep one
// ROW per revision (`URL@v-<hash>`) while every revision is ONE entity for
// incremental purposes, and keying state by the row id made the detail side
// write a key the list side never looked up (party audit 2026-10-10: 0 of 193
// documents ever hit a known key). Sources that never set `state_key` are
// byte-for-byte unchanged.
export function stateKeyOf(item) {
  const declared = String(item?.state_key ?? "").trim();
  return declared || item?.source_id;
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
    // List and detail must read the SAME key, or the detail side records a
    // success the list side never finds again. Versioned adapters hand the
    // canonical key down via `state_key`; the rest keep using source_id.
    const stateKey = stateKeyOf(entry);
    const sourceId = entry?.source_id;
    if (!sourceId) {
      skipped.push({ entry, reason: "missing source_id" });
      continue;
    }
    const knownHash = state.hashes[stateKey];
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
