#!/usr/bin/env node
// Maintenance pass: re-normalize flk content and rebuild law_chunks /
// law_chunks_v2 from it. Needed once after the 2026-09-19 finding that the
// backfill's docx extraction carried Word layout whitespace (54.6% of all
// characters, versus 4.5% in the legacy corpus) and that the first v2 chunk
// parameters (300-1200, cap 4000) produced chunks 3.3x the live corpus median.
// Idempotent: re-running it rebuilds the same deterministic chunks, and it
// drops the derived incremental exports so the next loader run regenerates them.
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { chunkLawText, normalizeLawText, V2_PARAMS } from "../lib/flk/chunk.js";

const dryRun = process.argv.includes("--dry-run");
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

const laws = (
  await client.query(
    `SELECT id, content, category, title, publish FROM laws
     WHERE src_db = 'flk' AND content_status = 'ok' AND content IS NOT NULL ORDER BY id`,
  )
).rows;
console.error(`[flk-rechunk] ${laws.length} flk law(s) with content`);

let normalized = 0;
let chunks = 0;
let done = 0;
for (const law of laws) {
  const text = normalizeLawText(law.content);
  if (!text) continue;
  if (text !== law.content) {
    normalized++;
    if (!dryRun) await client.query("UPDATE laws SET content = $2 WHERE id = $1", [law.id, text]);
  }
  if (!dryRun) {
    await client.query("DELETE FROM law_chunks WHERE law_id = $1", [law.id]);
    await client.query("DELETE FROM law_chunks_v2 WHERE law_id = $1", [law.id]);
  }
  for (const [table, params] of [["law_chunks", {}], ["law_chunks_v2", V2_PARAMS]]) {
    if (dryRun) continue;
    for (const c of chunkLawText(text, params)) {
      await client.query(
        `INSERT INTO ${table} (chunk_id, law_id, chunk_no, chunk_text, char_start, char_end, category, title, publish, embedded)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,false)`,
        [`${law.id}:${c.chunk_no}`, law.id, c.chunk_no, c.chunk_text, c.char_start, c.char_end, law.category, law.title, law.publish],
      );
      chunks++;
    }
  }
  if (++done % 200 === 0) console.error(`[flk-rechunk] ${done}/${laws.length}, ${chunks} chunks, ${normalized} normalized`);
}

// Exports built from the discarded chunks are stale — drop the markers and the
// incremental shards so the next loader run rebuilds them from the new rows.
let deletedMarkers = 0;
let deletedShards = 0;
if (!dryRun) {
  for (const o of await listAll(cfg.lawsBucket, "incremental/processed/")) {
    if (!o.key.includes("flk-")) continue;
    await s3.deleteObject(cfg.lawsBucket, o.key);
    deletedMarkers++;
  }
  for (const o of await listAll(cfg.exportBucket, "incr-")) {
    await s3.deleteObject(cfg.exportBucket, o.key);
    deletedShards++;
  }
}

console.log(JSON.stringify({ laws: laws.length, normalized, chunks, deletedMarkers, deletedShards, dryRun }));
await client.end();
