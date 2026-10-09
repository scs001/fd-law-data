// Incremental identity stability (change rmfyalk-incremental-identity).
//
// The incremental skip only works when the state key survives across runs.
// Three sources were keyed on something that moves — a per-request rotating
// token (rmfyalk), a whole-page content hash (party), an un-normalised URL
// (gov-rules) — so every nightly run re-fetched the whole corpus while
// reporting success. These tests pin the invariant where it broke: the id
// derived from a list entry must be identical for the same entity listed on
// two different days, and must stay distinct for genuinely different
// entities.
import test from "node:test";
import assert from "node:assert/strict";

import { rmfyalkAdapter } from "../lib/legal-sources/sources/rmfyalk.js";
import { govRulesAdapter } from "../lib/legal-sources/sources/gov-rules.js";
import { selectTargets } from "../lib/legal-sources/state.js";

// A one-page list: totalCount/totalPage make the adapter stop after page 1.
function jsonHelpers(payloads) {
  let call = 0;
  return {
    async fetchJson() {
      const payload = Array.isArray(payloads) ? payloads[Math.min(call, payloads.length - 1)] : payloads;
      call += 1;
      return payload;
    },
    async fetchText() {
      throw new Error("unused");
    },
  };
}

// ── rmfyalk: identity is the case number, not the rotating token ────────────

function rmfyalkPage(token, caseNo) {
  return {
    code: "0",
    data: {
      totalCount: 1,
      totalPage: 1,
      datas: [{
        id: token,
        cpws_al_id: token,
        cpws_al_no: caseNo,
        cpws_al_title: "某某盗窃案",
        cpws_al_type: "02",
      }],
    },
  };
}

test("rmfyalk identity survives a token rotation", async () => {
  // Same case listed on two days: the API hands out a fresh opaque id each
  // request. The case number is what must stay put.
  const day1 = await rmfyalkAdapter.list({}, jsonHelpers(rmfyalkPage("token-AAA%3D", "2026-13-2-167-004")));
  const day2 = await rmfyalkAdapter.list({}, jsonHelpers(rmfyalkPage("token-BBB%3D", "2026-13-2-167-004")));
  assert.equal(day1.entries.length, 1);
  assert.equal(day2.entries.length, 1);
  assert.equal(day1.entries[0].source_id, day2.entries[0].source_id);
  assert.equal(day1.entries[0].source_id, "2026-13-2-167-004");
});

test("rmfyalk detail URL still carries the rotating token", async () => {
  // The content API keys on the token: sending a case number yields
  // "参数gid有误" (verified live 2026-09-24). Identity changed, gid must not.
  const listed = await rmfyalkAdapter.list({}, jsonHelpers(rmfyalkPage("token-BBB%3D", "2026-13-2-167-004")));
  const entry = listed.entries[0];
  assert.equal(entry.source_id, "2026-13-2-167-004");
  assert.ok(entry.url.includes(encodeURIComponent("token-BBB%3D")),
    "detail URL must keep the API token");
  // ...and the list row is preserved so the detail body can recover the token
  // (gid must be the API token, never the case number).
  assert.equal(entry.list_row?.id, "token-BBB%3D");
});

test("rmfyalk flags a token-derived identity when no case number exists", async () => {
  const page = rmfyalkPage("only-a-token%3D", "2026-13-2-167-004");
  delete page.data.datas[0].cpws_al_no;
  const listed = await rmfyalkAdapter.list({}, jsonHelpers(page));
  assert.equal(listed.entries.length, 1);
  // Prefixed so a token-derived key is unmistakable in the corpus and state,
  // and can never masquerade as a stable natural key.
  assert.match(listed.entries[0].source_id, /^tok:/);
});

test("rmfyalk known ids are skipped on the second run", async () => {
  const run1 = await rmfyalkAdapter.list({}, jsonHelpers(rmfyalkPage("token-AAA%3D", "2026-13-2-167-004")));
  const state = { hashes: { [run1.entries[0].source_id]: "some-hash" }, failures: {} };
  const run2 = await rmfyalkAdapter.list({}, jsonHelpers(rmfyalkPage("token-ZZZ%3D", "2026-13-2-167-004")));
  const { targets, skipped } = selectTargets(run2.entries, state, { mode: "incremental" });
  assert.equal(targets.length, 0, "known case must not be re-fetched");
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "unchanged");
});

// ── gov-rules: identity survives an http/https flip ────────────────────────

function govRulesPage(url) {
  // The gateway envelope: resultCode.code must be "200" or the adapter throws,
  // rows live under result.data.list and paging under result.data.pager.
  return {
    resultCode: { code: "200" },
    result: {
      data: {
        pager: { total: 1, pageCount: 1 },
        list: [{
          f_202321360426: "船舶污染海洋环境防治管理规定",
          f_202321915922: "2016-05-30",
          doc_pub_url: url,
          f_202344311304: "交通运输部令2016年第XX号",
        }],
      },
    },
  };
}

async function govRulesListed(url) {
  const helpers = jsonHelpers(govRulesPage(url));
  // gov-rules walks two categories (department + local); the same payload is
  // returned for both, and its list() de-dupes by source_id — which is itself
  // part of what these tests pin (a scheme flip must collapse, not duplicate).
  return govRulesAdapter.list({ size: 10 }, helpers);
}

test("gov-rules identity is scheme-stable", async () => {
  const http = await govRulesListed("http://www.gov.cn/zhengce/2016-05/30/content_5721412.htm");
  const https = await govRulesListed("https://www.gov.cn/zhengce/2016-05/30/content_5721412.htm");
  assert.equal(http.entries.length, 1);
  assert.equal(https.entries.length, 1);
  // Same document, only the scheme differs -> same identity.
  assert.equal(http.entries[0].source_id, https.entries[0].source_id);
});

test("gov-rules keeps a genuine re-publication distinct", async () => {
  const a = await govRulesListed("http://www.gov.cn/zhengce/2016-05/30/content_5721412.htm");
  const b = await govRulesListed("https://www.gov.cn/zhengce/2016-05/30/content_7082786.htm");
  assert.equal(a.entries.length, 1);
  assert.equal(b.entries.length, 1);
  // A different content id is a different document and must NOT collapse.
  assert.notEqual(a.entries[0].source_id, b.entries[0].source_id);
});
