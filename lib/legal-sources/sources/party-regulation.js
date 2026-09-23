// CPC party-regulation library on 12371.cn. The live special page organizes
// documents by 党章/准则/条例/规定/办法/规则/细则; article links are .shtml.
import { createHash } from "node:crypto";
import { createHttpSourceAdapter, extractAnchors, cleanText, labeledValues, stripHtml } from "./common.js";

const BASE = process.env.PARTY_REGULATION_BASE_URL ?? "https://www.12371.cn";
export const CATEGORY_PATHS = {
  constitution: "/special/zggcdzc/",
  guidelines: "/special/dnfg/zz/",
  regulations: "/special/dnfg/tl/",
  provisions: "/special/dnfg/gd/",
  measures: "/special/dnfg/bf/",
  rules: "/special/dnfg/gz/",
  detailed_rules: "/special/dnfg/xz/",
};

const CATEGORY_LABELS = {
  constitution: "党章",
  guidelines: "准则",
  regulations: "条例",
  provisions: "规定",
  measures: "办法",
  rules: "规则",
  detailed_rules: "细则",
};

function parsePartyList(html, { baseUrl, filters }) {
  const category = filters.category && CATEGORY_PATHS[filters.category] ? filters.category : null;
  return extractAnchors(html, { baseUrl, hrefPattern: /\/\d{4}\/\d{2}\/\d{2}\/ARTI[^/]+\.shtml$/ })
    .filter((anchor) => {
      const title = anchor.title;
      if (/答记者问|解读|图解|系列|专题|负责人就/.test(title)) return false;
      if (!category) return /党章|准则|条例|规定|办法|规则|细则/.test(title);
      return title.includes(CATEGORY_LABELS[category]);
    })
    .map((anchor) => ({
      source_id: anchor.url,
      title: anchor.title,
      url: anchor.url,
      doc_type: "party-regulation",
      metadata_from_list: { category: category ?? null, category_label: category ? CATEGORY_LABELS[category] : null },
    }));
}

function parsePartyDetail(html, entry, { baseUrl }) {
  const text = stripHtml(html);
  const labels = labeledValues(html, [
    "标题", "发文机关", "发布机关", "成文日期", "发布日期", "施行日期", "效力层级", "有效性",
  ]);
  const attachments = extractAnchors(html, { baseUrl, hrefPattern: /\.(pdf|docx?)(\?|$)/i })
    .map((anchor) => ({ title: anchor.title, url: anchor.url, filename: decodeURIComponent(new URL(anchor.url).pathname.split("/").pop()) }));
  const category = entry.metadata_from_list?.category ?? null;
  // Party regulations revise documents in place under one article URL. Keep a
  // stable canonical URL in metadata, but make each revision its own row so
  // current and historical versions remain independently queryable.
  const versionHash = createHash("sha256").update(text, "utf8").digest("hex").slice(0, 20);
  return {
    source_id: `${entry.source_id}@v-${versionHash}`,
    title: labels["标题"] ?? cleanText(entry.title),
    published_at: labels["发布日期"] ?? labels["成文日期"],
    effective_at: labels["施行日期"],
    status: labels["有效性"] ?? "有效",
    authority: labels["发文机关"] ?? labels["发布机关"],
    language: "zh-CN",
    content: text || null,
    metadata: {
      canonical_url: entry.source_id,
      canonical_source_id: entry.source_id,
      version_hash: versionHash,
      is_current: true,
      category,
      category_label: category ? CATEGORY_LABELS[category] : null,
      hierarchy: labels["效力层级"] ?? "党内法规",
      raw_labels: labels,
    },
    attachments,
  };
}

export const partyRegulationAdapter = createHttpSourceAdapter({
  id: "party-regulation-library",
  envPrefix: "PARTY_REGULATION",
  docType: "party-regulation",
  rateMs: Number(process.env.PARTY_REGULATION_RATE_MS ?? 1100),
  list: {
    kind: "html",
    url: process.env.PARTY_REGULATION_LIST_URL ?? `${BASE}/special/dnfg/`,
    size: 10,
  },
  parseList: parsePartyList,
  detail: { kind: "html" },
  parseDetail: parsePartyDetail,
});

export default partyRegulationAdapter;
