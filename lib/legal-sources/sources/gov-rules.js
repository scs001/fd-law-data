// National rules library. The public entry points have moved before, so the
// adapter ships a conservative HTML list parser and takes overrides from
// GOV_RULES_LIST_URL / GOV_RULES_PAGE_TEMPLATE. The parser works with both a
// single list page and a {page}-templated archive.
import { createHttpSourceAdapter, extractAnchors, cleanText, labeledValues, stripHtml } from "./common.js";

const DEFAULT_LIST = process.env.GOV_RULES_PAGE_TEMPLATE
  ?? process.env.GOV_RULES_LIST_URL
  ?? "https://www.gov.cn/zhengce/xxgk/gjgzk/";

function parseRulesList(html, { baseUrl, filters }) {
  const wanted = filters.scope === "local"
    ? /地方政府规章/
    : filters.scope === "department"
      ? /部门规章/
      : null;
  return extractAnchors(html, { baseUrl, hrefPattern: /\.(htm|html|shtml)$/i })
    .filter((anchor) => {
      if (wanted && !wanted.test(anchor.title)) return false;
      return /规章|办法|细则|规定|决定/.test(anchor.title);
    })
    .map((anchor) => ({
      source_id: anchor.url,
      title: anchor.title,
      url: anchor.url,
      doc_type: "rule",
    }));
}

function parseLastPage(html) {
  const texts = [...String(html ?? "").matchAll(/(?:共\s*)?(\d+)\s*(?:页|条)/g)].map((m) => Number(m[1]));
  return texts.length ? Math.max(...texts) : null;
}

function parseRulesDetail(html, entry, { baseUrl }) {
  const text = stripHtml(html);
  const labels = labeledValues(html, [
    "索引号", "主题分类", "发文机关", "成文日期", "标题", "发文字号", "公文种类",
    "效力等级", "有效性", "公布日期", "施行日期", "废止日期",
  ]);
  const attachments = extractAnchors(html, { baseUrl, hrefPattern: /\.(pdf|docx?|wps|xls?)(\?|$)/i })
    .map((anchor) => ({ title: anchor.title, url: anchor.url, filename: decodeURIComponent(new URL(anchor.url).pathname.split("/").pop()) }));
  return {
    title: labels["标题"] ?? cleanText(entry.title),
    published_at: labels["公布日期"] ?? labels["成文日期"],
    effective_at: labels["施行日期"],
    status: labels["有效性"] ?? (labels["废止日期"] ? "已废止" : "现行有效"),
    authority: labels["发文机关"] ?? null,
    language: "zh-CN",
    content: text || null,
    metadata: {
      document_no: labels["发文字号"] ?? null,
      index_no: labels["索引号"] ?? null,
      subject_categories: labels["主题分类"] ?? null,
      document_kind: labels["公文种类"] ?? null,
      effectiveness_level: labels["效力等级"] ?? null,
      repeal_date: labels["废止日期"] ?? null,
      raw_labels: labels,
    },
    attachments,
  };
}

export const govRulesAdapter = createHttpSourceAdapter({
  id: "gov-rules-library",
  envPrefix: "GOV_RULES",
  docType: "rule",
  rateMs: Number(process.env.GOV_RULES_RATE_MS ?? 1100),
  list: {
    kind: "html",
    url: DEFAULT_LIST,
    size: Number(process.env.GOV_RULES_PAGE_SIZE ?? 20),
    parsePages: parseLastPage,
  },
  parseList: parseRulesList,
  detail: { kind: "html" },
  parseDetail: parseRulesDetail,
});

export default govRulesAdapter;
