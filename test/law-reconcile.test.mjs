import test from "node:test";
import assert from "node:assert/strict";
import {
  BATCH_CATEGORIES, CATEGORY_SYNONYMS, CHUNK_TABLES,
  categoryClass, compareAuthority, generationRank, normalizeCategory,
  planReconciliation, statusClass,
} from "../lib/law/reconcile.js";

const law = (id, over = {}) => ({
  id, src_db: "law", title: "某条例", category: "地方性法规",
  status: "有效", publish: "2015-01-01", ...over,
});
const hasChunks = () => ({ law_chunks: new Set(), law_chunks_v2: new Set() });

test("generation rank orders flk < lawv2 < law, unknown last", () => {
  assert.equal(generationRank("flk"), 0);
  assert.equal(generationRank("lawv2"), 1);
  assert.equal(generationRank("law"), 2);
  assert.equal(generationRank("other"), 3);
});

test("category class treats crawler-batch labels as non-canonical", () => {
  assert.equal(categoryClass("法律"), 0);
  assert.equal(categoryClass("地方性法规"), 0);
  assert.equal(categoryClass(null), 0);
  for (const batch of BATCH_CATEGORIES) assert.equal(categoryClass(batch), 1);
});

test("status class prefers 有效", () => {
  assert.equal(statusClass("有效"), 0);
  assert.equal(statusClass("已修改"), 1);
  assert.equal(statusClass("sxx:3"), 1);
  assert.equal(statusClass(null), 1);
});

test("authority: generation rank dominates category, status and publish", () => {
  const flkRow = law(3, { src_db: "flk", category: "重下载", status: "已修改", publish: "2001-01-01" });
  const lawRow = law(1, { src_db: "law", category: "法律", status: "有效", publish: "2026-01-01" });
  assert.ok(compareAuthority(flkRow, lawRow) < 0);
});

test("authority: category class beats status and publish", () => {
  const canonical = law(1, { category: "地方性法规", status: "已修改", publish: "2001-01-01" });
  const batch = law(2, { category: "重下载", status: "有效", publish: "2026-01-01" });
  assert.ok(compareAuthority(canonical, batch) < 0);
});

test("authority: status beats publish; publish newest-first with NULL last", () => {
  const effective = law(1, { status: "有效", publish: "2001-01-01" });
  const amended = law(2, { status: "已修改", publish: "2026-01-01" });
  assert.ok(compareAuthority(effective, amended) < 0);

  const newer = law(3, { publish: "2020-01-01" });
  const older = law(4, { publish: "2010-01-01" });
  assert.ok(compareAuthority(newer, older) < 0);

  const undated = law(5, { publish: null });
  assert.ok(compareAuthority(older, undated) < 0);
});

test("authority: lowest id breaks exact ties (deterministic re-runs)", () => {
  assert.ok(compareAuthority(law(7), law(9)) < 0);
  assert.ok(compareAuthority(law(9), law(7)) > 0);
});

test("parses Date and ISO-string publish identically", () => {
  const asDate = law(1, { publish: new Date("2020-01-01T00:00:00Z") });
  const asString = law(2, { publish: "2020-01-01T00:00:00.000Z" });
  assert.equal(compareAuthority(asDate, asString), asDate.id - asString.id);
});

test("normalizeCategory maps synonyms, passes others through", () => {
  for (const [syn, canon] of CATEGORY_SYNONYMS) assert.equal(normalizeCategory(syn), canon);
  assert.equal(normalizeCategory("法律"), "法律");
  assert.equal(normalizeCategory(null), null);
});

test("truncated legacy categories stay untouched (column ceiling, no guessing)", () => {
  const truncated = "有关法律问题和重大问题的决定（部";
  assert.equal(truncated.length, 16); // exactly the varchar(16) ceiling
  const rows = [
    law(1, { src_db: "lawv2", title: "某决定", category: truncated }),
    law(2, { src_db: "law", title: "某决定", category: truncated }),
  ];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.deepEqual(plan.categoryUpdates, []);
});

test("duplicate group collapses to the flk survivor; the rest are deleted", () => {
  const rows = [
    law(730, { src_db: "law", category: "法律" }),
    law(69743, { src_db: "lawv2", category: "法律" }),
    law(71324, { src_db: "flk", category: "法律", status: "sxx:3", publish: "2025-10-28" }),
  ];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.deepEqual([...plan.deleteIds].sort((a, b) => a - b), [730, 69743]);
  assert.equal(plan.report.duplicatedTitles, 1);
  assert.deepEqual(plan.report.deletedByGeneration, { law: 1, lawv2: 1 });
});

test("singleton group survives; only its category normalization is planned", () => {
  const rows = [law(1, { category: "地方法规", title: "四川省某条例" })];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.categoryUpdates, [{ id: 1, from: "地方法规", to: "地方性法规" }]);
});

test("duplicate truncated-category group still collapses and keeps the label", () => {
  const truncated = "有关法律问题和重大问题的决定（部";
  const rows = [
    law(1, { src_db: "lawv2", title: "某决定", category: truncated }),
    law(2, { src_db: "law", title: "某决定", category: truncated }),
  ];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.equal(plan.deleteIds.length, 1);
  assert.deepEqual(plan.categoryUpdates, []);
});

test("batch-only title keeps its label (never guessed)", () => {
  const rows = [law(1, { title: "只此一份", category: "重下载", status: "有效" })];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.deepEqual(plan.categoryUpdates, []);
  assert.deepEqual(plan.deleteIds, []);
});

test("bare survivor inherits chunks from the single best removed source", () => {
  const rows = [
    law(10, { src_db: "flk", title: "甲条例" }),
    law(8, { src_db: "law", title: "甲条例", category: "重下载" }),
    law(9, { src_db: "lawv2", title: "甲条例" }),
  ];
  const chunks = hasChunks();
  chunks.law_chunks.add("8");
  chunks.law_chunks_v2.add("8");
  chunks.law_chunks.add("9");
  chunks.law_chunks_v2.add("9");
  const plan = planReconciliation({ laws: rows, hasChunks: chunks });
  // flk survivor (10) is bare: lawv2 (9) wins the single re-point source
  for (const table of CHUNK_TABLES) {
    assert.deepEqual(plan.repoints.filter((x) => x.table === table), [{ table, fromId: 9, toId: 10 }]);
    assert.deepEqual(plan.chunkDeletes[table], [8]);
  }
});

test("survivor with chunks makes every removed row's chunks deletable", () => {
  // flk survivor (1) has chunks; lawv2 duplicate (2) may not re-point.
  const rows = [
    law(1, { src_db: "flk", title: "乙条例" }),
    law(2, { src_db: "lawv2", title: "乙条例" }),
  ];
  const chunks = hasChunks();
  for (const table of CHUNK_TABLES) {
    chunks[table].add("1");
    chunks[table].add("2");
  }
  const plan = planReconciliation({ laws: rows, hasChunks: chunks });
  assert.deepEqual(plan.repoints, []);
  for (const table of CHUNK_TABLES) assert.deepEqual(plan.chunkDeletes[table], [2]);
});

test("removed rows without chunks produce no chunk actions", () => {
  const rows = [law(1, { src_db: "lawv2", title: "丙条例" }), law(2, { src_db: "law", title: "丙条例" })];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.deepEqual(plan.repoints, []);
  assert.deepEqual(plan.chunkDeletes.law_chunks, []);
  assert.deepEqual(plan.chunkDeletes.law_chunks_v2, []);
});

test("string ids (pg bigint) work as well as numbers", () => {
  const rows = [
    law("100", { src_db: "law", title: "丁条例" }),
    law("101", { src_db: "lawv2", title: "丁条例" }),
  ];
  const chunks = hasChunks();
  chunks.law_chunks.add("100");
  const plan = planReconciliation({ laws: rows, hasChunks: chunks });
  assert.deepEqual(plan.repoints, [{ table: "law_chunks", fromId: "100", toId: "101" }]);
});

test("planning does not mutate its input", () => {
  const rows = [law(1, { title: "戊条例" }), law(2, { src_db: "lawv2", title: "戊条例" })];
  const snapshot = JSON.stringify(rows);
  const chunks = hasChunks();
  chunks.law_chunks_v2.add("1");
  planReconciliation({ laws: rows, hasChunks: chunks });
  assert.equal(JSON.stringify(rows), snapshot);
  assert.deepEqual([...chunks.law_chunks_v2], ["1"]);
});

test("idempotency: an already-converged corpus plans nothing", () => {
  const rows = [
    law(1, { src_db: "flk", title: "甲", category: "法律" }),
    law(2, { src_db: "law", title: "乙", category: "地方性法规" }),
  ];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.deepEqual(plan.deleteIds, []);
  assert.deepEqual(plan.categoryUpdates, []);
  assert.deepEqual(plan.repoints, []);
});

test("titles group case- and surrounding-whitespace-insensitively", () => {
  const rows = [
    law(1, { title: "Financial Regulations" }),
    law(2, { src_db: "lawv2", title: "financial regulations " }),
    law(3, { src_db: "law", title: "  Financial Regulations" }),
  ];
  const plan = planReconciliation({ laws: rows, hasChunks: hasChunks() });
  assert.equal(plan.report.titles, 1);
  assert.equal(plan.deleteIds.length, 2);
});
