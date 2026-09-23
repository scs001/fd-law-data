#!/usr/bin/env node
// Transactional proof for db/001_legal_documents.sql. Everything is created in
// a temporary schema under an outer transaction and rolled back, so this proves
// the DDL and unique conflict behavior without mutating law_db.
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sql = readFileSync(join(pkgRoot, "db", "001_legal_documents.sql"), "utf8");
const schema = `legal_documents_verify_${Date.now()}`;
const cfg = loadConfig();
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });

await client.connect();
try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query("SET LOCAL search_path = " + schema);
  // The migration is deliberately one multi-statement string: comments and
  // prose make naive semicolon splitting unsafe.
  await client.query(sql);

  const insert = `INSERT INTO legal_documents
    (source, source_id, doc_type, title, content_hash, source_url)
    VALUES ($1,$2,$3,$4,$5,$6)`;
  await client.query(insert, ["proof-source", "same-id", "case", "Proof", "hash-1", "https://example.test/1"]);
  let uniqueWorked = false;
  try {
    await client.query(insert, ["proof-source", "same-id", "case", "Duplicate", "hash-2", "https://example.test/2"]);
  } catch (err) {
    if (err.code !== "23505" && !/duplicate key value|unique constraint/i.test(err.message)) throw err;
    uniqueWorked = true;
  }
  if (!uniqueWorked) throw new Error("(source, source_id) unique constraint did not reject a duplicate");
  await client.query("ROLLBACK");

  const searchPath = await client.query("SHOW search_path");
  console.log(JSON.stringify({
    ok: true,
    schema,
    rolledBack: true,
    statementsExecuted: 1,
    uniqueConstraint: "(source, source_id)",
    searchPathAfterRollback: searchPath.rows[0].search_path,
  }, null, 1));
} catch (err) {
  await client.query("ROLLBACK").catch(() => {});
  throw err;
} finally {
  await client.end();
}
