#!/usr/bin/env node
// One-shot state rebuild for a legal source whose incremental identity key
// changed (change rmfyalk-incremental-identity, task 2.6).
//
// When the key changes, every `hashes` entry in state.json is unreachable: the
// next run would pay a full crawl to re-learn a corpus it already holds. This
// script rebuilds the state under the NEW key from two kinds of evidence:
//
//   1. the run parts (NDJSON). Parts written before the fix do NOT contain the
//      new key, so it is DERIVED from each record's own fields per source (see
//      KEY_DERIVATIONS). A record whose natural key is missing is counted and
//      skipped — never keyed by whatever unstable id it happens to carry.
//   2. the old state's own keys, translated with the same per-source rule
//      where a translation exists. rmfyalk's old keys were rotating tokens
//      with no path back to a case number: they are unmappable, dropped, and
//      the count is reported (that is the point — those keys were junk).
// Parts win on conflict: they are newer evidence than the state they replace.
//
// Safety contract:
//   - idempotent: rebuilding from the same parts twice yields the same state.
//     A state this script already rebuilt carries a `rebuild.keyScheme`
//     marker, so the second pass translates nothing: keys already on the new
//     identity map to themselves instead of being dropped as old-key junk;
//   - never leaves a half-new state: the new object is built in memory, staged
//     at a temp key, read back byte-for-byte, and only then written over
//     state.json; any failure leaves the original object untouched and exits
//     non-zero (the S3 client has neither rename nor multipart copy, so the
//     staged bytes are re-PUT rather than moved);
//   - the previous object is preserved at state.json.bak-<stamp> before the
//     overwrite. Cleanup is MANUAL (see the summary output) — an automatic
//     delete would remove the only fallback for a rebuild whose new key turns
//     out to be wrong.
//
// Usage:
//   node scripts/rebuild-legal-source-state.mjs --source rmfyalk-case-library --dry-run
//   node scripts/rebuild-legal-source-state.mjs --source rmfyalk-case-library
//   node scripts/rebuild-legal-source-state.mjs --all --dry-run
//   node scripts/rebuild-legal-source-state.mjs --source gov-rules-library --limit 500
import { pathToFileURL } from "node:url";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { emptyState, loadState, stateKeyOf } from "../lib/legal-sources/state.js";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import { canonicalUrlKey } from "../lib/legal-sources/sources/gov-rules.js";
import {
  stateBackupKey,
  stateKey,
  stateTempKey,
  structuredPrefix,
} from "../lib/legal-sources/storage.js";

export function parseArgs(argv) {
  const opts = { source: null, all: false, allRuns: true, dryRun: false, limit: 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];
    const value = next && !String(next).startsWith("--") ? next : null;
    if (token === "--source" && value) { opts.source = value; i++; }
    else if (token === "--all") opts.all = true;
    else if (token === "--all-runs") opts.allRuns = true;
    else if (token === "--newest-run-only") opts.allRuns = false;
    else if (token === "--dry-run") opts.dryRun = true;
    else if (token === "--limit") { opts.limit = Number(value ?? 0); if (value) i++; }
    else if (token === "--help" || token === "-h") opts.help = true;
    else throw new Error(`unknown or incomplete argument: ${token}${token === "--limit" || token === "--source" ? " (needs a value)" : ""}`);
  }
  return opts;
}

const USAGE = `usage: node scripts/rebuild-legal-source-state.mjs --source <id> [--dry-run] [--limit N]
       node scripts/rebuild-legal-source-state.mjs --all [--dry-run] [--limit N]

  --source <id>      one source id to rebuild (required unless --all)
  --all              iterate every registered source (use --dry-run first)
  --all-runs         (DEFAULT) fold EVERY run's parts. The union of all runs is
                     a superset of the corpus: a document dropped upstream
                     simply will not be listed next run, while its state entry
                     costs one lookup and can never cause a re-fetch. The
                     newest run alone is NOT the corpus (production gov-rules:
                     6 records against 10,573 state keys), so folding only the
                     newest shrinks the rebuilt state and makes the next run
                     re-fetch years of material.
  --newest-run-only  fold only the newest run's parts (the old default; safe
                     only when that run is known to be the complete corpus)
  --dry-run          print what would change; write nothing
  --limit N          keep only the newest N part files (cheap sanity runs; a
                     truncated fold still resolves conflicts newest-wins)

known sources: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`;

const text = (value) => {
  const out = value == null ? "" : String(value).trim();
  return out || null;
};

// party-regulation rows are versioned (`URL@v-<hash>`, one row per revision)
// while the entity is the URL; the version suffix is not part of the identity
// the incremental state is keyed by (party-regulation.js parsePartyDetail).
const VERSION_SUFFIX_RE = /@v-[0-9a-f]+$/i;
const stripVersionSuffix = (value) => text(value)?.replace(VERSION_SUFFIX_RE, "") || null;

// Per-source derivation of the NEW state key. One entry per registered source,
// so a future key change is one table edit — and a registered source with no
// entry is an ERROR (keyDerivationFor) rather than a silent rebuild on
// whatever `source_id` the parts happen to hold.
//
//   fromRecord(record) -> new key | null   (part records, old and new)
//   fromOldKey(key)    -> new key | null   (keys of the state being replaced)
const KEY_DERIVATIONS = new Map([
  ["rmfyalk-case-library", {
    scheme: "case_no",
    // The old source_id was a per-request rotating token; the case number is
    // the identity and lives in metadata (present on old records too).
    fromRecord: (record) => text(record?.metadata?.case_no),
    // A token carries no case number: there is no translation back, so every
    // old key is unmappable and is dropped (counted in the summary).
    fromOldKey: () => null,
  }],
  ["party-regulation-library", {
    scheme: "canonical_article_url",
    fromRecord: (record) => text(record?.metadata?.canonical_source_id) ?? stripVersionSuffix(record?.source_id),
    fromOldKey: stripVersionSuffix,
  }],
  ["gov-rules-library", {
    scheme: "canonical_url",
    // One implementation with the adapter: canonicalUrlKey normalises scheme
    // and trailing slash, so an http/https flip collapses onto one key.
    fromRecord: (record) => canonicalUrlKey(record?.source_id),
    fromOldKey: canonicalUrlKey,
  }],
  // Sources whose identity did not change: state key = source_id (or the
  // adapter-declared state_key), exactly as the runtime keys it.
  ["mfa-treaty-library", { scheme: "source_id", fromRecord: stateKeyOf, fromOldKey: text }],
  ["ccdi-supervisory-regulations", { scheme: "source_id", fromRecord: stateKeyOf, fromOldKey: text }],
]);

const IDENTITY_DERIVATION = { scheme: "source_id", fromRecord: stateKeyOf, fromOldKey: text };

export function keyDerivationFor(source) {
  const derivation = KEY_DERIVATIONS.get(source);
  if (derivation) return derivation;
  // Unregistered ids (tests) have no key change to translate and fall back to
  // identity. A REGISTERED source missing an entry must fail loudly instead of
  // silently rebuilding on source_id.
  if (SOURCE_ADAPTERS.has(source)) {
    throw new Error(`no state-key derivation registered for source ${source}; add one to KEY_DERIVATIONS`);
  }
  return IDENTITY_DERIVATION;
}

// A structured part is `run-<14-digit-id>-partNNN.jsonl`. The run id is part of
// the key so a rebuild can fold runs in chronological order exactly like the
// loader does; anything else under structured/ (legacy day-only keys) is not a
// run part and is skipped.
const PART_RE = /\/run-(\d{14})-part\d+\.jsonl$/;

export function classifyPartKeys(keys) {
  const runs = new Map(); // runId -> [keys]
  for (const key of keys) {
    const match = PART_RE.exec(key);
    if (!match) continue;
    const list = runs.get(match[1]) ?? [];
    list.push(key);
    runs.set(match[1], list);
  }
  const ordered = [...runs.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([runId, list]) => ({ runId, keys: list.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)) }));
  return ordered;
}

export function parsePartLines(body) {
  const records = [];
  let malformed = 0;
  for (const line of String(body ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed));
    } catch {
      // A torn tail line from a mid-PUT read must not fail the rebuild.
      malformed++;
    }
  }
  return { records, malformed };
}

async function listAllParts(s3, bucket, source) {
  const prefix = structuredPrefix(source);
  const keys = [];
  let token;
  for (;;) {
    const page = await s3.listObjects(bucket, { prefix, continuationToken: token });
    for (const object of page.contents ?? []) keys.push(object.key);
    if (!page.truncated) break;
    token = page.continuationToken;
  }
  return keys;
}

// Rebuild one source's state from its run parts plus its old state's keys.
// Returns a plan; the caller decides whether to commit it.
export async function planRebuild({ s3, bucket, source, limit = 0, allRuns = true }) {
  const derivation = keyDerivationFor(source);
  const current = await loadState(s3, bucket, source);
  const oldHashes = current.hashes ?? {};
  const oldKeys = Object.keys(oldHashes).length;
  const oldFailures = Object.keys(current.failures ?? {}).length;

  // A state this script already rebuilt is on the new key. Translating its
  // keys with a lossy rule again (rmfyalk: old key -> nothing) would report
  // every key as dropped although it is already correct; the marker is the
  // proof that the state is post-migration. A state without the marker
  // predates the migration and its keys need the real translation.
  const alreadyMigrated = current.rebuild?.keyScheme === derivation.scheme;
  const translateOldKey = alreadyMigrated ? text : derivation.fromOldKey;

  const runs = classifyPartKeys(await listAllParts(s3, bucket, source));
  if (!runs.length) {
    return { source, ok: false, reason: `no structured run parts under ${structuredPrefix(source)}`, oldKeys, oldFailures };
  }
  // Default: EVERY run. The union is a superset of the corpus, so it can only
  // add state entries — and an extra entry costs one lookup, never a re-fetch;
  // a document genuinely dropped upstream is simply not listed next run. The
  // newest run alone is not the corpus: production gov-rules' newest run held
  // 6 records against 10,573 state keys and party's held 194 against 391, so
  // folding only the newest shrinks the state and forces a full re-crawl.
  // --newest-run-only exists for the rare run known to be the whole corpus.
  const run = runs.at(-1);
  const ordered = allRuns ? runs.flatMap((r) => r.keys) : run.keys;
  // --limit keeps the NEWEST parts: hash conflicts resolve newest-wins, so
  // truncating from the oldest end leaves the fold semantics of what is read
  // intact (a sanity run sees the records that would win).
  const partKeys = limit > 0 ? ordered.slice(-limit) : ordered;

  const next = emptyState(source);
  let records = 0;
  let partsRead = 0;
  let malformed = 0;
  let skippedNoKey = 0;
  let skippedNoHash = 0;
  // The watermark is a corpus-wide high-water mark, not a per-key fact, so it
  // survives the key change and must be carried over rather than recomputed.
  let watermark = current.watermark ?? null;

  // Old state first (older evidence): a key a part also carries is overwritten
  // by the newer hash in the parts loop below. Counters count DISTINCT new
  // keys, so two old keys that collapse onto one (gov-rules http + https for
  // the same document) report as one mapped key, not two.
  const fromOldState = new Set();
  let droppedUnmappable = 0;
  for (const [oldKey, hash] of Object.entries(oldHashes)) {
    const newKey = translateOldKey(oldKey);
    if (!newKey) { droppedUnmappable++; continue; }
    fromOldState.add(newKey);
    next.hashes[newKey] = hash;
  }

  const fromParts = new Set();
  for (const key of partKeys) {
    const buf = await s3.getObject(bucket, key);
    if (!buf) continue;
    partsRead++;
    const parsed = parsePartLines(buf.toString("utf8"));
    malformed += parsed.malformed;
    for (const record of parsed.records) {
      records++;
      const newKey = derivation.fromRecord(record);
      if (!newKey) { skippedNoKey++; continue; }
      if (!record.content_hash) { skippedNoHash++; continue; }
      next.hashes[newKey] = record.content_hash;
      fromParts.add(newKey);
      const published = record.published_at ?? null;
      if (published && (!watermark || String(published) > String(watermark))) watermark = published;
    }
  }
  next.watermark = watermark;

  // Failures are retry evidence for a key the next run will look up, so they
  // are translated with the same rule as hashes: a failure on an unmappable
  // old key can never be reached again and is dropped, a translated one keeps
  // its attempts under the new key. Unlike hashes they are NOT shadowed by a
  // part success: a part proves an earlier fetch worked, while the failure is
  // the latest attempt's evidence.
  let keptFailures = 0;
  for (const [oldKey, failure] of Object.entries(current.failures ?? {})) {
    const newKey = translateOldKey(oldKey);
    if (!newKey) continue;
    next.failures[newKey] = { ...failure, sourceId: newKey };
    keptFailures++;
  }
  const droppedFailures = oldFailures - keptFailures;

  const rebuilt = Object.keys(next.hashes).length;
  if (!rebuilt) {
    return {
      source, ok: false, reason: "no hash key could be derived from the parts or the old state",
      oldKeys, oldFailures, partsRead, records,
    };
  }

  return {
    source,
    ok: true,
    keyScheme: derivation.scheme,
    alreadyMigrated,
    runId: run.runId,
    runsAvailable: runs.length,
    runsFolded: allRuns ? runs.length : 1,
    oldKeys,
    mappedFromOldState: fromOldState.size,
    mappedFromParts: fromParts.size,
    droppedUnmappable,
    newKeys: rebuilt,
    oldFailures,
    keptFailures,
    droppedFailures,
    partsRead,
    malformed,
    records,
    skippedNoKey,
    skippedNoHash,
    body: next,
  };
}

// Build the bytes the object will hold. Same shape as saveState produces, with
// an explicit rebuild marker so a rebuilt state is auditable from the object
// alone (there is no rename, so the marker is the provenance record). The
// keyScheme is what makes a second rebuild idempotent: it tells the next pass
// that the state is already on the new identity.
export function serializeState(state, { rebuiltAt, runId, previousKeys, keyScheme, runsFolded }) {
  const body = {
    ...state,
    updatedAt: rebuiltAt,
    rebuild: { at: rebuiltAt, fromRunId: runId, previousHashKeys: previousKeys, keyScheme, runsFolded },
  };
  return JSON.stringify(body, null, 1);
}

// Commit = backup, stage, verify, overwrite, verify. Every step after the
// backup is idempotent, and none of them can leave state.json half-written:
// the new bytes exist at the temp key before state.json is touched.
export async function commitRebuild({ s3, bucket, source, bytes, stamp }) {
  const target = stateKey(source);
  const backupKey = stateBackupKey(source, stamp);
  const tempKey = stateTempKey(source, stamp);

  const original = await s3.getObject(bucket, target);
  if (original) {
    await s3.putObject(bucket, backupKey, original, { contentType: "application/json" });
    const check = await s3.getObject(bucket, backupKey);
    if (!check || Buffer.compare(Buffer.from(original), Buffer.from(check)) !== 0) {
      throw new Error(`backup ${backupKey} did not verify; state.json left untouched`);
    }
  }

  await s3.putObject(bucket, tempKey, bytes, { contentType: "application/json" });
  const staged = await s3.getObject(bucket, tempKey);
  if (!staged || Buffer.compare(Buffer.from(bytes), Buffer.from(staged)) !== 0) {
    throw new Error(`staged ${tempKey} did not verify; state.json left untouched`);
  }

  await s3.putObject(bucket, target, bytes, { contentType: "application/json" });
  const written = await s3.getObject(bucket, target);
  if (!written || Buffer.compare(Buffer.from(bytes), Buffer.from(written)) !== 0) {
    throw new Error(`state.json did not verify after write; restore from ${backupKey}`);
  }

  // The temp key is only a staging area; leaving it behind would put a second
  // state-looking object next to state.json for every future rebuild.
  await s3.deleteObject(bucket, tempKey);
  return { target, backupKey: original ? backupKey : null, tempKey };
}

function summaryLines(plan, { dryRun, backupKey, stamp }) {
  const row = (label, value) => `${label.padEnd(22)}: ${value}`;
  const lines = [
    row("source", plan.source),
    row("mode", dryRun ? "dry-run (nothing written)" : "written"),
  ];
  if (!plan.ok) {
    lines.push(row("result", `SKIPPED — ${plan.reason}`));
    return lines;
  }
  lines.push(
    row("runs folded", `${plan.runsFolded} of ${plan.runsAvailable} available (${plan.partsRead} part(s), ${plan.records} record(s))`),
    row("old state keys", plan.oldKeys),
    row("mapped from old state", plan.mappedFromOldState),
    row("mapped from parts", plan.mappedFromParts),
    row("dropped unmappable", plan.droppedUnmappable),
    row("new state keys", plan.newKeys),
    row("failures", `${plan.keptFailures} kept / ${plan.droppedFailures} dropped (of ${plan.oldFailures})`),
  );
  if (plan.droppedUnmappable) {
    // Loud on purpose: a dropped old key is either junk (rmfyalk's rotating
    // tokens) or a translation the table is missing. Either way the operator
    // must see it, not discover it in the next full crawl.
    lines.push(row("unmappable note", `${plan.droppedUnmappable} old key(s) have no translation under the new identity and were dropped`));
  }
  if (plan.skippedNoKey) lines.push(row("records w/o key", `${plan.skippedNoKey} (skipped)`));
  if (plan.skippedNoHash) lines.push(row("records w/o hash", `${plan.skippedNoHash} (skipped)`));
  if (plan.malformed) lines.push(row("malformed lines", `${plan.malformed} (skipped)`));
  lines.push(
    row(
      dryRun ? "backup would be" : "backup",
      dryRun
        ? `${stateBackupKey(plan.source, stamp)} (cleanup is manual)`
        : backupKey
          ? `${backupKey} (cleanup is manual)`
          : "none (no previous state)",
    ),
  );
  return lines;
}

export async function rebuildSource({ s3, bucket, source, dryRun = false, limit = 0, allRuns = true, stamp, now = null, log = console.log }) {
  const plan = await planRebuild({ s3, bucket, source, limit, allRuns });
  let backupKey = null;
  if (plan.ok && !dryRun) {
    const bytes = serializeState(plan.body, {
      rebuiltAt: (now ?? new Date()).toISOString(),
      runId: plan.runId,
      previousKeys: plan.oldKeys,
      keyScheme: plan.keyScheme,
      runsFolded: plan.runsFolded,
    });
    const committed = await commitRebuild({ s3, bucket, source, bytes, stamp });
    backupKey = committed.backupKey;
  }
  log(summaryLines(plan, { dryRun, backupKey, stamp }).join("\n"));
  if (!plan.ok) throw new Error(`${source}: ${plan.reason}`);
  return { ...plan, backupKey };
}

// --all is tolerant: a source that cannot be rebuilt is reported and the rest
// still run. Aborting the fleet on the first missing corpus would leave the
// other four keys unmigrated for no reason; `ok: false` is how the caller
// learns something was skipped.
export async function run({ argv = [], s3 = null, bucket = null, stamp = null, log = console.log } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) { log(USAGE); return { ok: true, results: [], skipped: [] }; }
  if (!opts.source && !opts.all) {
    // A fleet-wide rewrite is not the default: `--all` must be explicit.
    throw new Error("--source <id> is required (or pass --all to iterate the registry)");
  }
  const cfg = loadConfig();
  const client = s3 ?? createS3({
    endpoint: cfg.s3Endpoint,
    accessKey: cfg.s3AccessKey,
    secretKey: cfg.s3SecretKey,
    region: cfg.s3Region,
  });
  const target = bucket ?? cfg.lawsBucket;
  const sources = opts.all ? [...SOURCE_ADAPTERS.keys()] : [opts.source];
  for (const source of sources) {
    if (!SOURCE_ADAPTERS.has(source)) {
      throw new Error(`unknown legal source: ${source}; known: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`);
    }
  }
  const stampValue = stamp ?? new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const results = [];
  const skipped = [];
  for (const source of sources) {
    try {
      results.push(await rebuildSource({ s3: client, bucket: target, source, dryRun: opts.dryRun, limit: opts.limit, allRuns: opts.allRuns, stamp: stampValue, log }));
    } catch (err) {
      skipped.push({ source, reason: String(err?.message ?? err) });
    }
  }
  return { ok: skipped.length === 0, results, skipped, dryRun: opts.dryRun };
}

// Invoked directly (not imported by a test): turn a failure into a non-zero
// exit AFTER reporting, so a partial --all run still prints the sources that
// succeeded before it stopped.
function invokedDirectly() {
  const entry = process.argv[1];
  return entry && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  try {
    const result = await run({ argv: process.argv.slice(2) });
    // A source skipped under --all is not a crash, but it must still be a
    // non-zero exit: a silent 0 would let a cron conclude the fleet migrated.
    if (result.skipped?.length) {
      console.error(
        `[rebuild-legal-source-state] ${result.skipped.length} source(s) skipped: `
        + result.skipped.map((entry) => `${entry.source} (${entry.reason})`).join("; "),
      );
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(`[rebuild-legal-source-state] FATAL: ${err?.message ?? err}`);
    process.exitCode = 1;
  }
}
