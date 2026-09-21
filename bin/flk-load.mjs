#!/usr/bin/env node
// Data-machine loader for flk daily JSONL: laws INSERT (idempotent) ->
// law_chunks -> per-day incremental export shards for the embed workers.
// Runs where law_db is reachable; never exposes PG.
//
// Export design note (design.md D5, verified 2026-09-18): the `embedded`
// column is NOT maintained by the historical pipeline (all 707,538 v1 rows
// sit at false despite being in Qdrant; claims/completed markers are the real
// ledger). Incremental export is therefore provenance-scoped — one shard
// `incr-YYYY-MM-DD.jsonl` per daily file, containing exactly that day's flk
// law chunks, skipped when the shard already exists.
import pg from "pg";
import { createHash } from "node:crypto";
import { loadConfig } from "../lib/config.js";
import { createS3, putIfChanged } from "../lib/s3.js";
import { chunkLawText, normalizeLawText, V2_PARAMS } from "../lib/flk/chunk.js";
import { fitCategory } from "../lib/flk/api.js";
import { findCrossGenerationDuplicate, resolveBatchCategory } from "../lib/law/identity.js";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
await client.connect();

async function listAll(bucket, prefix) {
  const out = [];
  let token;
  for (;;) {
    const page = await s3.listObjects(bucket, { prefix, continuationToken: token });
    out.push(...page.contents);
    if (!page.truncated) break;
    token = page.continuationToken;
  }
  return out;
}

async function listDailyFiles(bucket) {
  return (await listAll(bucket, "incremental/"))
    .filter((c) => /^incremental\/\d{4}\/\d{2}\/flk-\d{4}-\d{2}-\d{2}(-part\d+)?\.jsonl$/.test(c.key))
    .map((c) => c.key)
    .sort();
}

// The embed pipeline discovers work through a manifest (manifest_v2.json lists
// the 225 full-corpus shards), so incremental shards are published the same way
// in incr-manifest.json. Row counts are tracked in a small sidecar index so the
// manifest never needs to re-read multi-MB shards; index misses fall back to
// counting the shard once.
const EXPORT_INDEX_KEY = "incremental/export-index.json";

async function publishIncrementalManifest(index) {
  const shards = [];
  for (const o of await listAll(cfg.exportBucket, "incr-")) {
    if (!o.key.endsWith(".jsonl")) continue;
    let rows = index[o.key];
    if (!Number.isFinite(rows)) {
      const buf = await s3.getObject(cfg.exportBucket, o.key);
      rows = buf ? buf.toString("utf8").split("\n").filter(Boolean).length : 0;
      index[o.key] = rows;
    }
    shards.push({ shard: o.key, rows });
  }
  shards.sort((a, b) => a.shard.localeCompare(b.shard));
  const manifest = {
    shards,
    total_rows: shards.reduce((a, s) => a + s.rows, 0),
    rows_per_shard: 2000,
    point_id_rule: "law_id * 1048576 + chunk_no",
    source: "flk-incremental",
    exported_at: new Date().toISOString(),
  };
  await s3.putObject(cfg.exportBucket, "incr-manifest.json", JSON.stringify(manifest, null, 1), { contentType: "application/json" });
  await s3.putObject(cfg.lawsBucket, EXPORT_INDEX_KEY, JSON.stringify(index, null, 1), { contentType: "application/json" });
  console.error(`[flk-load] incr-manifest.json: ${shards.length} shard(s), ${manifest.total_rows} rows`);
}

async function baseRowCount() {
  const { rows } = await client.query("SELECT count(*)::bigint AS n FROM laws WHERE src_db IN ('law','lawv2')");
  return Number(rows[0].n);
}

const files = await listDailyFiles(cfg.lawsBucket);
const todo = [];
for (const key of files) {
  const markerKey = `incremental/processed/${key.replace(/\//g, "_")}.done`;
  const markerBuf = await s3.getObject(cfg.lawsBucket, markerKey);
  const fileBuf = await s3.getObject(cfg.lawsBucket, key);
  if (!fileBuf) continue;
  const digest = sha256(fileBuf);
  let marker = null;
  try {
    marker = markerBuf ? JSON.parse(markerBuf.toString("utf8")) : null;
  } catch {
    marker = null;
  }
  // Reprocess when the marker predates content hashing, or the file changed
  // (backfill appended to the same day, or retry-pending rewrote records).
  if (marker?.sha256 === digest) continue;
  todo.push({ key, markerKey, fileBuf, digest, reprocess: !!marker });
}
console.error(`[flk-load] ${todo.length} daily file(s) to process`);

const dryRun = !!arg("dry-run");
const beforeBase = await baseRowCount();
const exportIndex = dryRun || arg("no-export") ? {} : await (async () => {
  const buf = await s3.getObject(cfg.lawsBucket, EXPORT_INDEX_KEY);
  try {
    return buf ? JSON.parse(buf.toString("utf8")) : {};
  } catch {
    return {};
  }
})();
let totalInserted = 0;
let totalChunks = 0;
let totalShards = 0;
let totalSkippedDuplicate = 0;

for (const { key, markerKey, fileBuf, digest, reprocess } of todo) {
  const base = key.match(/flk-(\d{4}-\d{2}-\d{2}(?:-part\d+)?)\.jsonl$/)[1];
  const buf = fileBuf;
  const records = buf.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // ---- 1. catalog insert (skip already-present source_ids) ----
  const sourceIds = records.map((r) => r.source_id);
  const existing = new Set(
    (await client.query("SELECT source_id FROM laws WHERE src_db = 'flk' AND source_id = ANY($1)", [sourceIds]))
      .rows.map((r) => r.source_id),
  );
  const fileLawIds = new Map(); // source_id -> law id (all rows of this file in PG)
  let upgraded = 0;
  let skippedDuplicate = 0;
  for (const rec of records) {
    if (existing.has(rec.source_id)) {
      // A retry-pending re-crawl rewrites a record that first landed without
      // body text. Only that upgrade may touch an existing row — every other
      // field of an already-inserted law stays exactly as it was.
      if (rec.content_status === "ok" && !dryRun) {
        const res = await client.query(
          `UPDATE laws SET content = $2, content_status = 'ok'
           WHERE src_db = 'flk' AND source_id = $1 AND content_status <> 'ok'
           RETURNING id`,
          [rec.source_id, normalizeLawText(rec.content)],
        );
        if (res.rows[0]) upgraded++;
      }
      continue;
    }
    // law-db-hygiene D6: never re-insert a law that already lives in another
    // generation with a real-law category and 有效 status.
    if (await findCrossGenerationDuplicate(client, { title: rec.title })) {
      skippedDuplicate++;
      continue;
    }
    if (dryRun) {
      totalInserted++;
      continue;
    }
    // varchar ceilings: category 16 (flk leaf names can exceed — fitted to the
    // top-level group), type 32, status 16, title 512, file_path 512
    // (percent-encoding inflates CJK ~9x). Defensive for files written by
    // earlier crawler versions.
    const category = await resolveBatchCategory(client, {
      title: rec.title,
      category: fitCategory(rec.category, rec.flfgCodeId),
    });
    const type = rec.type ? String(rec.type).slice(0, 32) : null;
    const status = rec.status ? String(rec.status).slice(0, 16) : null;
    const title = String(rec.title ?? "").slice(0, 512);
    const filePath = rec.file_path ? String(rec.file_path).slice(0, 512) : null;
    const content = rec.content ? normalizeLawText(rec.content) : rec.content;
    const qualityFlag = rec.quality_flag || (filePath && rec.file_path && filePath !== rec.file_path ? "long-path" : null);
    const res = await client.query(
      `INSERT INTO laws (src_db, src_id, source_id, category, title, publish, expiry, type, status,
                         file_path, content, content_status, quality_flag, source_note)
       VALUES ('flk',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'flk-incremental')
       ON CONFLICT (src_db, src_id) DO NOTHING
       RETURNING id`,
      [rec.src_id, rec.source_id, category, title, rec.publish, rec.expiry, type, status,
       filePath, content, rec.content_status, qualityFlag],
    );
    if (res.rows[0]) totalInserted++;
  }
  // map every record to its law id (inserted now or earlier)
  const idRows = (
    await client.query("SELECT id, source_id FROM laws WHERE src_db = 'flk' AND source_id = ANY($1)", [sourceIds])
  ).rows;
  for (const r of idRows) fileLawIds.set(r.source_id, r.id);
  console.error(`[flk-load] ${key}: ${records.length} record(s), ${fileLawIds.size} in PG${upgraded ? `, ${upgraded} upgraded` : ""}${skippedDuplicate ? `, ${skippedDuplicate} duplicate skip(s)` : ""}`);
  totalSkippedDuplicate += skippedDuplicate;

  // ---- 2. chunks for every ok-content law of this file lacking them ----
  // Two generations coexist (storage doc §1.2): law_chunks (v1, 200-450) kept
  // for schema parity, and law_chunks_v2, the LIVE semantic layer — Qdrant's
  // active collection is law_chunks_v2 (verified 2026-09-19 at
  // 100.64.0.9:6333, 448,187 points, 1024-dim). Export shards come from v2.
  // Chunking runs on the normalized text so new rows match the legacy corpus;
  // the stored content is normalized with it, keeping offsets meaningful.
  if (!arg("no-chunks") && !dryRun) {
    const laws = (
      await client.query(
        `SELECT id, content, category, title, publish FROM laws
         WHERE src_db = 'flk' AND id = ANY($1) AND content_status = 'ok'`,
        [[...fileLawIds.values()]],
      )
    ).rows;
    let normalizedNow = 0;
    for (const law of laws) {
      const text = normalizeLawText(law.content);
      if (!text) continue;
      if (text !== law.content) {
        await client.query("UPDATE laws SET content = $2 WHERE id = $1", [law.id, text]);
        normalizedNow++;
      }
      for (const [table, params] of [["law_chunks", {}], ["law_chunks_v2", V2_PARAMS]]) {
        const have = await client.query(`SELECT count(*)::int n FROM ${table} WHERE law_id = $1`, [law.id]);
        if (have.rows[0].n > 0) continue; // deterministic chunker; already chunked
        const chunks = chunkLawText(text, params);
        for (const c of chunks) {
          await client.query(
            `INSERT INTO ${table} (chunk_id, law_id, chunk_no, chunk_text, char_start, char_end, category, title, publish, embedded)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)
             ON CONFLICT (law_id, chunk_no) DO NOTHING`,
            [`${law.id}:${c.chunk_no}`, law.id, c.chunk_no, c.chunk_text, c.char_start, c.char_end, law.category, law.title, law.publish],
          );
          totalChunks++;
        }
      }
    }
    if (normalizedNow) console.error(`[flk-load] ${key}: normalized content of ${normalizedNow} law(s)`);
  }

  // ---- 3. per-day export shards, <=2000 rows each (matches the historical
  // sh-*.jsonl shard size; a single 20MB+ shard stalled past the 60s PUT
  // timeout and crashed the loader — hit live 2026-09-18) ----
  if (!arg("no-export") && !dryRun) {
    const { rows } = await client.query(
      `SELECT c.chunk_id, c.law_id, c.chunk_no, c.chunk_text, c.char_start, c.char_end,
              l.category, l.title, l.publish, l.type AS law_type, l.status AS law_status
       FROM law_chunks_v2 c JOIN laws l ON l.id = c.law_id
       WHERE c.law_id = ANY($1)
       ORDER BY c.law_id, c.chunk_no`,
      [[...fileLawIds.values()]],
    );
    if (rows.length) {
      const lines = rows.map((r) => {
        if (r.chunk_no >= 1048576) throw new Error(`chunk_no overflow for ${r.chunk_id}`);
        return JSON.stringify({
          point_id: r.law_id * 1048576 + r.chunk_no,
          chunk_id: r.chunk_id,
          law_id: r.law_id,
          chunk_no: r.chunk_no,
          char_start: r.char_start,
          char_end: r.char_end,
          chunk_text: r.chunk_text,
          payload: {
            law_id: r.law_id, chunk_no: r.chunk_no, chunk_text: r.chunk_text,
            category: r.category, title: r.title, publish: r.publish,
            law_type: r.law_type, law_status: r.law_status,
          },
        });
      });
      const PART = 2000;
      const shardCount = Math.ceil(lines.length / PART);
      for (let part = 0; part < shardCount; part++) {
        const shardKey = `incr-${base}-${String(part).padStart(5, "0")}.jsonl`;
        const slice = lines.slice(part * PART, (part + 1) * PART);
        await s3.putObject(cfg.exportBucket, shardKey, slice.join("\n") + "\n", {
          contentType: "application/x-ndjson",
          timeoutMs: 120000,
        });
        exportIndex[shardKey] = slice.length;
        totalShards++;
      }
      console.error(`[flk-load] shards written: ${shardCount} (${rows.length} rows)`);
    }
    // remove the legacy single-file shard from earlier versions (pure-date name)
    const legacyKey = `incr-${base.replace(/-part\d+$/, "")}.jsonl`;
    if (await s3.headObject(cfg.exportBucket, legacyKey)) {
      await s3.deleteObject(cfg.exportBucket, legacyKey);
      console.error(`[flk-load] removed legacy shard: ${legacyKey}`);
    }
    delete exportIndex[legacyKey];
  }

  // ---- 4. processed marker last: file is fully handled ----
  if (!dryRun) {
    await putIfChanged(
      s3,
      cfg.lawsBucket,
      markerKey,
      JSON.stringify({ file: key, records: records.length, sha256: digest, processedAt: new Date().toISOString() }),
      { contentType: "application/json" },
    );
  }
}

if (!dryRun) {
  const afterBase = await baseRowCount();
  if (afterBase !== beforeBase) throw new Error(`[flk-load] FATAL: law/lawv2 row count changed ${beforeBase} -> ${afterBase}`);
  if (!arg("no-export") && todo.length) await publishIncrementalManifest(exportIndex);
}

await client.end();
console.log(JSON.stringify({ files: todo.length, insertedLaws: totalInserted, skippedDuplicates: totalSkippedDuplicate, chunks: totalChunks, exportShards: totalShards, dryRun }));
