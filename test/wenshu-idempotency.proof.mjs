// Task 4.3 idempotency proof — REAL PostgreSQL, fake S3 (LocalS3).
// Skipped unless WENSHU_PROOF_PG_URL is set (e.g. a scratch wenshu_db with the
// live DDL applied; see openspec/changes/wenshu-incremental-crawl design.md
// "Verified findings" for how the scratch DB was built). Proves:
//   1. loading the same day twice changes no row counts (no duplicates),
//   2. markers make the second run a no-op (no SQL writes),
//   3. block rebuilds are byte-identical and month-isolated (cross-month
//      objects untouched),
//   4. a feed-registered month skips crawled files (precedence),
//   5. cross-file duplicate doc_id resolves first-capture-wins,
//   6. single-doc retrieval through block_key → header offsets returns the
//      exact qwContent bytes.
import test from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { load } from "../lib/wenshu/loader.js";
import { LocalS3 } from "./fixtures/local-s3.mjs";
import { readDocFromBucket } from "../lib/wenshu/blocks.js";

const URL = process.env.WENSHU_PROOF_PG_URL;
const BUCKET = "wenshu";

const row = (docId, over = {}) => ({
  docId,
  id_origin: "native",
  案号: `(2026)苏01民初${docId.slice(0, 4)}号`,
  标题: `样例案件 ${docId}`,
  法院: "江苏省南京市中级人民法院",
  案由: "民间借贷纠纷",
  省: "江苏省",
  市: "南京市",
  案件类型: "民事",
  文书类型: "判决书",
  审理程序: "一审",
  案例级别: "普通案例",
  法院级别: "中级法院",
  法条: "中华人民共和国民事诉讼法,第一百四十六条",
  判决时间: "2026-09-01",
  发布时间: "2026-09-02",
  受理时间: "2026-08-01",
  判决年份: 2026,
  判决结果: "支持原告部分诉讼请求",
  qwContent: `<html><body><h1>判决书 ${docId}</h1><p>正文内容 ${docId}。</p></body></html>`,
  ...over,
});

function seedFiles() {
  const s3 = new LocalS3();
  const put = (key, rowsArr) =>
    s3.putObject(BUCKET, key, Buffer.from(rowsArr.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  // August: one day, one doc also re-seen in September (cross-month look-back dupe).
  const aug = [row("a".repeat(32), { 判决时间: "2026-08-30", 发布时间: "2026-08-31", 判决年份: 2026 })];
  // September day 1: docs b,c ; day 2: docs c (look-back dupe, same doc_id), d.
  const sep1 = [row("b".repeat(32)), row("c".repeat(32))];
  const sep2 = [row("c".repeat(32)), row("d".repeat(32))];
  // July: month with a registered feed CSV → crawled file must be skipped.
  const jul = [row("e".repeat(32), { 判决时间: "2026-07-15", 发布时间: "2026-07-16", 判决年份: 2026 })];
  put("raw/2026/08/crawl-2026-08-31.jsonl", aug);
  put("raw/2026/09/crawl-2026-09-01.jsonl", sep1);
  put("raw/2026/09/crawl-2026-09-02.jsonl", sep2);
  put("raw/2026/07/crawl-2026-07-15.jsonl", jul);
  return s3;
}

test("idempotency proof on real PG (WENSHU_PROOF_PG_URL)", async (t) => {
  if (!URL) return t.skip("set WENSHU_PROOF_PG_URL to a scratch wenshu_db (live DDL) to run");
  const client = new pg.Client({ connectionString: URL });
  await client.connect();
  try {
  await client.query("TRUNCATE judgments, src_files; DELETE FROM dict_texts;");
  // Feed registration for July (path outside raw/).
  await client.query(
    `INSERT INTO src_files (src_id, path, schema, year, month) VALUES (1, '2026/2026年07月.csv', 'D', 2026, 7)`,
  );

  const counts = async () => {
    const j = await client.query("SELECT count(*)::int n FROM judgments");
    const d = await client.query("SELECT count(*)::int n FROM dict_texts");
    const s = await client.query("SELECT count(*)::int n FROM src_files");
    return { j: j.rows[0].n, d: d.rows[0].n, s: s.rows[0].n };
  };
  const srcIdOf = async (path) =>
    (await client.query("SELECT src_id FROM src_files WHERE path=$1", [path])).rows[0]?.src_id;

  // ---- first load ----
  const s3 = seedFiles();
  const r1 = await load({ s3, bucket: BUCKET, pg: client });
  const c1 = await counts();
  // 5 rows emitted, 1 July row skipped by precedence, c re-emitted on day 2
  // but doc_id PK keeps it a single row → judgments = 4 (a,b,c,d).
  assert.equal(c1.j, 4, `judgments after first load: ${c1.j}`);
  assert.ok(r1.skippedMonths.includes("2026-07"), "July must be skipped by feed precedence");
  assert.ok(!(await srcIdOf("raw/2026/07/crawl-2026-07-15.jsonl")), "July crawl file must not be registered");
  const cRef = await client.query(
    `SELECT src_id, block_key FROM judgments WHERE doc_id='${"c".repeat(32)}'`,
  );
  const day1 = await srcIdOf("raw/2026/09/crawl-2026-09-01.jsonl");
  assert.equal(cRef.rows[0].src_id, day1, "cross-file dupe resolves first-capture-wins (day 1)");
  assert.ok(cRef.rows[0].block_key, "doc c must have a block ref after month rebuild");

  // ---- single-doc retrieval through block_key → header offsets ----
  for (const docId of ["a".repeat(32), "b".repeat(32), "d".repeat(32)]) {
    const j = await client.query("SELECT block_key FROM judgments WHERE doc_id=$1", [docId]);
    const key = j.rows[0].block_key;
    const buf = await readDocFromBucket({ s3, bucket: BUCKET, blockKey: key, docId });
    assert.ok(buf, `retrieved ${docId} from ${key}`);
    assert.equal(buf.toString("utf8"), `<html><body><h1>判决书 ${docId}</h1><p>正文内容 ${docId}。</p></body></html>`);
  }

  // ---- snapshot blocks per month, then load the SAME days again ----
  const snap = (prefix) => s3.snapshot(prefix);
  const augBefore = snap("blocks/2026/08/");
  const sepBefore = snap("blocks/2026/09/");
  assert.ok(augBefore.size >= 1 && sepBefore.size >= 1, "both months have blocks");

  const r2 = await load({ s3, bucket: BUCKET, pg: client });
  const c2 = await counts();
  assert.deepEqual(c2, c1, `counts unchanged after identical reload: ${JSON.stringify({ c1, c2 })}`);
  assert.equal(r2.filesProcessed, 0, "second run must process no files (markers)");
  assert.deepEqual(snap("blocks/2026/09/"), sepBefore, "September blocks byte-identical");
  assert.deepEqual(snap("blocks/2026/08/"), augBefore, "August blocks untouched by September reload");

  // ---- changed file reprocess in place (backfill rewrite), still no dupes ----
  const rewritten = [row("b".repeat(32)), row("c".repeat(32)), row("f".repeat(32))];
  s3.putObject(BUCKET, "raw/2026/09/crawl-2026-09-01.jsonl", Buffer.from(rewritten.map((r) => JSON.stringify(r)).join("\n") + "\n"));
  await load({ s3, bucket: BUCKET, pg: client });
  const c3 = await counts();
  assert.equal(c3.j, 5, `a,b,c,d,f after rewrite: ${c3.j}`); // f added, nothing duplicated
  const cNow = await client.query(`SELECT src_id FROM judgments WHERE doc_id='${"c".repeat(32)}'`);
  const day1Now = await srcIdOf("raw/2026/09/crawl-2026-09-01.jsonl");
  assert.equal(cNow.rows[0].src_id, day1Now, "doc c follows its rewritten file's DELETE→INSERT (still one row)");

  // ---- v_judgments joins resolve (dict round-trip sanity) ----
  const v = await client.query(`SELECT "法院","案由","省" FROM v_judgments WHERE doc_id='${"b".repeat(32)}'`);
  assert.deepEqual(v.rows[0], { 法院: "江苏省南京市中级人民法院", 案由: "民间借贷纠纷", 省: "江苏省" });
  } finally {
    // an assertion failure must not leave the client handle open (that keeps
    // the test process alive forever)
    await client.end();
  }
});
