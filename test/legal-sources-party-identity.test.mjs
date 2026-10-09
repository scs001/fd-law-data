// party-regulation incremental identity: the incremental state must be keyed
// by the canonical article URL while the ROW identity stays versioned
// (`URL@v-<hash>`), because the loader retires prior versions by
// metadata.canonical_url (document-loader.js RETIRE_PRIOR_VERSIONS).
//
// Before this change the state was written under `URL@v-<hash>` and read under
// `URL`, so no document ever hit a known key (production audit 2026-10-10:
// 0 of 193 documents kept their content_hash across two runs).
import test from "node:test";
import assert from "node:assert/strict";
import { partyRegulationAdapter } from "../lib/legal-sources/sources/party-regulation.js";
import { crawlLegalSource } from "../lib/legal-sources/runtime.js";
import { emptyState, rememberSuccess, selectTargets, stateKeyOf } from "../lib/legal-sources/state.js";

const ARTICLE_URL = "https://www.12371.cn/2026/01/01/ARTItl1.shtml";

// The CMS wraps the article in repaste.body markers; everything outside is
// site chrome (nav, 热搜, 责任编辑, footer) that churns between runs.
function detailPage({ body, chrome = "网站导航", reading = "" }) {
  return `<html><head><title>中国共产党巡视工作条例_共产党员网</title></head><body>
    <div class="nav">${chrome}</div>
    <div class="title_bottom"><i class="time">发布时间：2026年01月01日 09:00      来源：新华社</i></div>
    <div id="font_area"><!--repaste.body.begin--><div class="con"><div class="word">
      <p>　　第一条　为了强化巡视工作。</p>
      <p>　　第二条　${body}</p>
      ${reading}
    </div></div><!--repaste.body.end--></div>
    <div class="footer">共产党员网 版权所有 ${chrome}</div>
  </body></html>`;
}

function helper(html) {
  return {
    fetchText: async () => html,
    fetchJson: async () => { throw new Error("unexpected JSON"); },
    fetchBuffer: async () => ({ body: Buffer.alloc(0), contentType: "application/pdf" }),
  };
}

function entry(url = ARTICLE_URL) {
  return { source_id: url, url, title: "中国共产党巡视工作条例", metadata_from_list: { category: "regulations" } };
}

async function fetchOnce(html, url = ARTICLE_URL) {
  return partyRegulationAdapter.detail(entry(url), helper(html));
}

function memoryS3() {
  const objects = new Map();
  return {
    objects,
    async getObject(bucket, key) { return objects.get(`${bucket}/${key}`) ?? null; },
    async putObject(bucket, key, body) {
      objects.set(`${bucket}/${key}`, Buffer.isBuffer(body) ? body : Buffer.from(String(body)));
      return {};
    },
    async headObject(bucket, key) {
      const value = objects.get(`${bucket}/${key}`);
      return value ? { contentLength: value.length } : null;
    },
  };
}

test("party detail keeps the versioned row id but hands the canonical URL to the state", async () => {
  const detail = await fetchOnce(detailPage({ body: "党的中央和地方各级委员会设立巡视组。" }));
  assert.match(detail.document.source_id, /^https:\/\/www\.12371\.cn\/2026\/01\/01\/ARTItl1\.shtml@v-[0-9a-f]{20}$/);
  assert.equal(detail.document.state_key, ARTICLE_URL);
  assert.equal(detail.document.metadata.canonical_url, ARTICLE_URL);
  assert.equal(detail.document.metadata.canonical_source_id, ARTICLE_URL);
  assert.equal(stateKeyOf(detail.document), ARTICLE_URL);
});

test("chrome churn leaves the content hash untouched; a real revision changes it", async () => {
  const stable = detailPage({ body: "党的中央和地方各级委员会设立巡视组。" });
  // Same regulation, different nav/footer/whitespace: the hash must not move.
  const churned = detailPage({ body: "党的中央和地方各级委员会设立巡视组。", chrome: "热搜：党的二十届四中全会" })
    .replace(/\n\s+/g, "\r\n      ");
  const first = await fetchOnce(stable);
  const second = await fetchOnce(churned);
  assert.equal(first.document.content_hash ?? first.document.source_id, second.document.source_id);
  assert.equal(first.document.source_id, second.document.source_id);

  const revised = detailPage({ body: "党的中央和地方各级委员会设立巡视组，每半年向党中央报告一次。" });
  const third = await fetchOnce(revised);
  assert.notEqual(first.document.source_id, third.document.source_id, "a real revision must be its own row");
  assert.equal(third.document.state_key, ARTICLE_URL, "but the same entity for incremental purposes");
  assert.equal(third.document.metadata.canonical_url, ARTICLE_URL);
});

test("the 延伸阅读 related-links block is outside the hash", async () => {
  const reading = `<p>　　<strong>延伸阅读</strong></p>
    <p>　　<a href="https://news.12371.cn/2015/03/12/ARTI1.shtml" target="_blank">中央巡视办负责人答记者问</a></p>`;
  const withReading = detailPage({ body: "巡视组实行组长负责制。", reading });
  const withoutReading = detailPage({ body: "巡视组实行组长负责制。" });
  const a = await fetchOnce(withReading);
  const b = await fetchOnce(withoutReading);
  assert.equal(a.document.source_id, b.document.source_id);
  assert.equal(a.document.metadata.extended_reading_dropped, true);
  assert.equal(b.document.metadata.extended_reading_dropped, false);
});

test("a stable body is skipped on the second run and re-fetched only when it changes", async () => {
  const s3 = memoryS3();
  const html = detailPage({ body: "党的中央和地方各级委员会设立巡视组。" });
  const listEntries = [entry()];
  const adapter = (page) => ({
    mode: "http",
    rateMs: 0,
    async list() { return { entries: listEntries, total: 1, pages: 1, unreachablePages: [] }; },
    detail: (e) => partyRegulationAdapter.detail(e, helper(page)),
  });

  const first = await crawlLegalSource({ s3, bucket: "laws", source: "party-regulation-library", adapter: adapter(html), rateMs: 0 });
  assert.equal(first.manifest.coverage.emitted, 1);
  // State is written under the CANONICAL url, which is what the list side
  // carries; the versioned row id would never be looked up again.
  assert.ok(first.state.hashes[ARTICLE_URL]);
  assert.equal(first.state.hashes[first.records[0].source_id], undefined);

  // Run 2: the list side looks up source_id == canonical url -> hit -> skip.
  const second = await crawlLegalSource({ s3, bucket: "laws", source: "party-regulation-library", adapter: adapter(html), rateMs: 0 });
  assert.equal(second.manifest.coverage.planned, 0, "known article must not be re-planned");
  assert.equal(second.manifest.coverage.skippedUnchanged, 0);
  assert.equal(second.manifest.coverage.emitted, 0);
  assert.equal(second.records.length, 0);
  const { skipped } = selectTargets(listEntries, second.state, { mode: "incremental" });
  assert.deepEqual(skipped.map((s) => s.reason), ["unchanged"]);

  // A real revision is NOT detectable from the list: party's list carries no
  // per-item hash, so `selectTargets` degenerates to "known id -> skip" and
  // the article stays skipped until a --full run or an --entries re-fetch.
  // That is the same predicate the healthy sources rely on (design D1: fix the
  // key, not the predicate), so correctness here means: the key HITS.
  const revisedHtml = detailPage({ body: "党的中央和地方各级委员会设立巡视组，每年至少报告一次。" });
  const third = await crawlLegalSource({ s3, bucket: "laws", source: "party-regulation-library", adapter: adapter(revisedHtml), rateMs: 0 });
  assert.equal(third.manifest.coverage.planned, 0);
  assert.equal(third.manifest.coverage.emitted, 0);
  assert.equal(third.manifest.coverage.listed, 1);

  // A --full run sees the revision: new row id, same canonical url, and the
  // refreshed hash lands under the canonical state key.
  const fourth = await crawlLegalSource({ s3, bucket: "laws", source: "party-regulation-library", adapter: adapter(revisedHtml), mode: "full", rateMs: 0 });
  assert.equal(fourth.manifest.coverage.planned, 1);
  assert.equal(fourth.manifest.coverage.emitted, 1);
  assert.notEqual(fourth.records[0].source_id, first.records[0].source_id);
  assert.equal(fourth.records[0].metadata.canonical_url, ARTICLE_URL);
  assert.equal(fourth.state.hashes[ARTICLE_URL], fourth.records[0].content_hash);
  assert.equal(fourth.records[0].state_key, ARTICLE_URL);
});

test("row identity stays versioned across a revision so prior rows retire", async () => {
  const v1 = await fetchOnce(detailPage({ body: "巡视组实行组长负责制。" }));
  const v2 = await fetchOnce(detailPage({ body: "巡视组实行组长负责制，并向党中央报告。" }));
  for (const detail of [v1, v2]) {
    assert.match(detail.document.source_id, /@v-[0-9a-f]{20}$/);
    // document-loader.js RETIRE_PRIOR_VERSIONS matches on canonical_url, and
    // the loader's NOT-null target column set includes it.
    assert.equal(detail.document.metadata.canonical_url, ARTICLE_URL);
    assert.equal(detail.document.metadata.is_current, true);
  }
  assert.notEqual(v1.document.source_id, v2.document.source_id);
});

test("missing body markers degrade to whole-page hashing, visibly", async () => {
  const bare = `<h1>中国共产党巡视工作条例</h1><p>第一条　为了强化巡视工作。</p>`;
  const detail = await fetchOnce(bare);
  assert.equal(detail.document.metadata.body_scoped, false);
  assert.equal(detail.document.state_key, ARTICLE_URL, "identity is stable even when scoping fails");
  assert.match(detail.document.source_id, /@v-[0-9a-f]{20}$/);
});

test("sources without state_key keep state keyed by source_id exactly as before", () => {
  const state = emptyState("legacy-source");
  rememberSuccess(state, { sourceId: "doc-1", hash: "h1" });
  assert.deepEqual(state.hashes, { "doc-1": "h1" });

  const entries = [{ source_id: "doc-1" }, { source_id: "doc-2" }];
  const { targets, skipped } = selectTargets(entries, state, { mode: "incremental" });
  assert.deepEqual(targets.map((e) => e.source_id), ["doc-2"]);
  assert.deepEqual(skipped.map((s) => s.reason), ["unchanged"]);

  // No state_key anywhere -> the state key IS source_id.
  assert.equal(stateKeyOf({ source_id: "doc-1" }), "doc-1");
  assert.equal(stateKeyOf({ source_id: "doc-1", state_key: "" }), "doc-1");
  assert.equal(stateKeyOf({ source_id: "doc-1", state_key: "  " }), "doc-1");
  // An entry with no source_id is still skipped with the missing-source_id
  // reason rather than silently keyed on undefined.
  const orphan = selectTargets([{ url: "u" }], state, { mode: "incremental" });
  assert.deepEqual(orphan.skipped.map((s) => s.reason), ["missing source_id"]);
});

test("a versioned entry whose state_key is set is skipped, and whose body changed is not", () => {
  const state = emptyState("party-regulation-library");
  rememberSuccess(state, { sourceId: ARTICLE_URL, hash: "h1" });
  const entries = [{ source_id: ARTICLE_URL, state_key: ARTICLE_URL }];
  const hit = selectTargets(entries, state, { mode: "incremental" });
  assert.deepEqual(hit.targets, []);
  assert.deepEqual(hit.skipped.map((s) => s.reason), ["unchanged"]);

  // A changed list-level hash re-plans it even under a known state key.
  const changed = selectTargets([{ source_id: ARTICLE_URL, state_key: ARTICLE_URL, hash: "h2" }], state, { mode: "incremental" });
  assert.equal(changed.targets.length, 1);

  // Full mode ignores the state key entirely.
  const full = selectTargets(entries, state, { mode: "full" });
  assert.equal(full.targets.length, 1);
});
