// Pure-export tests for the wenshu site adapter. No playwright import here:
// only the selector/URL consts and the pure helpers are exercised.
import test from "node:test";
import assert from "node:assert/strict";
import { URLS, SELECTORS, DATE_FILTER_FIELD, normalizeSiteDate, extractDocIdFromUrl } from "../lib/wenshu/site.js";

const HEX32 = "0123456789abcdef0123456789abcdef";

test("normalizeSiteDate: 中文日期 -> ISO with zero padding", () => {
  assert.equal(normalizeSiteDate("2025年9月1日"), "2025-09-01");
  assert.equal(normalizeSiteDate("2025年12月31日"), "2025-12-31");
  assert.equal(normalizeSiteDate("判决时间：2025年10月8日"), "2025-10-08");
});

test("normalizeSiteDate: dash/slash/dot forms drop time parts", () => {
  assert.equal(normalizeSiteDate("2025-09-01 00:00:00"), "2025-09-01");
  assert.equal(normalizeSiteDate("2025/09/01"), "2025-09-01");
  assert.equal(normalizeSiteDate("2025-9-1"), "2025-09-01");
  assert.equal(normalizeSiteDate("2025.09.01"), "2025-09-01");
});

test("normalizeSiteDate: null passthrough, garbage and calendar-invalid -> null", () => {
  assert.equal(normalizeSiteDate(""), null);
  assert.equal(normalizeSiteDate(null), null);
  assert.equal(normalizeSiteDate(undefined), null);
  assert.equal(normalizeSiteDate("not a date"), null);
  assert.equal(normalizeSiteDate("2025-02-30"), null);
});

test("extractDocIdFromUrl: ?docId=32hex -> id", () => {
  assert.equal(extractDocIdFromUrl(`${URLS.search}?docId=${HEX32}`), HEX32);
  assert.equal(extractDocIdFromUrl(`https://wenshu.court.gov.cn/x?docId=${HEX32.toUpperCase()}`), HEX32);
  assert.equal(extractDocIdFromUrl(`?docId=${HEX32}`), HEX32); // relative form
});

test("extractDocIdFromUrl: missing / empty -> null", () => {
  assert.equal(extractDocIdFromUrl(URLS.search), null);
  assert.equal(extractDocIdFromUrl(null), null);
  assert.equal(extractDocIdFromUrl("https://wenshu.court.gov.cn/x?docId="), null);
});

// Live-verified 2026-09-19: the post-2024 UI references documents by an
// ENCRYPTED token (contains `/`), not a 32-hex id. Tokens pass through
// verbatim; 32-hex values normalize to lowercase. The fixture below is
// synthetic — never paste a real docId into a test.
test("extractDocIdFromUrl: encrypted token passes through verbatim", () => {
  // A literal `+` is absent on purpose: inside a query string it decodes to a
  // space and cannot round-trip, and the live tokens observed avoid it.
  const token = "YIj/gxVKLIZmu0qCtJFTq3LZk8P8PdUl2iLiBG8ecmqiPbFbWeiMo9pLLUoIp9Kmajz7l97pj5KfTObFKDCQmOAMg0fwPQRPc4tSebu3GKU/x1Ndj";
  assert.equal(extractDocIdFromUrl(`?docId=${token}`), token);
  assert.equal(extractDocIdFromUrl(`https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${token}`), token);
  assert.equal(extractDocIdFromUrl(`https://wenshu.court.gov.cn/x?docId=${HEX32.slice(1)}`), HEX32.slice(1)); // 31-hex is still an opaque token, not dropped
});

test("URLS.detail embeds the raw docId on the detail page URL", () => {
  assert.equal(
    URLS.detail(HEX32),
    `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${HEX32}`
  );
  assert.match(URLS.list("03"), /181217BMTKHNT2W0\/index\.html\?s8=03$/);
});

test("SELECTORS: detail catalog is locked and every value is a non-empty string", () => {
  const expected = [
    "案号", "标题", "法院", "案由", "省", "市", "案件类型", "文书类型", "审理程序",
    "案例级别", "法院级别", "法条", "判决时间", "发布时间", "受理时间", "判决结果", "qwContent",
  ];
  assert.deepEqual(Object.keys(SELECTORS.detail), expected);
  for (const [k, v] of Object.entries(SELECTORS.detail)) {
    assert.equal(typeof v, "string", `${k} must be a string`);
    assert.ok(v.length > 0, `${k} must be non-empty`);
  }
});

test("SELECTORS: core keys and DATE_FILTER_FIELD are populated", () => {
  for (const k of [
    "resultCount", "resultOverflow", "resultItem", "resultDocId", "nextPage",
    "dateStartInput", "dateEndInput", "dateApply", "provinceFilter", "caseTypeFilter",
    "filterApply", "canonicalLink",
  ]) {
    assert.equal(typeof SELECTORS[k], "string", `${k} must be a string`);
    assert.ok(SELECTORS[k].length > 0, `${k} must be non-empty`);
  }
  assert.ok(Array.isArray(SELECTORS.loggedIn) && SELECTORS.loggedIn.length > 0);
  assert.ok(Array.isArray(SELECTORS.loginRedirect) && SELECTORS.loginRedirect.length > 0);
  assert.equal(typeof DATE_FILTER_FIELD, "string");
  assert.ok(DATE_FILTER_FIELD.length > 0);
});
