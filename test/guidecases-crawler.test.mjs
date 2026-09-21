// Unit tests for the guiding-cases crawler (lib/guidecases/crawler.js).
// Fakes only: Map-backed S3 + a URL->HTML map — no network.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  crawl, sweepColumn, contentHash, toInstant, parsePager, foldSnapshots, partKey, manifestKey,
} from "../lib/guidecases/crawler.js";
import { parseDetailPage, SelectorDriftError } from "../lib/guidecases/site.js";

const fixture = (name) => readFileSync(new URL(`./fixtures/guidecases/${name}`, import.meta.url), "utf8");
const detail279 = fixture("detail-279.html");
const detail001 = fixture("detail-001.html");
const detailNotice = fixture("detail-notice.html");

function makeFakeS3() {
  const store = new Map();
  return {
    store,
    calls: [],
    async getObject(bucket, key) {
      return store.has(key) ? Buffer.from(store.get(key), "utf8") : null;
    },
    async putObject(bucket, key, body) {
      this.calls.push({ op: "putObject", key });
      store.set(key, body.toString("utf8"));
      return { etag: `"${store.size}"` };
    },
    async headObject(bucket, key) {
      return store.has(key)
        ? { contentLength: Buffer.byteLength(store.get(key), "utf8"), etag: "e" }
        : null;
    },
    async listObjects(bucket, { prefix = "" } = {}) {
      return {
        contents: [...store.keys()]
          .filter((k) => k.startsWith(prefix))
          .map((key) => ({ key, size: Buffer.byteLength(store.get(key), "utf8") })),
        truncated: false,
      };
    },
  };
}

const li = (id, title, date = "2026-02-28") =>
  `<li><a title="${title}" target="_blank" href="/shenpan/xiangqing/${id}.html">${title}</a> <i class="date">${date}</i></li>`;

function listHtml({ items, total, nextHref = null, lastPage = 1 }) {
  return `<div class="sec_list"><ul>${items.join("\n")}</ul>
  <div class="clearfix btm_row">
    <div class="fl count">共<span class="num">${total}</span>篇文章</div>
    <div class="fr page"><ul id="yw1" class="yiiPager">
      <li class="next${nextHref ? "" : " hidden"}"><a href="${nextHref ?? "/shenpan/gengduo/77.html"}">下一页</a></li>
      <li class="last hidden"><a href="/shenpan/gengduo/77_${lastPage}.html">尾页</a></li>
    </ul></div>
  </div></div>`;
}

const caseTitle = (n) => `指导性案例${n}号：测试案件${n}`;

test("contentHash is stable, ignores fetch time, and tracks section edits", () => {
  const base = {
    title: "指导性案例279号：测试",
    source: "最高人民法院新闻局",
    publishAt: "2026-02-28 18:50:04",
    listedAt: "2026-02-28",
    sections: { gist: "要点", facts: "案情" },
    body: "正文",
  };
  const h1 = contentHash(base);
  assert.equal(contentHash({ ...base, fetched_at: "2026-09-21T00:00:00Z" }), h1);
  assert.equal(contentHash({ ...base, sections: { ...base.sections, gist: "要点2" } }) === h1, false);
});

test("toInstant pins the site's wall clock to +08:00 and tolerates garbage", () => {
  assert.equal(toInstant("2026-02-28 18:50:04"), "2026-02-28T18:50:04+08:00");
  assert.equal(toInstant("2026-02-28"), "2026-02-28T00:00:00+08:00");
  assert.equal(toInstant(""), null);
  assert.equal(toInstant("近期"), null);
});

test("parsePager reads the column total and the live next link", () => {
  const p1 = parsePager(fixture("list-page-1.html"));
  assert.deepEqual(p1, { total: 293, nextPage: 2, lastPage: 15 });
  const p15 = parsePager(fixture("list-page-15.html"));
  assert.equal(p15.total, 293);
  assert.equal(p15.nextPage, null); // 下一页 carries the `hidden` class on the last page
  assert.equal(p15.lastPage, 15);
});

test("sweepColumn walks to the last page and accounts for every entry", async () => {
  const pages = {
    1: listHtml({ items: [li("1", caseTitle(1)), li("2", caseTitle(2))], total: 3, nextHref: "/shenpan/gengduo/77_2.html", lastPage: 2 }),
    2: listHtml({ items: [li("3", caseTitle(3)), li("4", "最高人民法院关于发布第一批指导性案例的通知")], total: 4, lastPage: 2 }),
  };
  const fetchPage = async (url) => pages[/77_?(\d*)\.html$/.exec(url)[1] || 1];
  const sweep = await sweepColumn({ fetchPage });
  assert.equal(sweep.pages, 2);
  assert.equal(sweep.entries.length, 4);
  assert.equal(sweep.cases.length, 3);
  assert.equal(sweep.notices.length, 1);
  assert.deepEqual(sweep.coverage, { min: 1, max: 3, count: 3, missing: [] });
});

test("sweepColumn fails loudly when the parsed entries do not match the reported total", async () => {
  const fetchPage = async () => listHtml({ items: [li("1", caseTitle(1))], total: 5, lastPage: 1 });
  await assert.rejects(() => sweepColumn({ fetchPage }), /reports 5 articles but 1 entries parsed/);
});

test("sweepColumn fails loudly on a duplicate case number", async () => {
  const fetchPage = async () => listHtml({ items: [li("1", caseTitle(7)), li("2", caseTitle(7))], total: 2, lastPage: 1 });
  await assert.rejects(() => sweepColumn({ fetchPage }), /case number 7 appears twice/);
});

function columnOf(entries) {
  // one-page column: entries are the whole column
  return listHtml({ items: entries, total: entries.length, lastPage: 1 });
}

const twoCases = [li("90001", caseTitle(901)), li("90002", "最高人民法院关于发布第一批指导性案例的通知")];
const detailFor = () => ({ "90001": detail279, "90002": detailNotice });

test("crawl emits a snapshot once and is a no-op on an unchanged re-run", async () => {
  const s3 = makeFakeS3();
  const pages = { "https://www.court.gov.cn/shenpan/gengduo/77.html": columnOf(twoCases), ...Object.fromEntries(
    Object.entries(detailFor()).map(([id, html]) => [`https://www.court.gov.cn/shenpan/xiangqing/${id}.html`, html]),
  ) };
  const fetchPage = async (url) => {
    if (!(url in pages)) throw new Error(`HTTP 404 for ${url}`);
    return pages[url];
  };

  const first = await crawl({ s3, bucket: "laws", rateMs: 0, fetchPage, log: () => {} });
  assert.equal(first.manifest.emitted, 2);
  assert.equal(first.manifest.unchanged, 0);
  assert.deepEqual(first.manifest.coverage, { min: 901, max: 901, count: 1, missing: [] });
  const caseRecord = first.records.find((r) => r.doc_type === "case");
  assert.equal(caseRecord.source_id, "90001");
  assert.equal(caseRecord.case_no, 901);
  assert.equal(caseRecord.sections.keyword.startsWith("民事/侵害计算机软件著作权"), true);
  assert.equal(caseRecord.content_hash, first.manifest.hashes["90001"]);
  const noticeRecord = first.records.find((r) => r.doc_type === "notice");
  assert.equal(noticeRecord.case_no, null);
  assert.equal(noticeRecord.sections.gist, null);

  const second = await crawl({ s3, bucket: "laws", rateMs: 0, fetchPage, log: () => {} });
  assert.equal(second.manifest.emitted, 0);
  assert.equal(second.manifest.unchanged, 2);
  assert.equal(second.records.length, 0);
  const parts = [...s3.store.keys()].filter((k) => k.endsWith(".jsonl"));
  assert.equal(parts.length, 1, "a second unchanged run must not write another part");
  assert.equal(parts[0], partKey(first.manifest.runDate, 1));
});

test("crawl re-emits only the record whose content changed", async () => {
  const s3 = makeFakeS3();
  const pages = { "https://www.court.gov.cn/shenpan/gengduo/77.html": columnOf(twoCases), ...Object.fromEntries(
    Object.entries(detailFor()).map(([id, html]) => [`https://www.court.gov.cn/shenpan/xiangqing/${id}.html`, html]),
  ) };
  const fetchPage = async (url) => pages[url];
  const first = await crawl({ s3, bucket: "laws", rateMs: 0, fetchPage, log: () => {} });
  assert.equal(first.manifest.emitted, 2);

  // edit the document body — not the breadcrumb, and not a run the CMS split
  // across <span> wrappers (the notice page fragments its numbering that way)
  const needle = "各省、自治区、直辖市高级人民法院，解放军军事法院";
  pages["https://www.court.gov.cn/shenpan/xiangqing/90002.html"] = detailNotice.replace(needle, `${needle}（修订）`);
  const third = await crawl({ s3, bucket: "laws", rateMs: 0, fetchPage, log: () => {} });
  assert.equal(third.manifest.emitted, 1);
  assert.equal(third.manifest.unchanged, 1);
  assert.equal(third.records[0].source_id, "90002");
  // the same day's parts are append-only: the new records go to a new part and
  // the first run's part is left exactly as it was
  const partsAfter = [...s3.store.keys()].filter((k) => k.endsWith(".jsonl")).sort();
  assert.equal(partsAfter.length, 2);
  assert.equal(partsAfter[0], partKey(first.manifest.runDate, 1));
  assert.equal(partsAfter[1], partKey(first.manifest.runDate, 2));
  assert.equal(
    s3.store.get(partsAfter[0]).trim().split("\n").length,
    2,
    "the first part must still hold the two records of the first run",
  );
  assert.equal(s3.store.get(partsAfter[1]).trim().split("\n").length, 1);
});

test("crawl writes nothing when a detail page fails (no half-finished snapshot)", async () => {
  const s3 = makeFakeS3();
  const fetchPage = async (url) => {
    if (url.endsWith("/shenpan/gengduo/77.html")) return columnOf(twoCases);
    if (url.endsWith("90002.html")) throw new Error("HTTP 503 for detail page");
    return detail279;
  };
  await assert.rejects(() => crawl({ s3, bucket: "laws", rateMs: 0, fetchPage, log: () => {} }), /503/);
  assert.equal([...s3.store.keys()].length, 0);
});

test("crawl aborts when a case page carries none of the known sections", async () => {
  const s3 = makeFakeS3();
  const emptyCase = `<div class="detail"><div class="title">指导性案例901号：测试</div>
    <div class="clearfix detail_mes"><ul class="clearfix fl message"><li class="fl">来源：x</li>
    <li class="fl">发布时间：2026-01-01 00:00:00</li></ul></div>
    <div class="txt_txt">改版后的正文，没有任何已知的小节标题。</div></div>`;
  const fetchPage = async (url) => (url.endsWith("/shenpan/gengduo/77.html") ? columnOf([li("90001", caseTitle(901))]) : emptyCase);
  await assert.rejects(() => crawl({ s3, bucket: "laws", rateMs: 0, fetchPage, log: () => {} }), SelectorDriftError);
  assert.equal([...s3.store.keys()].length, 0);
});

test("crawl --limit marks the manifest partial and keeps the coverage of the full sweep", async () => {
  const s3 = makeFakeS3();
  const fetchPage = async (url) => {
    if (url.endsWith("/shenpan/gengduo/77.html")) return columnOf(twoCases);
    return url.includes("90001") ? detail279 : detailNotice;
  };
  const { manifest } = await crawl({ s3, bucket: "laws", rateMs: 0, limit: 1, fetchPage, log: () => {} });
  assert.equal(manifest.partial, true);
  assert.equal(manifest.sweep.observed, 1);
  assert.equal(manifest.sweep.entries, 2); // the sweep still saw the whole column
  assert.equal(manifest.emitted, 1);
});

test("foldSnapshots folds parts oldest-first so the newest record wins", async () => {
  const s3 = makeFakeS3();
  await s3.putObject("laws", "guide-cases/2026/09/guide-2026-09-21-part001.jsonl", `${JSON.stringify({ source_id: "1", title: "旧" })}\n`);
  await s3.putObject("laws", "guide-cases/2026/10/guide-2026-10-01-part001.jsonl", `${JSON.stringify({ source_id: "1", title: "新" })}\n`);
  await s3.putObject("laws", "guide-cases/2026/09/guide-2026-09-21.manifest.json", JSON.stringify({ hashes: {} }));
  const { folded, parts, records } = await foldSnapshots(s3, "laws", "guide-cases/");
  assert.equal(parts.length, 2, "manifests are not part files");
  assert.equal(records, 2);
  assert.equal(folded.get("1").title, "新");
});

test("a manifest hash baseline survives without re-reading part files", async () => {
  const s3 = makeFakeS3();
  const date = "2026-09-21";
  await s3.putObject("laws", manifestKey(date), JSON.stringify({ hashes: { "90001": "abc" } }));
  const { hashes } = await (async () => {
    const { loadSnapshotHashes } = await import("../lib/guidecases/crawler.js");
    return { hashes: await loadSnapshotHashes(s3, "laws") };
  })();
  assert.deepEqual(hashes, { "90001": "abc" });
});

test("parseDetailPage output feeds contentHash without depending on section order", () => {
  const parsed = parseDetailPage(detail001, { url: "x" });
  assert.equal(parsed.sections.keyword, "民事 居间合同 二手房买卖 违约");
  assert.equal(Object.values(parsed.sections).every((v) => v === null || v.length > 0), true);
});

test("defaultFetchPage yields text and fails on any non-success status", async () => {
  const { defaultFetchPage } = await import("../lib/guidecases/crawler.js");
  const { setMinInterval } = await import("../lib/http.js");
  setMinInterval(0);
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response("<html>ok</html>", { status: 200 });
    assert.equal(typeof (await defaultFetchPage("https://example.invalid/a")), "string");
    assert.equal(await defaultFetchPage("https://example.invalid/a"), "<html>ok</html>");

    globalThis.fetch = async () => new Response("gone", { status: 404 });
    await assert.rejects(() => defaultFetchPage("https://example.invalid/a"), /HTTP 404/);

    globalThis.fetch = async () => new Response("busy", { status: 503 });
    await assert.rejects(() => defaultFetchPage("https://example.invalid/a"), /HTTP 503/);

    globalThis.fetch = async () => {
      throw new Error("ECONNRESET");
    };
    await assert.rejects(() => defaultFetchPage("https://example.invalid/a"), /ECONNRESET/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
