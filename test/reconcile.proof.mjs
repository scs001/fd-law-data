#!/usr/bin/env node
// Proof for scripts/reconcile-law-db.mjs on a throwaway schema: builds a
// miniature corpus with duplicate generations and chunk rows, runs the REAL
// script (dry-run -> execute -> re-execute) and asserts convergence,
// re-pointing, archiving, and idempotency. Drops the schema afterwards.
// Manual run (not part of npm test): node test/reconcile.proof.mjs
// Requires law_db write access (data-machine credentials in .env).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "../lib/config.js";

const cfg = loadConfig();
const schema = `reconcile_proof_${process.pid}`;
const script = join(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "reconcile-law-db.mjs");
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
await client.connect();

const runScript = (extra = []) => {
  const out = execFileSync(process.execPath, [script, "--schema", schema, ...extra], {
    encoding: "utf8",
  });
  return JSON.parse(out.trim().split("\n").pop());
};
const q = async (sql, params) => (await client.query(sql, params)).rows;

try {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);

  // Minimal tables mirroring the real DDL the script relies on.
  await client.query(`CREATE TABLE ${schema}.laws (
    id bigserial PRIMARY KEY, src_db varchar(16), src_id bigint, source_id varchar(64),
    category varchar(16), title varchar(512), publish varchar(32), expiry varchar(32),
    type varchar(32), status varchar(16), file_path varchar(512), content text,
    content_status varchar(16), quality_flag varchar(32), source_note text,
    created_at timestamptz DEFAULT now())`);
  for (const t of ["law_chunks", "law_chunks_v2"]) {
    await client.query(`CREATE TABLE ${schema}.${t} (
      chunk_id varchar(48) PRIMARY KEY, law_id bigint NOT NULL, chunk_no integer NOT NULL,
      chunk_text text, char_start integer, char_end integer, category varchar(16),
      title varchar(512), publish varchar(32), embedded boolean DEFAULT false,
      created_at timestamptz DEFAULT now(), UNIQUE (law_id, chunk_no))`);
  }

  // A: three generations; flk survivor is bare, lawv2 (better removed rank)
  //    supplies the re-point, law's chunks are deleted.
  // B: survivor (flk) owns chunks; the lawv2 duplicate's chunks are deleted.
  // C: singleton with a synonym category -> normalized.
  // D: duplicate without chunks on either side -> no chunk action.
  await client.query(`INSERT INTO ${schema}.laws (src_db, src_id, category, title, status, publish, content) VALUES
    ('law','1','法律','甲法','有效','2016-11-07','law-body-a'),
    ('lawv2','2','法律','甲法','有效','2016-11-07','lawv2-body-a'),
    ('flk','3','法律','甲法','已修改','2025-10-28','flk-body-a'),
    ('flk','4','行政法规','乙条例','有效','2020-01-01','flk-body-b'),
    ('lawv2','5','行政法规','乙条例','有效','2019-01-01','lawv2-body-b'),
    ('law','6','地方法规','丙条例','有效','2018-01-01','law-body-c'),
    ('lawv2','7','司法解释','丁解释','有效','2017-01-01','lawv2-body-d'),
    ('law','8','司法解释','丁解释','有效','2017-01-01','law-body-d')`);

  const idOf = async (srcDb, srcId) =>
    (await q(`SELECT id FROM ${schema}.laws WHERE src_db=$1 AND src_id=$2`, [srcDb, srcId]))[0].id;
  const A = { law: await idOf("law", 1), lawv2: await idOf("lawv2", 2), flk: await idOf("flk", 3) };
  const B = { flk: await idOf("flk", 4), lawv2: await idOf("lawv2", 5) };

  const chunk = async (table, lawId, nos) => {
    for (const n of nos) {
      await client.query(
        `INSERT INTO ${schema}.${table} (chunk_id, law_id, chunk_no, chunk_text) VALUES ($1,$2,$3,$4)`,
        [`${lawId}:${n}`, lawId, n, `text-${lawId}-${n}`],
      );
    }
  };
  await chunk("law_chunks", A.law, [0, 1]);
  await chunk("law_chunks_v2", A.law, [0, 1]);
  await chunk("law_chunks", A.lawv2, [0, 1, 2]);
  await chunk("law_chunks_v2", A.lawv2, [0, 1, 2]);
  await chunk("law_chunks", B.flk, [0]);
  await chunk("law_chunks_v2", B.flk, [0]);
  await chunk("law_chunks", B.lawv2, [0, 1]);
  await chunk("law_chunks_v2", B.lawv2, [0, 1]);

  const before = {
    laws: (await q(`SELECT count(*)::int n FROM ${schema}.laws`))[0].n,
    chunks: (await q(
      `SELECT (SELECT count(*)::int FROM ${schema}.law_chunks)
            + (SELECT count(*)::int FROM ${schema}.law_chunks_v2) n`,
    ))[0].n,
  };

  // ---- 1. dry-run: report only, nothing written -------------------------
  const dry = runScript();
  assert.equal(dry.mode, "dry-run");
  assert.equal(dry.deleteIds, 4, "A:2 + B:1 + D:1 rows to delete");
  assert.equal(dry.categoryUpdates, 1, "C normalized");
  assert.equal(dry.repoints, 2, "A re-points one source per chunk table");
  assert.deepEqual(
    { v1: dry.chunkDeletes.law_chunks, v2: dry.chunkDeletes.law_chunks_v2 },
    { v1: 2, v2: 2 },
    "A.law and B.lawv2 lose chunks in both tables",
  );
  const afterDry = {
    laws: (await q(`SELECT count(*)::int n FROM ${schema}.laws`))[0].n,
    chunks: (await q(
      `SELECT (SELECT count(*)::int FROM ${schema}.law_chunks)
            + (SELECT count(*)::int FROM ${schema}.law_chunks_v2) n`,
    ))[0].n,
  };
  assert.deepEqual(afterDry, before, "dry-run must not write");

  // ---- 2. execute: archive + converge -----------------------------------
  const exec = runScript(["--execute"]);
  assert.equal(exec.mode, "execute");
  assert.ok(exec.archiveTable.endsWith(`laws_dup_archive_${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`));

  const survivors = await q(`SELECT title, src_db, category FROM ${schema}.laws ORDER BY id`);
  assert.deepEqual(
    survivors.map((r) => [r.title, r.src_db, r.category]),
    [
      ["甲法", "flk", "法律"],
      ["乙条例", "flk", "行政法规"],
      ["丙条例", "law", "地方性法规"],
      ["丁解释", "lawv2", "司法解释"],
    ],
  );

  // re-pointed chunks: A.lawv2's chunks now belong to A.flk, ids rewritten
  const aChunks = await q(
    `SELECT chunk_id, chunk_no, chunk_text FROM ${schema}.law_chunks WHERE law_id = $1 ORDER BY chunk_no`,
    [A.flk],
  );
  assert.deepEqual(aChunks.map((r) => r.chunk_id), [`${A.flk}:0`, `${A.flk}:1`, `${A.flk}:2`]);
  assert.equal(aChunks[0].chunk_text, `text-${A.lawv2}-0`, "chunk text is preserved, not re-chunked");
  const aChunksV2 = await q(
    `SELECT count(*)::int n FROM ${schema}.law_chunks_v2 WHERE law_id = $1`,
    [A.flk],
  );
  assert.equal(aChunksV2[0].n, 3);

  // deleted chunks: A.law and B.lawv2 own nothing any more
  for (const table of ["law_chunks", "law_chunks_v2"]) {
    const orphans = await q(
      `SELECT count(*)::int n FROM ${schema}.${table} c
        LEFT JOIN ${schema}.laws l ON l.id = c.law_id WHERE l.id IS NULL`,
    );
    assert.equal(orphans[0].n, 0, `${table}: no orphan chunks`);
    const bSurvivorChunks = await q(
      `SELECT count(*)::int n FROM ${schema}.${table} WHERE law_id = $1`, [B.flk],
    );
    assert.equal(bSurvivorChunks[0].n, 1, `${table}: survivor keeps its own chunks only`);
  }

  // archive holds exactly the removed rows, with full columns
  const archived = await q(`SELECT id, src_db, title, content FROM ${exec.archiveTable} ORDER BY id`);
  assert.equal(archived.length, 4);
  assert.deepEqual(archived.map((r) => r.src_db).sort(), ["law", "law", "lawv2", "lawv2"]);
  assert.ok(archived.every((r) => r.content), "archive keeps the content column");

  // ---- 3. re-execute: idempotent ----------------------------------------
  const again = runScript(["--execute"]);
  assert.equal(again.deleteIds, 0);
  assert.equal(again.categoryUpdates, 0);
  assert.equal(again.repoints, 0);
  const finalLaws = (await q(`SELECT count(*)::int n FROM ${schema}.laws`))[0].n;
  assert.equal(finalLaws, 4);

  console.log(JSON.stringify({ proof: "ok", schema, survivors: finalLaws, archived: archived.length }));
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}
