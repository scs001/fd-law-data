// Unit tests for the wenshu crawl orchestration (lib/wenshu/crawler.js).
// Fakes only: Map-backed S3 + programmable adapter — no playwright, no net.
import test from "node:test";
import assert from "node:assert/strict";
import {
  crawl, shapeRow, dailyKey, manifestKey, seenKey,
  DEFAULT_REGIONS, DEFAULT_CASE_TYPES,
} from "../lib/wenshu/crawler.js";

const DICT_COLS = [
  "案号", "标题", "法院", "案由", "省", "市",
  "案件类型", "文书类型", "审理程序", "案例级别", "法院级别", "法条",
  "判决时间", "发布时间", "受理时间", "判决年份", "判决结果",
];

function makeFakeS3() {
  const store = new Map();
  return {
    store,
    async getObject(bucket, key) { return store.has(key) ? Buffer.from(store.get(key), "utf8") : null; },
    async putObject(bucket, key, body) { store.set(key, body.toString("utf8")); return { etag: `"${store.size}"` }; },
    async headObject(bucket, key) {
      return store.has(key) ? { contentLength: Buffer.byteLength(store.get(key), "utf8"), etag: "e" } : null;
    },
    async listObjects(bucket, { prefix = "" } = {}) {
      return {
        contents: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: Buffer.byteLength(store.get(key), "utf8") })),
        truncated: false,
      };
    },
  };
}

function makeFakeAdapter({ total = 3, docIds = [], failWith = null } = {}) {
  const calls = { searchTotal: [], listDocIds: [], fetchDetail: [] };
  return {
    calls,
    async probeSession() { return { ok: true }; },
    async searchTotal(slice) { calls.searchTotal.push(slice); return total; },
    async listDocIds(slice, opts) { calls.listDocIds.push({ slice, opts }); return [...docIds]; },
    async fetchDetail(docId) {
      calls.fetchDetail.push({ docId, at: Date.now() });
      if (failWith) {
        const err = failWith(docId);
        if (err) throw err;
      }
      return makeDetail(docId);
    },
  };
}

function makeDetail(docId, over = {}) {
  return {
    案号: "（2026）京01民终100号",
    标题: "张三与李四民间借贷纠纷二审",
    法院: "北京市第一中级人民法院",
    案由: "民间借贷纠纷",
    省: "北京市",
    市: "北京市",
    案件类型: "民事案件",
    文书类型: "判决书",
    审理程序: "二审",
    案例级别: null,
    法院级别: "中级",
    法条: "《民事诉讼法》第一百七十条",
    判决时间: "2026-09-10",
    发布时间: "2026-09-17",
    受理时间: "2026-03-01",
    判决年份: null,
    判决结果: "驳回上诉，维持原判",
    qwContent: "<div>全文HTML</div>",
    nativeDocId: docId && /^[0-9a-f]{32}$/.test(docId) ? docId : null,
    ...over,
  };
}

// Fixed clock: runDate 2026-09-02, look-back 7d → window 2026-08-26..2026-09-01
// (spans the month boundary, exercising cross-month seen dedup).
const TODAY = "2026-09-02";
const baseOpts = (s3, adapter, over = {}) => ({
  s3,
  bucket: "wenshu",
  adapter,
  today: TODAY,
  lookbackDays: 7,
  rateMs: 0,
  budgetMs: 3600_000,
  resultCap: 200,
  maxPages: 5,
  regions: ["北京市"],
  caseTypes: ["民事"],
  checkpointEvery: 1,
  ...over,
});

test("shapeRow emits exact key order docId, id_origin, 17 dict cols, qwContent", () => {
  const detail = makeDetail("a".repeat(32));
  const row = shapeRow(detail, () => ({ doc_id: "X", id_origin: "test" }));
  assert.deepEqual(Object.keys(row), ["docId", "id_origin", ...DICT_COLS, "qwContent"]);
  assert.equal(row.docId, "X");
  assert.equal(row.id_origin, "test");
  assert.equal(row.qwContent, "<div>全文HTML</div>");
});

test("shapeRow derives 判决年份 from 判决时间 when absent, keeps null qwContent as-is", () => {
  const pick = () => ({ doc_id: "X", id_origin: "test" });
  assert.equal(shapeRow(makeDetail(null, { 判决时间: "2026-09-10" }), pick).判决年份, 2026);
  assert.equal(shapeRow(makeDetail(null, { 判决时间: null }), pick).判决年份, null);
  assert.equal(shapeRow(makeDetail("b".repeat(32), { 判决年份: 2025 }), pick).判决年份, 2025);
  assert.equal(shapeRow(makeDetail("c".repeat(32), { qwContent: null }), pick).qwContent, null);
});

test("shapeRow default pickDocId: native 32-hex preferred, derived fallback", () => {
  const native = "abcd0123abcd0123abcd0123abcd0123";
  const viaDefault = shapeRow(makeDetail(native));
  const viaStub = shapeRow(makeDetail(native), () => ({ doc_id: native, id_origin: "native" }));
  assert.equal(viaDefault.docId, native);
  assert.equal(viaDefault.id_origin, "native");
  assert.deepEqual(viaDefault, viaStub);
  const derived = shapeRow(makeDetail(null));
  assert.equal(derived.id_origin, "derived");
  assert.ok(/^[0-9a-f]{32,40}$/.test(derived.docId), `derived docId shape: ${derived.docId}`);
});

test("key formats: daily, manifest, seen", () => {
  assert.equal(dailyKey("2026-09-18"), "raw/2026/09/crawl-2026-09-18.jsonl");
  assert.equal(manifestKey("2026-09-18"), "raw/2026/09/crawl-2026-09-18.manifest.json");
  assert.equal(seenKey("2026-09"), "raw/2026/09/seen.json");
  assert.equal(DEFAULT_REGIONS.length, 34);
  assert.deepEqual(DEFAULT_CASE_TYPES, ["民事", "刑事", "行政", "执行", "赔偿"]);
});

test("seen-set dedup: prior month's seen.json blocks re-emission across the boundary", async () => {
  const s3 = makeFakeS3();
  const priorId = "11111111111111111111111111111111";
  const newId = "22222222222222222222222222222222";
  s3.store.set(seenKey("2026-08"), JSON.stringify({ month: "2026-08", docs: [priorId] }));
  const adapter = makeFakeAdapter({ docIds: [priorId, newId] });
  const { manifest, rows } = await crawl(baseOpts(s3, adapter));
  assert.deepEqual(adapter.calls.fetchDetail.map((c) => c.docId), [newId]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].docId, newId);
  assert.equal(manifest.skippedSeen, 1);
  assert.equal(manifest.candidates, 2);
  assert.equal(manifest.emitted, 1);
  // run-month seen gains only the new doc; the prior month's file is untouched
  const runSeen = JSON.parse(s3.store.get(seenKey("2026-09")));
  assert.deepEqual(runSeen.docs, [newId]);
  assert.equal(JSON.parse(s3.store.get(seenKey("2026-08"))).docs.length, 1);
  assert.ok(s3.store.has(dailyKey(TODAY)));
  assert.ok(s3.store.has(manifestKey(TODAY)));
});

test("resume: prior same-day rows kept, not re-fetched, torn tail tolerated", async () => {
  const s3 = makeFakeS3();
  const priorId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const newId = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const priorRow = shapeRow(makeDetail(priorId));
  s3.store.set(dailyKey(TODAY), `${JSON.stringify(priorRow)}\n{"docId":"tor`);
  const adapter = makeFakeAdapter({ docIds: [priorId, newId] });
  const { manifest, rows } = await crawl(baseOpts(s3, adapter));
  assert.deepEqual(adapter.calls.fetchDetail.map((c) => c.docId), [newId]);
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => r.docId).sort(), [newId, priorId].sort());
  assert.equal(manifest.resumedFrom, 1);
  assert.equal(manifest.emitted, 2);
  const fileRows = s3.store.get(dailyKey(TODAY)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(fileRows.length, 2);
});

test("budget exhaustion truncates but prior rows are still written", async () => {
  const s3 = makeFakeS3();
  const priorId = "cccccccccccccccccccccccccccccccc";
  const freshId = "dddddddddddddddddddddddddddddddd";
  s3.store.set(dailyKey(TODAY), `${JSON.stringify(shapeRow(makeDetail(priorId)))}\n`);
  const adapter = makeFakeAdapter({ docIds: [priorId, freshId] });
  const { manifest } = await crawl(baseOpts(s3, adapter, { budgetMs: -1 }));
  assert.equal(manifest.truncated, true);
  assert.equal(adapter.calls.fetchDetail.length, 0);
  assert.equal(manifest.emitted, 1); // the resumed row
  const fileRows = s3.store.get(dailyKey(TODAY)).split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.deepEqual(fileRows.map((r) => r.docId), [priorId]);
  assert.ok(s3.store.has(manifestKey(TODAY)));
});

test("selector-drift and SessionError abort the run; ordinary errors are recorded per-doc", async () => {
  const okId = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const boomId = "ffffffffffffffffffffffffffffffff";
  const s3 = makeFakeS3();

  await assert.rejects(
    crawl(baseOpts(s3, makeFakeAdapter({ docIds: [boomId], failWith: () => new Error("selector-drift: .wf-yjpx missing") }))),
    /selector-drift/,
  );
  const sessionErr = new Error("logged out");
  sessionErr.name = "SessionError";
  await assert.rejects(
    crawl(baseOpts(makeFakeS3(), makeFakeAdapter({ docIds: [boomId], failWith: () => sessionErr }))),
    (e) => e.name === "SessionError",
  );

  // site.js assertSession throws plain errors — classified by message prefix
  await assert.rejects(
    crawl(baseOpts(makeFakeS3(), makeFakeAdapter({ docIds: [boomId], failWith: () => new Error('wenshu: session invalid — login redirect "url:login" at https://x') }))),
    /session invalid/,
  );

  const adapter = makeFakeAdapter({ docIds: [boomId, okId], failWith: (id) => (id === boomId ? new Error("boom") : null) });
  const { manifest, rows } = await crawl(baseOpts(makeFakeS3(), adapter));
  assert.deepEqual(manifest.errors, [{ docId: boomId, error: "boom" }]);
  assert.equal(manifest.counts.errors, 1);
  assert.deepEqual(rows.map((r) => r.docId), [okId]);
});

test("manifest.errors caps at 50 while counts.errors stays true", async () => {
  const docIds = Array.from({ length: 51 }, (_, i) => (i + 1).toString(16).padStart(32, "0"));
  const adapter = makeFakeAdapter({ docIds, failWith: () => new Error("nope") });
  const { manifest } = await crawl(baseOpts(makeFakeS3(), adapter));
  assert.equal(manifest.errors.length, 50);
  assert.equal(manifest.counts.errors, 51);
  assert.equal(manifest.emitted, 0);
});

test("dryRun touches nothing in S3", async () => {
  const s3 = makeFakeS3();
  const priorId = "88888888888888888888888888888888";
  s3.store.set(seenKey("2026-08"), JSON.stringify({ month: "2026-08", docs: [priorId] }));
  const before = [...s3.store.keys()];
  const { manifest } = await crawl(baseOpts(s3, makeFakeAdapter({ docIds: [priorId, "99999999999999999999999999999999"] }), { dryRun: true }));
  assert.deepEqual([...s3.store.keys()], before);
  // no S3 reads in dry-run → no seen dedup; discovery/fetch still runs
  assert.equal(manifest.emitted, 2);
  assert.equal(manifest.skippedSeen, 0);
});

test("detail fetches are paced ≥ rateMs apart", async () => {
  const docIds = ["01010101010101010101010101010101", "02020202020202020202020202020202", "03030303030303030303030303030303"];
  const adapter = makeFakeAdapter({ docIds });
  await crawl(baseOpts(makeFakeS3(), adapter, { rateMs: 40, checkpointEvery: 100 }));
  const [a, b, c] = adapter.calls.fetchDetail.map((x) => x.at);
  assert.ok(b - a >= 35, `gap1 ${b - a}ms`);
  assert.ok(c - b >= 35, `gap2 ${c - b}ms`);
});
