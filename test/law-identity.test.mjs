import test from "node:test";
import assert from "node:assert/strict";
import { findCrossGenerationDuplicate, resolveBatchCategory } from "../lib/law/identity.js";

/** Minimal fake pg client: records queries, returns the canned result. */
function fakeClient(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows };
    },
  };
}

test("guard reports a duplicate when a canonical effective twin exists", async () => {
  const client = fakeClient([{ "?column?": 1 }]);
  assert.equal(await findCrossGenerationDuplicate(client, { title: "中华人民共和国网络安全法" }), true);
  const { sql, params } = client.calls[0];
  assert.match(sql, /lower\(title\) = lower\(\$1\)/);
  assert.match(sql, /status = '有效'/);
  assert.deepEqual(params[0], "中华人民共和国网络安全法");
  assert.deepEqual(params[1], ["重下载", "新法速递"]);
});

test("guard answers false when nothing matches", async () => {
  const client = fakeClient([]);
  assert.equal(await findCrossGenerationDuplicate(client, { title: "某新法" }), false);
});

test("guard skips the query entirely for a missing title", async () => {
  const client = fakeClient([{ "?column?": 1 }]);
  assert.equal(await findCrossGenerationDuplicate(client, { title: "" }), false);
  assert.equal(client.calls.length, 0);
});

test("batch label maps to the canonical twin's category", async () => {
  const client = fakeClient([{ category: "地方性法规" }]);
  assert.equal(
    await resolveBatchCategory(client, { title: "某条例", category: "重下载" }),
    "地方性法规",
  );
  assert.equal(client.calls.length, 1);
});

test("batch label survives when no canonical twin exists", async () => {
  const client = fakeClient([]);
  assert.equal(await resolveBatchCategory(client, { title: "某条例", category: "重下载" }), "重下载");
});

test("non-batch categories pass through without a query", async () => {
  const client = fakeClient([]);
  assert.equal(await resolveBatchCategory(client, { title: "某条例", category: "行政法规" }), "行政法规");
  assert.equal(client.calls.length, 0);
});

test("synonym spelling is normalized even outside the batch path", async () => {
  const client = fakeClient([]);
  assert.equal(await resolveBatchCategory(client, { title: "某条例", category: "地方法规" }), "地方性法规");
  assert.equal(client.calls.length, 0);
});

test("batch mapping prefers an effective twin when ordering matters", async () => {
  const client = fakeClient([{ category: "法律" }]);
  await resolveBatchCategory(client, { title: "某法", category: "新法速递" });
  assert.match(client.calls[0].sql, /CASE WHEN status = '有效' THEN 0 ELSE 1 END/);
});
