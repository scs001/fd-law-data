// Loader unit tests against the live wenshu_db schema shape: LocalS3 stands in
// for the bucket (real lib/wenshu/blocks.js runs on top of it, zstd included),
// FakePG is a deterministic in-memory evaluator for the exact SQL the loader
// emits (src_files registration, dict_texts upsert, judgments DELETE→INSERT
// with doc_id PK, feed precedence, block-ref UPDATE).
import test from "node:test";
import assert from "node:assert/strict";
import { LocalS3 } from "./fixtures/local-s3.mjs";
import { load, listCrawlFiles, monthOfKey } from "../lib/wenshu/loader.js";

const BUCKET = "wenshu";
const jsonl = (rows) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
const norm = (t) => t.replace(/\s+/g, " ").trim();

let seq = 0;
function crawlRow(over = {}) {
  seq += 1;
  const docId = `doc-${String(seq).padStart(3, "0")}`;
  return {
    docId,
    id_origin: docId,
    案号: `（2025）京0105民初${seq}号`,
    标题: `张三与李四机动车交通事故责任纠纷一审民事判决书${seq}`,
    法院: "北京市朝阳区人民法院",
    案由: "机动车交通事故责任纠纷",
    省: "北京市",
    市: "北京市",
    案件类型: "民事案件",
    文书类型: "判决书",
    审理程序: "一审",
    案例级别: null,
    法院级别: "基层法院",
    法条: "中华人民共和国民事诉讼法,第一百四十六条 | 中华人民共和国民事诉讼法,第二百五十条",
    判决时间: "2025-09-01",
    发布时间: "2025-09-10",
    受理时间: "2025-08-20",
    判决年份: 2025,
    判决结果: "驳回上诉，维持原判",
    qwContent: `<html><body>正文 ${seq} ${"甲".repeat(64)}</body></html>`,
    ...over,
  };
}

async function putCrawl(s3, key, rows) {
  await s3.putObject(BUCKET, key, jsonl(rows), { contentType: "application/x-ndjson" });
}

// In-memory evaluator for the loader's exact SQL surface. Every query is
// recorded in `log` ({text, params}); unmatched SQL fails loud so tests break
// the moment the loader's statement shapes drift.
class FakePG {
  constructor(seed = {}) {
    this.srcFiles = (seed.srcFiles ?? []).map((r) => ({ ...r }));
    this.dictTexts = (seed.dictTexts ?? []).map((r) => ({ ...r }));
    this.judgments = (seed.judgments ?? []).map((r) => ({ ...r }));
    this.log = [];
    this.#txSnapshot = null;
  }

  #txSnapshot;

  #clone() {
    return {
      srcFiles: this.srcFiles.map((r) => ({ ...r })),
      dictTexts: this.dictTexts.map((r) => ({ ...r })),
      judgments: this.judgments.map((r) => ({ ...r })),
    };
  }

  async query(text, params = []) {
    this.log.push({ text, params });
    const t = norm(text);
    const empty = () => ({ rows: [], rowCount: 0 });

    if (t === "BEGIN") {
      this.#txSnapshot = this.#clone();
      return empty();
    }
    if (t === "COMMIT") {
      this.#txSnapshot = null;
      return empty();
    }
    if (t === "ROLLBACK") {
      if (this.#txSnapshot) Object.assign(this, this.#txSnapshot);
      this.#txSnapshot = null;
      return empty();
    }
    if (t.startsWith("SELECT 1 FROM src_files")) {
      const [year, month] = params;
      const hit = this.srcFiles.some(
        (r) => r.schema === "D" && r.year === year && r.month === month && !String(r.path).startsWith("raw/"),
      );
      return { rows: hit ? [{ "?column?": 1 }] : [], rowCount: hit ? 1 : 0 };
    }
    if (t.startsWith("SELECT coalesce(max(src_id),0)+1 AS src_id FROM src_files")) {
      const next = this.srcFiles.reduce((mx, r) => Math.max(mx, r.src_id), 0) + 1;
      return { rows: [{ src_id: next }], rowCount: 1 };
    }
    if (t.startsWith("INSERT INTO src_files")) {
      const [src_id, path, year, month] = params;
      if (this.srcFiles.some((r) => r.path === path)) return empty(); // ON CONFLICT (path) DO NOTHING
      this.srcFiles.push({ src_id, path, schema: "D", year, month });
      return { rows: [{ src_id }], rowCount: 1 };
    }
    if (t.startsWith("SELECT src_id FROM src_files WHERE path")) {
      const hit = this.srcFiles.find((r) => r.path === params[0]);
      return { rows: hit ? [{ src_id: hit.src_id }] : [], rowCount: hit ? 1 : 0 };
    }
    if (t.startsWith("INSERT INTO dict_texts")) {
      const [col, txt] = params;
      if (this.dictTexts.some((r) => r["列"] === col && r.txt === txt)) return empty(); // ON CONFLICT ("列",txt)
      const ref_key = this.dictTexts.filter((r) => r["列"] === col).reduce((mx, r) => Math.max(mx, r.ref_key), 0) + 1;
      this.dictTexts.push({ "列": col, ref_key, txt });
      return { rows: [{ ref_key }], rowCount: 1 };
    }
    if (t.startsWith("SELECT ref_key FROM dict_texts")) {
      const hit = this.dictTexts.find((r) => r["列"] === params[0] && r.txt === params[1]);
      return { rows: hit ? [{ ref_key: hit.ref_key }] : [], rowCount: hit ? 1 : 0 };
    }
    if (t.startsWith("DELETE FROM judgments")) {
      const before = this.judgments.length;
      this.judgments = this.judgments.filter((r) => r.src_id !== params[0]);
      return { rows: [], rowCount: before - this.judgments.length };
    }
    if (t.startsWith("INSERT INTO judgments")) {
      const cols = t.match(/^INSERT INTO judgments \(([^)]+)\) VALUES /)[1].split(",").map((s) => s.trim().replace(/"/g, ""));
      const tupleCount = params.length / cols.length;
      assert.ok(Number.isInteger(tupleCount), `FakePG: params ${params.length} not divisible by ${cols.length} columns`);
      let inserted = 0;
      for (let i = 0; i < tupleCount; i++) {
        const row = {};
        cols.forEach((c, k) => {
          row[c] = params[i * cols.length + k];
        });
        if (this.judgments.some((r) => r.doc_id === row.doc_id)) continue; // PK (doc_id) conflict
        this.judgments.push(row);
        inserted++;
      }
      return { rows: [], rowCount: inserted };
    }
    if (t.startsWith("UPDATE judgments")) {
      let n = 0;
      for (let i = 0; i + 2 < params.length; i += 3) {
        const [doc_id, block_key, block_ordinal] = [params[i], params[i + 1], params[i + 2]];
        const hit = this.judgments.find((r) => r.doc_id === doc_id);
        if (hit) {
          hit.block_key = block_key;
          hit.block_ordinal = block_ordinal;
          n++;
        }
      }
      return { rows: [], rowCount: n };
    }
    throw new Error(`FakePG: unmatched query: ${t}`);
  }

  texts(prefix) {
    return this.log.filter((e) => norm(e.text).startsWith(prefix));
  }

  docIds() {
    return this.judgments.map((r) => r.doc_id);
  }
}

test("LocalS3: prefix filtering, maxKeys paging, bucket isolation; listCrawlFiles/monthOfKey", async () => {
  const s3 = new LocalS3();
  const keys = [
    "raw/2025/08/crawl-2025-08-31.jsonl",
    "raw/2025/09/crawl-2025-09-10.jsonl",
    "raw/2025/09/crawl-2025-09-11.jsonl",
    "raw/2025/09/seen.json",
    "raw/processed/raw_2025_09_crawl-2025-09-10.jsonl.done",
    "blocks/2025/09/000001.zst",
  ];
  for (const k of keys) await s3.putObject(BUCKET, k, "x");
  const p1 = await s3.listObjects(BUCKET, { prefix: "raw/", maxKeys: 2 });
  assert.equal(p1.truncated, true);
  const p2 = await s3.listObjects(BUCKET, { prefix: "raw/", continuationToken: p1.continuationToken, maxKeys: 2 });
  const p3 = await s3.listObjects(BUCKET, { prefix: "raw/", continuationToken: p2.continuationToken, maxKeys: 2 });
  assert.equal(p3.truncated, false);
  assert.deepEqual(
    [...p1.contents, ...p2.contents, ...p3.contents].map((c) => c.key),
    [
      "raw/2025/08/crawl-2025-08-31.jsonl",
      "raw/2025/09/crawl-2025-09-10.jsonl",
      "raw/2025/09/crawl-2025-09-11.jsonl",
      "raw/2025/09/seen.json",
      "raw/processed/raw_2025_09_crawl-2025-09-10.jsonl.done",
    ],
  );
  assert.equal((await s3.listObjects("other-bucket", { prefix: "" })).contents.length, 0);
  assert.deepEqual(await listCrawlFiles(s3, BUCKET), [
    "raw/2025/08/crawl-2025-08-31.jsonl",
    "raw/2025/09/crawl-2025-09-10.jsonl",
    "raw/2025/09/crawl-2025-09-11.jsonl",
  ]);
  assert.equal(monthOfKey("raw/2025/09/crawl-2025-09-10.jsonl"), "2025-09");
});

test("(a) feed-registered month skips all its crawl files entirely", async () => {
  const s3 = new LocalS3();
  await putCrawl(s3, "raw/2025/09/crawl-2025-09-10.jsonl", [crawlRow()]);
  const pgc = new FakePG({
    srcFiles: [{ src_id: 1, path: "2025/2025年09月（2）.csv", schema: "D", year: 2025, month: 9 }],
  });
  s3.calls.length = 0; // drop the fixture-setup putObject
  const sum = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.deepEqual(sum.skippedMonths, ["2025-09"]);
  assert.equal(sum.filesProcessed, 0);
  assert.equal(sum.rowsInserted, 0);
  assert.equal(sum.monthsRebuilt, 0);
  assert.equal(pgc.texts("SELECT 1 FROM src_files").length, 1); // precedence check ran...
  assert.equal(pgc.texts("DELETE").length, 0); // ...and nothing else did
  assert.equal(pgc.texts("INSERT").length, 0);
  assert.equal(pgc.texts("UPDATE").length, 0);
  assert.equal(s3.calls.filter((c) => c.op === "getObject" && c.key.includes("crawl-2025-09-10")).length, 0);
  assert.equal(s3.calls.filter((c) => c.op === "putObject").length, 0);
});

test("(b) processed marker makes the second run a read-only no-op", async () => {
  const s3 = new LocalS3();
  const key = "raw/2025/09/crawl-2025-09-10.jsonl";
  await putCrawl(s3, key, [crawlRow({ docId: "b1" }), crawlRow({ docId: "b2" })]);
  const pgc = new FakePG();
  const first = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(first.filesProcessed, 1);
  assert.equal(first.rowsInserted, 2);
  s3.calls.length = 0;
  pgc.log.length = 0;

  const sum = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(sum.filesProcessed, 0);
  assert.equal(sum.rowsInserted, 0);
  assert.equal(sum.monthsRebuilt, 0);
  assert.equal(sum.markersWritten, 0);
  assert.equal(pgc.texts("DELETE").length, 0);
  assert.equal(pgc.texts("INSERT").length, 0);
  assert.equal(pgc.texts("UPDATE").length, 0);
  assert.equal(pgc.texts("SELECT 1 FROM src_files").length, 1); // only the feed check
  // S3: reads only (list + file + marker); no writes and no headObject
  for (const c of s3.calls) assert.ok(["listObjects", "getObject"].includes(c.op), `unexpected op ${c.op}`);
  assert.ok(s3.calls.some((c) => c.op === "getObject" && c.key === `raw/processed/${key.replace(/\//g, "_")}.done`));
});

test("(c) changed file content reprocesses under the same src_id without duplicates", async () => {
  const s3 = new LocalS3();
  const key = "raw/2025/09/crawl-2025-09-10.jsonl";
  await putCrawl(s3, key, [crawlRow({ docId: "c1" }), crawlRow({ docId: "c2" })]);
  const pgc = new FakePG();
  const sum1 = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(sum1.rowsInserted, 2);

  await putCrawl(s3, key, [crawlRow({ docId: "c1", 标题: "v2-改后的更长标题" }), crawlRow({ docId: "c3" })]);
  const delBefore = pgc.texts("DELETE FROM judgments").length;
  const sum2 = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(sum2.filesProcessed, 1);
  assert.equal(pgc.texts("DELETE FROM judgments").length - delBefore, 1); // exactly one whole-file replace
  assert.equal(pgc.texts("DELETE FROM judgments")[1].params[0], 1); // same src_id as first registration
  assert.equal(pgc.srcFiles.filter((r) => r.path === key).length, 1); // ON CONFLICT (path) kept one row
  assert.ok(pgc.texts("SELECT src_id FROM src_files").length >= 1); // conflict path fell back to SELECT
  assert.deepEqual([...new Set(pgc.docIds())].sort(), ["c1", "c3"]);
  assert.equal(pgc.docIds().length, 2); // PK set size stable — no duplicates
});

test("(d) dict_texts upsert: shared txt gets one ref, memoized; conflict path reuses existing key", async () => {
  const s3 = new LocalS3();
  await putCrawl(s3, "raw/2025/09/crawl-2025-09-10.jsonl", [
    crawlRow({ docId: "d-a", 法院: "北京市朝阳区人民法院" }),
    crawlRow({ docId: "d-b", 法院: "北京市朝阳区人民法院" }),
    crawlRow({ docId: "d-c", 法院: "最高人民法院" }),
  ]);
  const pgc = new FakePG({ dictTexts: [{ "列": "法院", ref_key: 7, txt: "最高人民法院" }] });
  await load({ s3, bucket: BUCKET, pg: pgc });
  const inserts = pgc.texts("INSERT INTO dict_texts").filter((e) => e.params[1] === "北京市朝阳区人民法院");
  assert.equal(inserts.length, 1); // two rows shared it; memo issued one query
  const selects = pgc.texts("SELECT ref_key FROM dict_texts").filter((e) => e.params[1] === "最高人民法院");
  assert.equal(selects.length, 1); // DO NOTHING returned empty -> SELECT fallback, once
  const a = pgc.judgments.find((r) => r.doc_id === "d-a");
  const b = pgc.judgments.find((r) => r.doc_id === "d-b");
  const c = pgc.judgments.find((r) => r.doc_id === "d-c");
  assert.equal(a.法院引用, b.法院引用);
  assert.equal(a.法院引用, 8); // per-列 counter: max(法院)=7 -> 8
  assert.equal(c.法院引用, 7); // pre-existing entry reused, no new dict row
  assert.equal(pgc.dictTexts.filter((r) => r.txt === "最高人民法院" && r["列"] === "法院").length, 1);
});

test("(e) per-file transaction: BEGIN → DELETE by src_id → INSERT (ON CONFLICT doc_id, quoted CJK) → COMMIT", async () => {
  const s3 = new LocalS3();
  await putCrawl(s3, "raw/2025/09/crawl-2025-09-10.jsonl", [crawlRow({ docId: "e1" })]);
  const pgc = new FakePG();
  await load({ s3, bucket: BUCKET, pg: pgc });
  const inserts = pgc.texts("INSERT INTO judgments");
  assert.ok(inserts.length >= 1);
  for (const e of inserts) {
    const t = norm(e.text);
    assert.match(t, /ON CONFLICT \(doc_id\) DO NOTHING/);
    for (const col of ['"案号"', '"标题"', '"法院引用"', '"法条引用"', '"判决时间"', '"正文形态"']) {
      assert.ok(t.includes(col), `missing quoted CJK identifier ${col}`);
    }
  }
  const idx = (pred) => pgc.log.findIndex(pred);
  const iBegin = idx((e) => e.text === "BEGIN");
  const iDel = idx((e) => norm(e.text) === "DELETE FROM judgments WHERE src_id=$1");
  const iIns = idx((e) => norm(e.text).startsWith("INSERT INTO judgments"));
  const iCommit = idx((e) => e.text === "COMMIT");
  assert.ok(iBegin >= 0 && iDel > iBegin && iIns > iDel && iCommit > iIns, "BEGIN < DELETE < INSERT < COMMIT ordering");
});

test("(f) month rebuild packs docs from every daily file; rerun leaves byte-identical blocks", async () => {
  const s3 = new LocalS3();
  await putCrawl(s3, "raw/2025/09/crawl-2025-09-10.jsonl", [crawlRow({ docId: "f1" }), crawlRow({ docId: "f2" })]);
  await putCrawl(s3, "raw/2025/09/crawl-2025-09-11.jsonl", [
    crawlRow({ docId: "f3" }),
    crawlRow({ docId: "f2", qwContent: null, 标题: "dup-catalog-row" }), // cross-file duplicate
  ]);
  const pgc = new FakePG();
  const sum = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(sum.filesProcessed, 2);
  assert.equal(sum.monthsRebuilt, 1);
  assert.equal(sum.rowsSkippedConflict, 1); // day-2's f2 duplicate lost to first capture
  const f2 = pgc.judgments.find((r) => r.doc_id === "f2");
  assert.equal(f2.正文形态, "html"); // day-1 capture won
  assert.equal(f2.src_id, 1);
  assert.equal(pgc.judgments.find((r) => r.doc_id === "f3").src_id, 2);
  for (const id of ["f1", "f2", "f3"]) {
    const r = pgc.judgments.find((x) => x.doc_id === id);
    assert.ok(r.block_key && r.block_key.startsWith("blocks/2025/09/"), `${id} got a month-prefix block_key`);
    assert.ok(Number.isInteger(r.block_ordinal), `${id} got an integer block_ordinal`);
  }
  assert.equal(sum.verifiedDocs, 3); // sampled docs round-tripped through blocks
  const snap1 = s3.snapshot("blocks/");
  assert.ok(snap1.size >= 1);
  for (const k of snap1.keys()) assert.ok(k.startsWith("blocks/2025/09/"), `block outside month prefix: ${k}`);

  s3.calls.length = 0;
  pgc.log.length = 0;
  const sum2 = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(sum2.filesProcessed, 0);
  assert.equal(sum2.monthsRebuilt, 0);
  assert.equal(pgc.texts("UPDATE judgments").length, 0); // UPDATE idempotent: not reissued
  assert.equal(s3.calls.filter((c) => c.op === "putObject").length, 0); // no block rewrite
  assert.deepEqual(s3.snapshot("blocks/"), snap1); // byte-identical
});

test("(g) torn tail line is tolerated and still leaves a processed marker", async () => {
  const s3 = new LocalS3();
  const good = crawlRow({ docId: "g1" });
  const torn = JSON.stringify(crawlRow({ docId: "g2" })).slice(0, 40); // interrupted write
  await s3.putObject(BUCKET, "raw/2025/09/crawl-2025-09-10.jsonl", `${JSON.stringify(good)}\n${torn}`, {
    contentType: "application/x-ndjson",
  });
  const pgc = new FakePG();
  const sum = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(sum.filesProcessed, 1);
  assert.equal(sum.rowsInserted, 1);
  assert.deepEqual(pgc.docIds(), ["g1"]);
  const marker = JSON.parse(
    (await s3.getObject(BUCKET, "raw/processed/raw_2025_09_crawl-2025-09-10.jsonl.done")).toString("utf8"),
  );
  assert.equal(marker.rows, 1);
});

test("(h) end-to-end double load of the same day is a stable no-op", async () => {
  const s3 = new LocalS3();
  await putCrawl(s3, "raw/2025/09/crawl-2025-09-10.jsonl", [
    crawlRow({ docId: "h1" }),
    crawlRow({ docId: "h2" }),
    crawlRow({ docId: "h3", qwContent: null }),
  ]);
  const pgc = new FakePG();
  const s1 = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(s1.rowsInserted, 3);
  assert.equal(s1.verifiedDocs, 2); // only qwContent docs land in blocks
  const blocks1 = s3.snapshot("blocks/");
  const s2 = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(s2.filesProcessed, 0);
  assert.equal(s2.rowsInserted, 0);
  assert.equal(s2.markersWritten, 0);
  assert.equal(pgc.judgments.length, 3); // total judgment rows unchanged
  assert.equal(new Set(pgc.docIds()).size, 3);
  assert.deepEqual(s3.snapshot("blocks/"), blocks1); // months rebuilt deterministically (none re-run)
});

test("dry-run counts without mutating PG, bucket, or markers", async () => {
  const s3 = new LocalS3();
  await putCrawl(s3, "raw/2025/09/crawl-2025-09-10.jsonl", [crawlRow({ docId: "x1" }), crawlRow({ docId: "x2" })]);
  const pgc = new FakePG();
  s3.calls.length = 0; // drop the fixture-setup putObject
  const sum = await load({ s3, bucket: BUCKET, pg: pgc, dryRun: true });
  assert.equal(sum.filesProcessed, 1);
  assert.equal(sum.rowsInserted, 2); // count-only
  assert.equal(sum.monthsRebuilt, 0);
  assert.equal(sum.blocksWritten, 0);
  assert.equal(sum.markersWritten, 0);
  assert.equal(pgc.texts("DELETE").length, 0);
  assert.equal(pgc.texts("INSERT").length, 0);
  assert.equal(pgc.texts("UPDATE").length, 0);
  assert.equal(s3.calls.filter((c) => c.op === "putObject").length, 0);
  assert.equal(s3.snapshot("blocks/").size, 0);
  // no marker written during dry-run, so the real run still processes the file
  const real = await load({ s3, bucket: BUCKET, pg: pgc });
  assert.equal(real.filesProcessed, 1);
  assert.equal(real.rowsInserted, 2);
});
