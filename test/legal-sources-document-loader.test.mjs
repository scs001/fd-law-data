import test from "node:test";
import assert from "node:assert/strict";
import {
  buildUpsertSql,
  chunkRecords,
  loadLegalDocuments,
  normalizeDocumentRow,
  validateDocument,
} from "../lib/legal-sources/document-loader.js";

function fakeClient({ existing = [], upsertMode = "insert", insertedFlags = null } = {}) {
  const queries = [];
  let upserts = 0;
  let flagIndex = 0;
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
        const rowCount = params.length / 14;
        return {
          rows: Array.from({ length: rowCount }, () => ({
            inserted: insertedFlags ? insertedFlags[flagIndex++] : upsertMode === "insert",
          })),
        };
      }
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [] };
      if (sql.startsWith("UPDATE legal_documents")) return { rows: [], rowCount: 0 };
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return client;
}

const doc = (overrides = {}) => normalizeDocumentRow({
  source: "test-source",
  source_id: "1",
  doc_type: "case",
  title: "Title",
  content: "Body",
  content_hash: "h1",
  source_url: "https://example.test/1",
  metadata: { nested: { b: 2, a: 1 } },
  ...overrides,
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
  assert.equal(second.queries.some((q) => q.sql === "BEGIN"), false);
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

test("chunkRecords splits by size and rejects a non-positive size", () => {
  assert.deepEqual(chunkRecords([], 2), []);
  assert.deepEqual(chunkRecords([1, 2, 3], 2).map((c) => c.length), [2, 1]);
  assert.deepEqual(chunkRecords([1, 2, 3, 4], 2).map((c) => c.length), [2, 2]);
  assert.throws(() => chunkRecords([1], 0), /positive integer/);
});

test("buildUpsertSql numbers placeholders per row and rejects empty batches", () => {
  const sql = buildUpsertSql(2);
  assert.match(sql, /VALUES \(\$1,\$2,\$3,\$4,\$5,\$6,\$7,\$8,\$9,\$10,\$11,\$12,\$13,\$14\),\(\$15,\$16,\$17,\$18,\$19,\$20,\$21,\$22,\$23,\$24,\$25,\$26,\$27,\$28\)/);
  assert.match(sql, /ON CONFLICT \(source, source_id\) DO UPDATE/);
  assert.match(sql, /RETURNING \(xmax = 0\) AS inserted/);
  assert.throws(() => buildUpsertSql(0), /positive integer/);
});

test("batch upsert commits per chunk with chunk-sized parameter lists", async () => {
  const docs = Array.from({ length: 5 }, (_, i) => doc({ source_id: String(i), content_hash: `h${i}` }));
  const progress = [];
  const client = fakeClient();
  const result = await loadLegalDocuments(client, docs, { chunkSize: 2, onProgress: (p) => progress.push(p) });

  const inserts = client.queries.filter((q) => q.sql.startsWith("INSERT INTO legal_documents"));
  assert.equal(inserts.length, 3);
  assert.deepEqual(inserts.map((q) => q.params.length), [28, 28, 14]);
  assert.equal(client.queries.filter((q) => q.sql === "BEGIN").length, 3);
  assert.equal(client.queries.filter((q) => q.sql === "COMMIT").length, 3);
  assert.equal(result.inserted, 5);
  assert.equal(result.skippedUnchanged, 0);
  assert.deepEqual(progress.map((p) => [p.chunk, p.chunks, p.rows]), [[1, 3, 2], [2, 3, 2], [3, 3, 1]]);
});

test("unchanged rows inside a batch are skipped; only changed rows reach SQL", async () => {
  const same = doc({ source_id: "1", content_hash: "h1" });
  const changed = doc({ source_id: "2", content_hash: "h2-new", content: "changed" });
  const fresh = doc({ source_id: "3", content_hash: "h3" });
  const existing = [
    { source: "test-source", source_id: "1", content_hash: "h1" },
    { source: "test-source", source_id: "2", content_hash: "h2" },
  ];
  const client = fakeClient({ existing, insertedFlags: [false, true] });
  const result = await loadLegalDocuments(client, [same, changed, fresh], { chunkSize: 200 });

  const inserts = client.queries.filter((q) => q.sql.startsWith("INSERT INTO legal_documents"));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params.length, 28);
  assert.equal(result.skippedUnchanged, 1);
  assert.equal(result.updated, 1);
  assert.equal(result.inserted, 1);
});

test("versioned rows retire prior versions once per canonical url, after the batch upsert", async () => {
  const v1 = doc({ source_id: "a@v1", content_hash: "v1", content: "one", metadata: { canonical_url: "a" } });
  const v2 = doc({ source_id: "a@v2", content_hash: "v2", content: "two", metadata: { canonical_url: "a" } });
  const client = fakeClient();
  await loadLegalDocuments(client, [v1, v2], { chunkSize: 200 });

  const inserts = client.queries.filter((q) => q.sql.startsWith("INSERT INTO legal_documents"));
  assert.equal(inserts.length, 1);
  assert.equal(inserts[0].params.length, 28);
  const retires = client.queries.filter((q) => q.sql.startsWith("UPDATE legal_documents"));
  assert.equal(retires.length, 1);
  // The last changed row for a canonical url is the new current one.
  assert.deepEqual(retires[0].params, ["test-source", "a@v2", "a"]);
  const insertIndex = client.queries.findIndex((q) => q.sql.startsWith("INSERT INTO legal_documents"));
  const retireIndex = client.queries.findIndex((q) => q.sql.startsWith("UPDATE legal_documents"));
  assert.ok(retireIndex > insertIndex);
});

test("empty record list writes nothing and still audits guards twice", async () => {
  const client = fakeClient();
  const result = await loadLegalDocuments(client, []);
  assert.equal(result.recordsRead, 0);
  assert.equal(result.inserted, 0);
  assert.equal(client.queries.some((q) => q.sql.startsWith("INSERT INTO legal_documents")), false);
  assert.equal(client.queries.filter((q) => q.sql.startsWith("SELECT count(*)")).length, 4);
});