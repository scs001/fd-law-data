#!/usr/bin/env node
// Unified data-machine loader for legal_documents snapshots. It reads only the
// structured/ prefix and writes only legal_documents; existing corpora are
// guarded, never modified.
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { loadLegalDocuments } from "../lib/legal-sources/document-loader.js";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import { structuredPrefix } from "../lib/legal-sources/storage.js";

// Bounded defaults for the data-machine network shape (loader pod -> RustFS /
// Windows PG across Tailscale). All are env-overridable so a k8s Job can be
// tuned without a rebuild: LEGAL_LOAD_CONCURRENCY, LEGAL_LOAD_CHUNK_SIZE,
// LEGAL_LOAD_PROGRESS_EVERY, LEGAL_LOAD_PART_TIMEOUT_MS, LEGAL_LOAD_PART_RETRIES.
const DEFAULTS = {
  concurrency: 3, // in-flight shard GETs; caps resident buffers on a 136 MB prefix
  chunkSize: 200, // rows per multi-row upsert (200 x 14 = 2,800 bind params)
  progressEvery: 10, // parts between download/fold progress lines
  partTimeoutMs: 60000, // covers headers + body of each shard GET
  partRetries: 2,
};

function arg(argv, name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : true;
}

function intEnv(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : def;
}

export async function main({ source: defaultSource, argv = [] } = {}) {
  const source = arg(argv, "source", defaultSource);
  if (!source || source === true) {
    throw new Error(`--source is required; known: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`);
  }
  const cfg = loadConfig();
  const dryRun = !!arg(argv, "dry-run");
  const concurrency = Math.max(1, intEnv("LEGAL_LOAD_CONCURRENCY", DEFAULTS.concurrency));
  const chunkSize = Math.max(1, intEnv("LEGAL_LOAD_CHUNK_SIZE", DEFAULTS.chunkSize));
  const progressEvery = Math.max(1, intEnv("LEGAL_LOAD_PROGRESS_EVERY", DEFAULTS.progressEvery));
  const partTimeoutMs = Math.max(1000, intEnv("LEGAL_LOAD_PART_TIMEOUT_MS", DEFAULTS.partTimeoutMs));
  const partRetries = intEnv("LEGAL_LOAD_PART_RETRIES", DEFAULTS.partRetries);
  const started = Date.now();
  const secs = (ms) => (ms / 1000).toFixed(1);
  // Progress goes to stderr so stdout stays a single parseable summary JSON.
  const log = (message) => console.error(`[${source}] ${message}`);

  const s3 = createS3({
    endpoint: cfg.s3Endpoint,
    accessKey: cfg.s3AccessKey,
    secretKey: cfg.s3SecretKey,
    region: cfg.s3Region,
  });
  const prefix = structuredPrefix(String(source));
  const objects = [];
  let token;
  for (;;) {
    const page = await s3.listObjects(cfg.lawsBucket, { prefix, continuationToken: token });
    objects.push(...page.contents.filter((o) => o.key.endsWith(".jsonl")));
    if (!page.truncated) break;
    token = page.continuationToken;
  }
  objects.sort((a, b) => a.key.localeCompare(b.key));
  const listedBytes = objects.reduce((sum, o) => sum + (Number(o.size) || 0), 0);
  log(`listed ${objects.length} structured part(s), ${(listedBytes / 1048576).toFixed(1)} MB, in ${secs(Date.now() - started)}s`);

  // Fold every historical run's parts in key order (later run wins per
  // source_id; incremental runs only carry changed rows, so dropping old parts
  // would lose entries). Downloads overlap up to `concurrency`, but folding
  // stays ordered and at most `concurrency` part buffers are resident, so the
  // full 136 MB gov prefix is never held in memory at once.
  const folded = new Map();
  let recordsRead = 0;
  let bytes = 0;
  let malformed = 0;
  let downloaded = 0;
  const window = [];
  const takeOne = async () => {
    const part = await window.shift();
    for (const line of part.buf.toString("utf8").split("\n").filter(Boolean)) {
      try {
        const record = JSON.parse(line);
        folded.set(`${record.source}\u0000${record.source_id}`, record);
        recordsRead++;
      } catch {
        // A torn final line is tolerable; row-level hashes keep a malformed
        // line from being silently promoted to a database row.
        malformed++;
        console.error(`[${source}] skipped malformed line in ${part.key}`);
      }
    }
    bytes += part.buf.length;
    downloaded++;
    if (downloaded % progressEvery === 0 || downloaded === objects.length) {
      log(`downloaded ${downloaded}/${objects.length} part(s), ${(bytes / 1048576).toFixed(1)} MB, folded ${folded.size} unique record(s), ${secs(Date.now() - started)}s`);
    }
  };
  try {
    for (const object of objects) {
      if (window.length >= concurrency) await takeOne();
      const promise = s3
        .getObject(cfg.lawsBucket, object.key, { timeoutMs: partTimeoutMs, retries: partRetries })
        .then((buf) => ({ key: object.key, buf }));
      // A failed part is rethrown when its turn in key order arrives; handlers
      // on siblings keep them from surfacing as unhandled rejections meanwhile.
      promise.catch(() => {});
      window.push(promise);
    }
    while (window.length) await takeOne();
  } catch (err) {
    await Promise.allSettled(window);
    throw err;
  }

  const records = [...folded.values()];
  if (!records.length) throw new Error(`no structured records under ${cfg.lawsBucket}/${prefix}`);
  log(`folded ${recordsRead} line(s) into ${records.length} record(s) from ${objects.length} part(s) in ${secs(Date.now() - started)}s`);

  const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
  await client.connect();
  try {
    const guardTables = arg(argv, "no-guard") ? [] : ["laws", "law_chunks"];
    const result = await loadLegalDocuments(client, records, {
      dryRun,
      guardTables,
      chunkSize,
      onProgress: ({ chunk, chunks, rows, inserted, updated, skippedUnchanged }) =>
        log(`write chunk ${chunk}/${chunks}: ${rows} row(s) upserted (inserted=${inserted}, updated=${updated}, unchanged=${skippedUnchanged})`),
    });
    const summary = {
      mode: dryRun ? "dry-run" : "load",
      source,
      prefix,
      partFiles: objects.length,
      recordsRead,
      ...result,
    };
    console.log(JSON.stringify(summary, null, 1));
    if (!result.guard.unchanged) throw new Error("existing corpora moved during legal_documents load");
    log(`done in ${secs(Date.now() - started)}s (parts=${objects.length}, bytes=${bytes}, folded=${records.length}, malformed=${malformed})`);
    return summary;
  } finally {
    await client.end();
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  return entry && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  try {
    await main({ argv: process.argv.slice(2) });
  } catch (err) {
    console.error(`[legal-source-load] FATAL: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}