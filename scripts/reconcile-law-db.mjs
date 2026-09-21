#!/usr/bin/env node
// law-db-hygiene: collapse law_db.laws to one authoritative row per exact
// title. Dry-run by default; --execute archives the removed rows and applies
// the whole plan in ONE transaction. Chunks are re-pointed or deleted (never
// re-chunked); vectors are moved afterwards by scripts/qdrant-move-chunks.mjs
// — the embedding API is never called here. Runs where law_db is reachable
// (the data machine); credentials come from .env only.
import pg from "pg";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../lib/config.js";
import { CHUNK_TABLES, planReconciliation } from "../lib/law/reconcile.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const cfg = loadConfig();
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
await client.connect();
// The reconciliation is a one-shot maintenance run; the loader's per-statement
// timeout would abort a legitimate multi-second UPDATE.
await client.query("SET statement_timeout = 0");

const execute = !!arg("execute");
// Scratch-schema support for test/reconcile.proof.mjs; default is production.
const schema = String(arg("schema", "public"));
const T = (name) => `${schema}.${name}`;
const stamp = new Date().toISOString().slice(0, 10).replaceAll("-", "");
const archiveTable = T(`laws_dup_archive_${stamp}`);

// ---- plan (light columns only; content is not needed to choose survivors) --
const { rows: laws } = await client.query(
  `SELECT id, src_db, title, category, status, publish FROM ${T("laws")}`,
);
const hasChunks = {};
for (const table of CHUNK_TABLES) {
  const { rows } = await client.query(`SELECT DISTINCT law_id FROM ${T(table)}`);
  hasChunks[table] = new Set(rows.map((r) => String(r.law_id)));
}

const plan = planReconciliation({ laws, hasChunks });
const r = plan.report;
console.error(
  `[reconcile] ${laws.length} rows, ${r.titles} distinct titles, ${r.duplicatedTitles} duplicated`,
);
console.error(`[reconcile] survivors by generation: ${JSON.stringify(r.survivorsByGeneration)}`);
console.error(
  `[reconcile] rows to delete: ${plan.deleteIds.length} ${JSON.stringify(r.deletedByGeneration)}`,
);
console.error(`[reconcile] category updates: ${plan.categoryUpdates.length}`);
for (const u of plan.categoryUpdates.slice(0, 20)) {
  console.error(`    id=${u.id}: ${u.from} -> ${u.to}`);
}
if (plan.categoryUpdates.length > 20) {
  console.error(`    ... ${plan.categoryUpdates.length - 20} more`);
}
for (const table of CHUNK_TABLES) {
  const repoints = plan.repoints.filter((x) => x.table === table);
  const deletes = plan.chunkDeletes[table];
  console.error(
    `[reconcile] ${table}: re-point chunks of ${repoints.length} law(s), delete chunks of ${deletes.length} law(s)`,
  );
  for (const x of repoints.slice(0, 10)) {
    console.error(`    ${x.fromId} -> ${x.toId}`);
  }
  if (repoints.length > 10) console.error(`    ... ${repoints.length - 10} more`);
}

const summary = {
  mode: execute ? "execute" : "dry-run",
  rows: laws.length,
  titles: r.titles,
  duplicatedTitles: r.duplicatedTitles,
  deleteIds: plan.deleteIds.length,
  categoryUpdates: plan.categoryUpdates.length,
  repoints: plan.repoints.length,
  chunkDeletes: {
    law_chunks: plan.chunkDeletes.law_chunks.length,
    law_chunks_v2: plan.chunkDeletes.law_chunks_v2.length,
  },
};

// Bridge to scripts/qdrant-move-chunks.mjs: unique re-point pairs plus the
// law ids whose points must be DELETED (re-point sources move instead, so
// they are excluded from the delete list).
const planOut = arg("plan-out");
if (planOut) {
  const repointPairs = new Map();
  for (const x of plan.repoints) repointPairs.set(String(x.fromId), String(x.toId));
  const deleteLawIds = plan.deleteIds.map(String).filter((id) => !repointPairs.has(id));
  writeFileSync(
    String(planOut),
    JSON.stringify(
      { repoints: [...repointPairs].map(([fromId, toId]) => ({ fromId, toId })), deleteLawIds },
      null,
      1,
    ),
  );
  console.error(
    `[reconcile] plan written to ${planOut}: ${repointPairs.size} re-point pair(s), ${deleteLawIds.length} deletion(s)`,
  );
}

if (!execute) {
  console.error("[reconcile] dry-run: nothing written (pass --execute to apply)");
  console.log(JSON.stringify(summary));
  await client.end();
  process.exit(0);
}

if (!plan.deleteIds.length && !plan.categoryUpdates.length) {
  console.error("[reconcile] nothing to do (already converged)");
  console.log(JSON.stringify(summary));
  await client.end();
  process.exit(0);
}

// ---- execute: archive + apply, one transaction ---------------------------
await client.query("BEGIN");
try {
  await client.query(
    `CREATE TABLE ${archiveTable} AS SELECT * FROM ${T("laws")} WHERE id = ANY($1)`,
    [plan.deleteIds],
  );

  // Batched VALUES-join update: one round trip per 1000 rows matters over the
  // tailnet link (individual statements would stretch the transaction by
  // minutes).
  for (let i = 0; i < plan.categoryUpdates.length; i += 1000) {
    const batch = plan.categoryUpdates.slice(i, i + 1000);
    const values = batch.map((_, j) => `($${j * 2 + 1}::bigint, $${j * 2 + 2}::varchar)`).join(", ");
    await client.query(
      `UPDATE ${T("laws")} l SET category = v.cat FROM (VALUES ${values}) AS v(id, cat) WHERE l.id = v.id`,
      batch.flatMap((u) => [u.id, u.to]),
    );
  }

  // Re-point via a temp map so each table is touched in one pass. One source
  // law produces one plan entry per chunk table — collapse by from_id first
  // (the same law cannot belong to two title groups, so to_id is a function
  // of from_id). chunk_id is `law_id:chunk_no` in both tables (verified
  // 2026-09-20); text and offsets are untouched.
  const repointMap = new Map();
  for (const x of plan.repoints) repointMap.set(String(x.fromId), x.toId);
  await client.query(
    "CREATE TEMP TABLE repoint_map (from_id bigint PRIMARY KEY, to_id bigint NOT NULL) ON COMMIT DROP",
  );
  const pairs = [...repointMap.entries()];
  for (let i = 0; i < pairs.length; i += 1000) {
    const batch = pairs.slice(i, i + 1000);
    const values = batch.map((_, j) => `($${j * 2 + 1}, $${j * 2 + 2})`).join(", ");
    await client.query(
      `INSERT INTO repoint_map (from_id, to_id) VALUES ${values}`,
      batch.flat(),
    );
  }
  for (const table of CHUNK_TABLES) {
    await client.query(
      `UPDATE ${T(table)} c SET law_id = m.to_id, chunk_id = m.to_id || ':' || c.chunk_no
       FROM repoint_map m WHERE c.law_id = m.from_id`,
    );
  }

  for (const table of CHUNK_TABLES) {
    if (plan.chunkDeletes[table].length) {
      await client.query(`DELETE FROM ${T(table)} WHERE law_id = ANY($1)`, [
        plan.chunkDeletes[table],
      ]);
    }
  }

  await client.query(`DELETE FROM ${T("laws")} WHERE id = ANY($1)`, [plan.deleteIds]);
  await client.query("COMMIT");
  console.error(`[reconcile] applied; removed rows archived in ${archiveTable}`);
  console.log(JSON.stringify({ ...summary, archiveTable }));
} catch (err) {
  await client.query("ROLLBACK");
  console.error(`[reconcile] rolled back: ${err.message}`);
  throw err;
} finally {
  await client.end();
}
