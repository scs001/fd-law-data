// CCDI supervisory regulations. The fgk library is protected by a JS cookie
// challenge in plain curl; the adapter remains HTTP-first and treats a
// challenge page as structure drift. Browser/session mode can be supplied by a
// future adapter without changing runtime or loader contracts.
import { createHttpSourceAdapter, extractAnchors, cleanText, labeledValues, stripHtml } from "./common.js";
import { StructureDriftError } from "../errors.js";

const BASE = process.env.CCDI_BASE_URL ?? "https://www.ccdi.gov.cn";
const DEFAULT_LIST = process.env.CCDI_SUPERVISORY_LIST_URL ?? `${BASE}/fgk/`;

const CATEGORIES = {
  supervisory_law: "监察法律",
  implementation: "实施条例",
  supporting: "配套规定",
  interpretation: "解释性文件",
  announcement: "公告",
};

function assertNotChallenge(html, url) {
  if (/window\.open\(["']\/fgk\//i.test(String(html ?? "")) || /_\$[a-z]+\s*=\s*\[/.test(String(html ?? ""))) {
    throw new StructureDriftError("CCDI anti-automation challenge page", { url });
  }
}

function parseCcdiList(html, { baseUrl }) {
  assertNotChallenge(html, baseUrl);
  return extractAnchors(html, { baseUrl, hrefPattern: /\.(shtml|htm|html)$/i })
    .filter((anchor) => /监察|实施条例|规定|解释|公告|法/.test(anchor.title))
    .filter((anchor) => !/专题|访谈|图解|视频/.test(anchor.title))
    .map((anchor) => ({
      source_id: anchor.url,
      title: anchor.title,
      url: anchor.url,
      doc_type: "supervisory-regulation",
    }));
}

function parseCcdiDetail(html, entry, { baseUrl }) {
  assertNotChallenge(html, baseUrl);
  const text = stripHtml(html);
  const labels = labeledValues(html, [
    "标题", "公告号", "文号", "发布机关", "发布日期", "成文日期", "施行日期", "类别", "效力层级",
  ]);
  const attachments = extractAnchors(html, { baseUrl, hrefPattern: /\.(pdf|docx?)(\?|$)/i })
    .map((anchor) => ({ title: anchor.title, url: anchor.url, filename: decodeURIComponent(new URL(anchor.url).pathname.split("/").pop()) }));
  return {
    title: labels["标题"] ?? cleanText(entry.title),
    published_at: labels["发布日期"] ?? labels["成文日期"],
    effective_at: labels["施行日期"],
    status: "有效",
    authority: labels["发布机关"] ?? "国家监察委员会",
    language: "zh-CN",
    content: text || null,
    metadata: {
      announcement_no: labels["公告号"] ?? null,
      document_no: labels["文号"] ?? null,
      category: labels["类别"] ?? null,
      hierarchy: labels["效力层级"] ?? "监察法规",
      raw_labels: labels,
    },
    attachments,
  };
}

export const ccdiSupervisoryAdapter = createHttpSourceAdapter({
  id: "ccdi-supervisory-regulations",
  envPrefix: "CCDI_SUPERVISORY",
  docType: "supervisory-regulation",
  rateMs: Number(process.env.CCDI_SUPERVISORY_RATE_MS ?? 1100),
  list: {
    kind: "html",
    url: DEFAULT_LIST,
    size: 20,
  },
  parseList: parseCcdiList,
  detail: { kind: "html" },
  parseDetail: parseCcdiDetail,
});

export default ccdiSupervisoryAdapter;
