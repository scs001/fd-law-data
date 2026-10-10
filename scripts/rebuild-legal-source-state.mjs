#!/usr/bin/env node
// One-shot state rebuild for a legal source whose incremental identity key
// changed (change rmfyalk-incremental-identity, task 2.6).
//
// When the key changes, every `hashes` entry in state.json is unreachable: the
// next run would pay a full crawl to re-learn a corpus it already holds. This
// script backfills the new keys from the most recent run's structured part
// files (NDJSON), so the first post-fix run increments instead of re-crawling.
//
// Safety contract:
//   - idempotent: rebuilding from the same parts twice yields the same state;
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
import {
  stateBackupKey,
  stateKey,
  stateTempKey,
  structuredPrefix,
} from "../lib/legal-sources/storage.js";

export function parseArgs(argv) {
  const opts = { source: null, all: false, dryRun: false, limit: 0, help: false };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    const next = argv[i + 1];
    const value = next && !String(next).startsWith("--") ? next : null;
    if (token === "--source" && value) { opts.source = value; i++; }
    else if (token === "--all") opts.all = true;
    else if (token === "--all-runs") opts.allRuns = true;
    else if (token === "--dry-run") opts.dryRun = true;
    else if (token === "--limit") { opts.limit = Number(value ?? 0); if (value) i++; }
    else if (token === "--help" || token === "-h") opts.help = true;
    else throw new Error(`unknown or incomplete argument: ${token}${token === "--limit" || token === "--source" ? " (needs a value)" : ""}`);
  }
  return opts;
}

const USAGE = `usage: node scripts/rebuild-legal-source-state.mjs --source <id> [--dry-run] [--limit N]
       node scripts/rebuild-legal-source-state.mjs --all [--dry-run] [--limit N]

  --source <id>  one source id to rebuild (required unless --all)
  --all          iterate every registered source (use --dry-run first)
  --all-runs      rebuild from EVERY run's parts, not just the newest (use when
                  the newest run is partial; check the dry-run record count)
  --dry-run      print what would change; write nothing
  --limit N      stop after N part files (cheap sanity runs)

known sources: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`;

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

export function parsePartLines(text) {
  const records = [];
  let malformed = 0;
  for (const line of String(text ?? "").split("\n")) {
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

// Rebuild one source's state from the newest run's parts. Returns a plan; the
// caller decides whether to commit it.
export async function planRebuild({ s3, bucket, source, limit = 0, allRuns = false }) {
  const optsAllRuns = allRuns;
  const current = await loadState(s3, bucket, source);
  const oldKeys = Object.keys(current.hashes ?? {}).length;
  const oldFailures = Object.keys(current.failures ?? {}).length;

  const runs = classifyPartKeys(await listAllParts(s3, bucket, source));
  if (!runs.length) {
    return { source, ok: false, reason: `no structured run parts under ${structuredPrefix(source)}`, oldKeys, oldFailures };
  }
  // Default: the newest run only. It is "the corpus today"; folding older runs
  // back together would resurrect documents the source has since dropped.
  //
  // --all-runs exists because the newest run is not always the whole corpus:
  // gov-rules' most recent run held only 6 records against a ~10.6k state, and
  // party's held 194 against 391 — a scoped or partial run would otherwise
  // shrink the rebuilt state and make the next run re-fetch years of material.
  // Use it when the newest run is known to be partial (check the run manifest
  // with --dry-run first; the record count is printed).
  const useAll = optsAllRuns === true;
  const run = runs.at(-1);
  const partKeys = (useAll ? runs.flatMap((r) => r.keys) : run.keys)
    .slice(0, limit > 0 ? limit : undefined);

  const next = emptyState(source);
  let records = 0;
  let partsRead = 0;
  let malformed = 0;
  let skippedNoKey = 0;
  let skippedNoHash = 0;
  // The watermark is a corpus-wide high-water mark, not a per-key fact, so it
  // survives the key change and must be carried over rather than recomputed.
  let watermark = current.watermark ?? null;

  for (const key of partKeys) {
    const buf = await s3.getObject(bucket, key);
    if (!buf) continue;
    partsRead++;
    const parsed = parsePartLines(buf.toString("utf8"));
    malformed += parsed.malformed;
    for (const record of parsed.records) {
      records++;
      const stateKeyId = stateKeyOf(record);
      if (!stateKeyId) { skippedNoKey++; continue; }
      if (!record.content_hash) { skippedNoHash++; continue; }
      next.hashes[stateKeyId] = record.content_hash;
      const published = record.published_at ?? null;
      if (published && (!watermark || String(published) > String(watermark))) watermark = published;
    }
  }
  next.watermark = watermark;

  // A failure is retry evidence for a key the next run will look up. Old keys
  // are by definition unreachable after a key change, so most failures drop —
  // but a failure whose key already equals a new key (an already-migrated
  // state, i.e. a second run) must survive verbatim.
  const mappedFailures = Object.keys(current.failures ?? {}).filter((key) => key in next.hashes);
  for (const key of mappedFailures) next.failures[key] = current.failures[key];
  const droppedFailures = oldFailures - mappedFailures.length;

  const rebuilt = Object.keys(next.hashes).length;
  if (!rebuilt) {
    return { source, ok: false, reason: `run ${run.runId} yielded no usable hash keys`, oldKeys, oldFailures, partsRead, records };
  }
  const carriedKeys = Object.keys(current.hashes ?? {}).filter((key) => key in next.hashes).length;

  return {
    source,
    ok: true,
    runId: run.runId,
    runsAvailable: runs.length,
    oldKeys,
    newKeys: rebuilt,
    // Old keys that no longer exist under the new identity. A non-zero count is
    // the expected outcome of a key change; a zero count means the rebuild was
    // a no-op (already migrated).
    droppedKeys: oldKeys - carriedKeys,
    oldFailures,
    keptFailures: mappedFailures.length,
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
// alone (there is no rename, so the marker is the provenance record).
export function serializeState(state, { rebuiltAt, runId, previousKeys }) {
  const body = {
    ...state,
    updatedAt: rebuiltAt,
    rebuild: { at: rebuiltAt, fromRunId: runId, previousHashKeys: previousKeys },
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
  const lines = [
    `source            : ${plan.source}`,
    `mode              : ${dryRun ? "dry-run (nothing written)" : "written"}`,
  ];
  if (!plan.ok) {
    lines.push(`result            : SKIPPED — ${plan.reason}`);
    return lines;
  }
  lines.push(
    `from run          : ${plan.runId} (${plan.partsRead} part(s) of ${plan.runsAvailable} run(s) available; ${plan.records} record(s))`,
    `old hash keys     : ${plan.oldKeys}`,
    `new hash keys     : ${plan.newKeys}`,
    `dropped keys      : ${plan.droppedKeys}`,
    `failures          : ${plan.keptFailures} kept / ${plan.droppedFailures} dropped (of ${plan.oldFailures})`,
  );
  if (plan.skippedNoKey) lines.push(`records w/o key   : ${plan.skippedNoKey} (skipped)`);
  if (plan.skippedNoHash) lines.push(`records w/o hash  : ${plan.skippedNoHash} (skipped)`);
  if (plan.malformed) lines.push(`malformed lines   : ${plan.malformed} (skipped)`);
  lines.push(
    dryRun
      ? `backup would be   : ${stateBackupKey(plan.source, stamp)} (cleanup is manual)`
      : backupKey
        ? `backup            : ${backupKey} (cleanup is manual)`
        : "backup            : none (no previous state)",
  );
  return lines;
}

export async function rebuildSource({ s3, bucket, source, dryRun = false, limit = 0, allRuns = false, stamp, now = null, log = console.log }) {
  const plan = await planRebuild({ s3, bucket, source, limit, allRuns });
  let backupKey = null;
  if (plan.ok && !dryRun) {
    const bytes = serializeState(plan.body, {
      rebuiltAt: (now ?? new Date()).toISOString(),
      runId: plan.runId,
      previousKeys: plan.oldKeys,
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
      results.push(await rebuildSource({ s3: client, bucket: target, source, dryRun: opts.dryRun, limit: opts.limit, allRuns: opts.allRuns === true, stamp: stampValue, log }));
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
