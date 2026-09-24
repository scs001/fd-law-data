// MFA treaty database. The live site exposes server-rendered list pages under
// /web/{allinfos,shuangbian,duobian}.jsp with ?nPageIndex_=N and detail pages
// /web/detail1.jsp?objid=...
import { createHttpSourceAdapter, extractAnchors, cleanText, labeledValues, stripHtml } from "./common.js";
import { toIsoDateTime } from "../parsing.js";

const BASE = process.env.MFA_TREATY_BASE_URL ?? "https://treaty.mfa.gov.cn/web";
const SCOPE_PAGES = { all: "allinfos.jsp", bilateral: "shuangbian.jsp", multilateral: "duobian.jsp" };

function parseTreatyList(html, { baseUrl, page }) {
  return extractAnchors(html, { baseUrl, hrefPattern: /detail1\.jsp\?objid=/ }).map((anchor) => ({
    source_id: new URL(anchor.url).searchParams.get("objid"),
    title: anchor.title,
    url: anchor.url,
    doc_type: "treaty",
  }));
}

function parseLastPage(html) {
  const tail = [...String(html ?? "").matchAll(/nPageIndex_=(\d+)/g)].map((m) => Number(m[1]));
  return tail.length ? Math.max(...tail) : null;
}

function parseTreatyDetail(html, entry, { baseUrl }) {
  const text = stripHtml(html);
  const labels = labeledValues(html, [
    "条约名称", "缔约方", "类别", "领域", "签订日期", "我国签署时间",
    "生效日期", "条约生效时间", "保存机关", "批准机关", "状态", "条约状态",
  ]);
  const attachments = extractAnchors(html, { baseUrl, hrefPattern: /\.(pdf|docx?|wps)(\?|$)/i })
    .map((anchor) => ({ title: anchor.title, url: anchor.url, filename: decodeURIComponent(new URL(anchor.url).pathname.split("/").pop()) }));
  const content = text || null;
  const status = labels["状态"] ?? labels["条约状态"] ?? null;
  return {
    title: cleanText(entry.title),
    published_at: labels["我国签署时间"] ?? labels["签订日期"],
    effective_at: labels["条约生效时间"] ?? labels["生效日期"],
    status,
    authority: labels["保存机关"] ?? null,
    language: "zh-CN",
    content,
    metadata: {
      parties: labels["缔约方"] ?? null,
      category: labels["类别"] ?? null,
      domain: labels["领域"] ?? null,
      depositary: labels["保存机关"] ?? null,
      approval_authority: labels["批准机关"] ?? null,
      raw_labels: labels,
    },
    attachments,
  };
}

export const mfaTreatyAdapter = createHttpSourceAdapter({
  id: "mfa-treaty-library",
  envPrefix: "MFA_TREATY",
  docType: "treaty",
  rateMs: Number(process.env.MFA_TREATY_RATE_MS ?? 1100),
  list: {
    kind: "html",
    // scope=all|bilateral|multilateral lets a full catalog be crawled as two
    // shorter list phases (~350 pages each) — on the small xinru node the
    // single 747-page enumeration window was where runs kept getting killed.
    url: process.env.MFA_TREATY_LIST_URL
      ?? ((filters = {}) => `${BASE}/${SCOPE_PAGES[filters.scope] ?? SCOPE_PAGES.all}?nPageIndex_={page}`),
    size: 10,
    parsePages: parseLastPage,
  },
  parseList: parseTreatyList,
  detail: { kind: "html" },
  parseDetail: parseTreatyDetail,
});

export default mfaTreatyAdapter;
