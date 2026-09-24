#!/usr/bin/env node
// Real-PG proof that the unified loader is idempotent across all wave-1 source
// kinds. Runs in a temporary schema and rolls back, so law_db is unchanged.
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { loadLegalDocuments } from "../lib/legal-sources/document-loader.js";

const sources = [
  ["rmfyalk-case-library", "case"],
  ["mfa-treaty-library", "treaty"],
  ["gov-rules-library", "rule"],
  ["party-regulation-library", "party-regulation"],
  ["ccdi-supervisory-regulations", "supervisory-regulation"],
];
const docs = sources.map(([source, docType], index) => ({
  source,
  source_id: `proof-${index}`,
  doc_type: docType,
  title: `Idempotency proof ${index}`,
  published_at: "2026-01-01T00:00:00+08:00",
  status: "有效",
  content: `Proof body ${index}`,
  content_hash: `hash-${index}`,
  source_url: `https://example.test/${index}`,
  metadata: { proof: true },
}));
const schema = `legal_sources_loader_verify_${Date.now()}`;
const cfg = loadConfig();
const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
await client.connect();
try {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path = ${schema}`);
  // The loader only reads these guard tables; temporary proofs satisfy them.
  await client.query("CREATE TABLE laws (id bigserial)");
  await client.query("CREATE TABLE law_chunks (id bigserial)");
  const first = await loadLegalDocuments(client, docs);
  const second = await loadLegalDocuments(client, docs);
  const changed = docs.map((doc, index) => ({
    ...doc,
    content: `${doc.content} changed`,
    content_hash: `hash-${index}-changed`,
  }));
  const third = await loadLegalDocuments(client, changed);
  const count = await client.query("SELECT count(*)::int AS n FROM legal_documents");
  await client.query(`DROP SCHEMA ${schema} CASCADE`);
  const ok =
    first.inserted === docs.length &&
    second.inserted === 0 && second.updated === 0 && second.skippedUnchanged === docs.length &&
    third.updated === docs.length && third.inserted === 0 &&
    Number(count.rows[0].n) === docs.length;
  console.log(JSON.stringify({ ok, schema, dropped: true, first, second, third: { updated: third.updated, inserted: third.inserted }, rows: count.rows[0].n }, null, 1));
  if (!ok) process.exitCode = 1;
} catch (err) {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
  throw err;
} finally {
  await client.end();
}
