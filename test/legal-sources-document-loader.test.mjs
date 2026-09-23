import test from "node:test";
import assert from "node:assert/strict";
import { loadLegalDocuments, normalizeDocumentRow, validateDocument } from "../lib/legal-sources/document-loader.js";

function fakeClient({ existing = [], upsertMode = "insert" } = {}) {
  const queries = [];
  let upserts = 0;
  const client = {
    queries,
    async query(sql, params = []) {
      queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params });
      if (sql.startsWith("SELECT count(*)")) return { rows: [{ n: sql.includes("laws") ? 100 : 200 }] };
      if (sql.startsWith("CREATE TABLE") || sql.startsWith("CREATE UNIQUE INDEX") || sql.startsWith("CREATE INDEX")) return { rows: [] };
      if (sql.startsWith("SELECT source, source_id, content_hash")) {
        return { rows: upserts ? [] : existing };
      }
      if (sql.startsWith("INSERT INTO legal_documents")) {
        upserts++;
        return { rows: [{ inserted: upsertMode === "insert" }] };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("UPDATE legal_documents")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return client;
}

const doc = () => normalizeDocumentRow({
  source: "test-source",
  source_id: "1",
  doc_type: "case",
  title: "Title",
  content: "Body",
  content_hash: "h1",
  source_url: "https://example.test/1",
  metadata: { nested: { b: 2, a: 1 } },
});

test("normalizes required fields and rejects incomplete rows", () => {
  const row = doc();
  assert.equal(row.metadata.nested.a, 1);
  assert.throws(() => validateDocument({ ...doc(), source_id: "" }), /missing source_id/);
  assert.throws(() => normalizeDocumentRow({ ...doc(), content_hash: null }), /missing content_hash/);
});

test("first load inserts; unchanged reload skips without SQL writes", async () => {
  const first = fakeClient();
  const firstResult = await loadLegalDocuments(first, [doc()]);
  assert.equal(firstResult.inserted, 1);
  assert.equal(firstResult.skippedUnchanged, 0);
  assert.equal(firstResult.guard.unchanged, true);

  const stored = [{ source: "test-source", source_id: "1", content_hash: "h1" }];
  const second = fakeClient({ existing: stored });
  const secondResult = await loadLegalDocuments(second, [doc()]);
  assert.equal(secondResult.inserted, 0);
  assert.equal(secondResult.updated, 0);
  assert.equal(secondResult.skippedUnchanged, 1);
  assert.equal(second.queries.some((q) => q.sql.startsWith("INSERT INTO legal_documents")), false);
});

test("changed hash upserts and guards existing corpora", async () => {
  const client = fakeClient({ existing: [{ source: "test-source", source_id: "1", content_hash: "old" }], upsertMode: "update" });
  const result = await loadLegalDocuments(client, [doc()]);
  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 0);
  const upsert = client.queries.find((q) => q.sql.startsWith("INSERT INTO legal_documents"));
  assert.match(upsert.sql, /ON CONFLICT \(source, source_id\) DO UPDATE/);
  assert.equal(client.queries.some((q) => q.sql === "COMMIT"), true);
});

test("dry run still audits guards but writes no DDL or rows", async () => {
  const client = fakeClient();
  const result = await loadLegalDocuments(client, [doc()], { dryRun: true });
  assert.equal(result.inserted, 0);
  assert.equal(client.queries.some((q) => q.sql.startsWith("CREATE TABLE")), false);
  assert.equal(client.queries.some((q) => q.sql.startsWith("INSERT INTO legal_documents")), false);
});
