import test from "node:test";
import assert from "node:assert/strict";
import { createEmbedder } from "../lib/embed/siliconflow.js";
import { createQdrant } from "../lib/embed/qdrant.js";
import { selfCheck, runEmbedJob } from "../lib/embed/worker.js";

const jsonResponse = (status, body) =>
  Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body), text: () => Promise.resolve(JSON.stringify(body)) });

// ---- embedder ----

test("embedder retries 429 with backoff and succeeds", async () => {
  const calls = [];
  const sleeps = [];
  const emb = createEmbedder({
    endpoint: "https://emb.test/v1",
    apiKey: "k",
    model: "m",
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body));
      if (calls.length === 1) return jsonResponse(429, { error: "rate" });
      return jsonResponse(200, { data: [{ index: 0, embedding: [0.1, 0.2] }], usage: { total_tokens: 7 } });
    },
  });
  const { vectors, usage } = await emb.embed(["文本"]);
  assert.deepEqual(vectors, [[0.1, 0.2]]);
  assert.equal(usage.total_tokens, 7);
  assert.equal(calls.length, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("embedder fails fast on a definitive 4xx", async () => {
  const sleeps = [];
  const emb = createEmbedder({
    endpoint: "https://emb.test/v1",
    apiKey: "k",
    model: "m",
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    fetchImpl: async () => jsonResponse(400, { error: "bad input" }),
  });
  await assert.rejects(() => emb.embed(["x"]), /HTTP 400/);
  assert.equal(sleeps.length, 0);
});

test("embedder maps vectors by index, not order", async () => {
  const emb = createEmbedder({
    endpoint: "https://emb.test/v1",
    apiKey: "k",
    model: "m",
    sleep: () => Promise.resolve(),
    fetchImpl: async () =>
      jsonResponse(200, { data: [{ index: 1, embedding: [2] }, { index: 0, embedding: [1] }] }),
  });
  const { vectors } = await emb.embed(["a", "b"]);
  assert.deepEqual(vectors, [[1], [2]]);
});

// ---- qdrant client ----

test("qdrant client shapes upsert, delete and id-lookup requests", async () => {
  const seen = [];
  const q = createQdrant({
    url: "http://q.test:6333",
    collection: "c",
    fetchImpl: async (url, init) => {
      seen.push([init?.method ?? "GET", url, init?.body ? JSON.parse(init.body) : null]);
      if (url.includes("/points?")) return jsonResponse(200, { result: { status: "completed" } });
      if (url.includes("/points/delete")) return jsonResponse(200, { result: {} });
      if (/\/points$/.test(url)) return jsonResponse(200, { result: [] }); // id lookup
      if (url.includes("/points/")) return jsonResponse(200, { result: [] });
      throw new Error("unexpected " + url);
    },
  });
  await q.upsert([{ id: 1, vector: [0.1], payload: { law_id: "72000" } }]);
  await q.deleteByLawIds(["72000", "72001"]);
  await q.pointsByIds([1, 2, 3]);
  const upsert = seen[0];
  assert.equal(upsert[0], "PUT");
  assert.equal(upsert[1], "http://q.test:6333/collections/c/points?wait=true");
  assert.deepEqual(upsert[2].points, [{ id: 1, vector: [0.1], payload: { law_id: "72000" } }]);
  assert.deepEqual(seen[1][2], { filter: { must: [{ key: "law_id", match: { any: ["72000", "72001"] } }] } });
  assert.deepEqual(seen[2][2].ids, [1, 2, 3]);
});

test("qdrant client retries a transient 503 and succeeds", async () => {
  let calls = 0;
  const sleeps = [];
  const q = createQdrant({
    url: "http://q.test:6333",
    collection: "c",
    sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
    fetchImpl: async () => {
      if (++calls === 1) return jsonResponse(503, { error: "optimizing" });
      return jsonResponse(200, { result: { status: "completed" } });
    },
  });
  await q.upsert([{ id: 1, vector: [0.1], payload: {} }]);
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [1000]);
});

test("qdrant client fails fast on a definitive 400", async () => {
  const q = createQdrant({
    url: "http://q.test:6333",
    collection: "c",
    sleep: () => Promise.resolve(),
    fetchImpl: async () => jsonResponse(400, { error: "bad" }),
  });
  await assert.rejects(() => q.upsert([{ id: 1, vector: [0.1], payload: {} }]), /HTTP 400/);
});

// ---- worker ----

function makeS3(objects) {
  return {
    getObject: async (b, k) => objects[k] ?? null,
    listObjects: async (b, { prefix }) => ({ contents: Object.keys(objects).filter((k) => k.startsWith(prefix)).map((k) => ({ key: k })) }),
    putObject: async (b, k, body) => (objects[k] = Buffer.from(body)),
  };
}

const row = (lawId, no) => ({
  point_id: lawId * 1048576 + no,
  chunk_id: `${lawId}:${no}`,
  law_id: String(lawId),
  chunk_no: no,
  chunk_text: `第${no}条内容`,
  payload: { law_id: String(lawId), chunk_no: no, chunk_text: `第${no}条内容` },
});
const shardBody = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

function freshDeps() {
  const embedCalls = [];
  const qdrant = {
    upserted: [],
    deleted: [],
    async upsert(pts) { this.upserted.push(...pts.map((p) => p.id)); },
    async deleteByLawIds(ids) { this.deleted = ids; },
    async pointsByIds(ids) { return ids.map((id) => ({ id })); },
    async getPoint() { return { id: 1, vector: [1, 0] }; },
  };
  return { embedCalls, embedder: { embed: async (texts) => (embedCalls.push(texts), { vectors: texts.map(() => [1, 0]), usage: { total_tokens: texts.length } }) }, qdrant };
}

test("worker embeds, verifies, and writes a digest-bearing claim", async () => {
  const rows = [row(72000, 0), row(72000, 1), row(72001, 0)];
  const objects = { "incr-manifest.json": Buffer.from(JSON.stringify({ shards: [{ shard: "incr-x-00000.jsonl", rows: 3 }] })), "incr-x-00000.jsonl": Buffer.from(shardBody(rows)) };
  const s3 = makeS3(objects);
  const { embedder, qdrant, embedCalls } = freshDeps();
  const stats = await runEmbedJob({ s3, embedder, qdrant, bucket: "b", worker: "w1" });
  assert.equal(stats.shards, 1);
  assert.equal(stats.points, 3);
  assert.equal(embedCalls.length, 1); // 3 rows, one batch (batchSize default 32)
  assert.deepEqual(qdrant.upserted, rows.map((r) => r.point_id));
  const claim = JSON.parse(objects["claims/incr-x-00000.jsonl.claim-w1"].toString());
  assert.equal(claim.rows, 3);
  assert.equal(claim.sha256.length, 64);
  assert.deepEqual(claim.lawIds, ["72000", "72001"]);
});

test("worker skips a shard whose claim digest matches, without embedding", async () => {
  const rows = [row(72000, 0)];
  const objects = { "incr-manifest.json": Buffer.from(JSON.stringify({ shards: [{ shard: "incr-x-00000.jsonl", rows: 1 }] })), "incr-x-00000.jsonl": Buffer.from(shardBody(rows)) };
  const s3 = makeS3(objects);
  const { embedder, qdrant } = freshDeps();
  await runEmbedJob({ s3, embedder, qdrant, bucket: "b", worker: "w1" });
  const { embedder: e2, embedCalls: calls2 } = freshDeps();
  const stats = await runEmbedJob({ s3, embedder: e2, qdrant, bucket: "b", worker: "w2" });
  assert.equal(stats.skipped, 1);
  assert.equal(stats.shards, 0);
  assert.equal(calls2.length, 0); // claim from ANY worker with matching digest skips
});

test("worker re-embeds a regenerated shard and clears stale points of both versions", async () => {
  const v1 = [row(72000, 0), row(72000, 1), row(72002, 0)];
  const objects = { "incr-manifest.json": Buffer.from(JSON.stringify({ shards: [{ shard: "incr-x-00000.jsonl", rows: 3 }] })), "incr-x-00000.jsonl": Buffer.from(shardBody(v1)) };
  const s3 = makeS3(objects);
  const { embedder, qdrant } = freshDeps();
  await runEmbedJob({ s3, embedder, qdrant, bucket: "b", worker: "w1" });

  // shard regenerated: law 72002 dropped, law 72003 added
  const v2 = [row(72000, 0), row(72000, 1), row(72003, 0)];
  objects["incr-x-00000.jsonl"] = Buffer.from(shardBody(v2));
  const second = freshDeps();
  const stats = await runEmbedJob({ s3, embedder: second.embedder, qdrant: second.qdrant, bucket: "b", worker: "w1" });
  assert.equal(stats.shards, 1);
  assert.deepEqual([...second.qdrant.deleted].sort(), ["72000", "72002", "72003"]); // old ∪ new law ids
  assert.ok(second.qdrant.upserted.includes(72003 * 1048576));
  assert.ok(!second.qdrant.upserted.includes(72002 * 1048576));
});

test("worker refuses to touch historical law ids", async () => {
  const rows = [row(5, 0)];
  const objects = { "incr-manifest.json": Buffer.from(JSON.stringify({ shards: [{ shard: "incr-x-00000.jsonl", rows: 1 }] })), "incr-x-00000.jsonl": Buffer.from(shardBody(rows)) };
  const { embedder, qdrant } = freshDeps();
  await assert.rejects(
    () => runEmbedJob({ s3: makeS3(objects), embedder, qdrant, bucket: "b", worker: "w1" }),
    /historical law_id 5/,
  );
});

// ---- self-check ----

test("self-check passes when the fresh vector reproduces the stored one", async () => {
  const objects = { "sh2-00000.jsonl": Buffer.from(shardBody([{ point_id: 1048576, chunk_id: "1:0", law_id: "1", chunk_no: 0, chunk_text: "历史文本", payload: {} }])) };
  const res = await selfCheck({ s3: makeS3(objects), bucket: "b", embedder: { embed: async () => ({ vectors: [[1, 0]] }) }, qdrant: { getPoint: async () => ({ vector: [1, 0] }) } });
  assert.ok(res.cosine > 0.999);
});

test("self-check aborts when the vector space drifted", async () => {
  const objects = { "sh2-00000.jsonl": Buffer.from(shardBody([{ point_id: 1048576, chunk_text: "x", payload: {} }])) };
  await assert.rejects(
    () => selfCheck({ s3: makeS3(objects), bucket: "b", embedder: { embed: async () => ({ vectors: [[0, 1]] }) }, qdrant: { getPoint: async () => ({ vector: [1, 0] }) } }),
    /does not match the historical corpus/,
  );
});
