// Curated "不再参照" (no longer to be referred to) list for 指导性案例.
//
// Deprecations are announced by standalone SPC notices published in the
// 权威发布 column — which the channel list pages do NOT index (verified
// 2026-09-21: neither notice appears under /fabu/gengduo/16|17|22.html; only
// the site's own search, /search.html?content=不再参照, surfaces them). They
// therefore cannot be discovered by crawling the case column, and the list is
// maintained by hand. The loader applies it, so extending the list needs no
// re-crawl (design.md D6). Each entry carries its provenance so a row's status
// traces back to the notice that set it.
//
// Completeness check 2026-09-21: a site search for 不再参照 / 部分指导性案例
// returns exactly these two notices; searches for 废止/失效/停止参照 of guiding
// cases return nothing. The case pages themselves stay online after
// deprecation — the notice withdraws the reference, not the case.
//
// `announcedAt` is the notice's own date (落款); `publishedAt` is the page's
// 发布时间 field, which can differ by a day.

export const REFERENCE_EFFECTIVE = "有效";
export const REFERENCE_SUPERSEDED = "不再参照";

export const DEPRECATION_NOTICES = [
  {
    docNo: "法〔2020〕343号",
    title: "最高人民法院关于部分指导性案例不再参照的通知",
    announcedAt: "2020-12-29",
    publishedAt: "2020-12-30",
    effectiveAt: "2021-01-01",
    url: "https://www.court.gov.cn/fabu/xiangqing/282441.html",
    caseNumbers: [9, 20],
  },
  {
    docNo: "法〔2026〕119号",
    title: "最高人民法院关于部分指导性案例不再参照的通知",
    announcedAt: "2026-08-05",
    publishedAt: "2026-08-06",
    effectiveAt: "2026-08-15",
    url: "https://www.court.gov.cn/fabu/xiangqing/508031.html",
    caseNumbers: [123, 136, 139, 204],
  },
];

/** case number -> the notice that deprecated it (last notice wins). */
export function deprecationsByCaseNo() {
  const map = new Map();
  for (const notice of DEPRECATION_NOTICES) {
    for (const caseNo of notice.caseNumbers) map.set(Number(caseNo), notice);
  }
  return map;
}

export function referenceStatus(caseNo, byCaseNo = deprecationsByCaseNo()) {
  return byCaseNo.has(Number(caseNo)) ? REFERENCE_SUPERSEDED : REFERENCE_EFFECTIVE;
}

/** Notice doc number that deprecated the case, or null. */
export function deprecationDocNo(caseNo, byCaseNo = deprecationsByCaseNo()) {
  return byCaseNo.get(Number(caseNo))?.docNo ?? null;
}
