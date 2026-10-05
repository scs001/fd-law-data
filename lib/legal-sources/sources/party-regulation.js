// CPC party-regulation library on 12371.cn. The 党内法规库 landing page links
// 11 public category pages: 党章专题 plus the form categories 准则/条例/规定/
// 办法/规则/细则 and the theme categories 党的组织法规/党的领导法规/党的自身
// 建设法规/党的监督保障法规. Each category page embeds its COMPLETE record list
// in an inline JS array (itemELMT...=[{'link_add':..,'title':..},...]) that an
// in-page pager slices client-side, so there is no server-side pagination: one
// fetch per category yields the full catalog. The landing page itself embeds
// the 党章 revision history. Article links are /YYYY/MM/DD/ARTI*.shtml.
import { createHash } from "node:crypto";
import { StructureDriftError } from "../errors.js";
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
  org_regulations: "/special/dnfg/zzfg/",
  leadership_regulations: "/special/dnfg/ldfg/",
  self_construction_regulations: "/special/dnfg/zsjs/",
  supervision_regulations: "/special/dnfg/jdbz/",
};

const CATEGORY_LABELS = {
  constitution: "党章",
  guidelines: "准则",
  regulations: "条例",
  provisions: "规定",
  measures: "办法",
  rules: "规则",
  detailed_rules: "细则",
  org_regulations: "党的组织法规",
  leadership_regulations: "党的领导法规",
  self_construction_regulations: "党的自身建设法规",
  supervision_regulations: "党的监督保障法规",
};

// Form categories gate on their own keyword in the title; theme categories and
// the landing 党章 history rely on the generic form-keyword filter (their
// curated lists title every regulation by its form anyway).
const FORM_KEYWORD_CATEGORIES = new Set([
  "constitution",
  "guidelines",
  "regulations",
  "provisions",
  "measures",
  "rules",
  "detailed_rules",
]);

// Commentary around a regulation is not the regulation: Q&A, explainers,
// infographics, retrospectives and side-by-side comparisons stay out.
const COMMENTARY_PATTERN = /答记者问|解读|图解|系列|专题|负责人就|诞生记|新旧对照/;
const ARTICLE_HREF_PATTERN = /\/\d{4}\/\d{2}\/\d{2}\/ARTI[^/]+\.shtml$/;
const GENERIC_KEYWORD_PATTERN = /党章|准则|条例|规定|办法|规则|细则/;
const EMBEDDED_RECORD_PATTERN = /\{'link_add':'([^']+)','title':'([^']*)'/g;

function categoryEntry(url, title, category) {
  return {
    source_id: url,
    title,
    url,
    doc_type: "party-regulation",
    metadata_from_list: { category: category ?? null, category_label: category ? CATEGORY_LABELS[category] : null },
  };
}

/**
 * Parse one list page: embedded JS-array records first (curated order), then
 * plain article anchors (the 党章专题 page is hand-built anchors only). Pure
 * function so fixtures can prove field mapping without network access.
 */
export function parsePartyListPage(html, {
  baseUrl,
  arrayCategory = null,
  anchorCategory = null,
  keywords = GENERIC_KEYWORD_PATTERN,
} = {}) {
  const records = new Map();
  for (const match of String(html ?? "").matchAll(EMBEDDED_RECORD_PATTERN)) {
    // Array records may point at special pages (the current 党章 links its
    // 全文 special); only dated ARTI articles become documents.
    if (!ARTICLE_HREF_PATTERN.test(match[1])) continue;
    const url = absoluteUrl(match[1], baseUrl);
    const title = cleanText(match[2]);
    if (!url || !title || records.has(url)) continue;
    records.set(url, { title, fromArray: true });
  }
  for (const anchor of extractAnchors(html, { baseUrl, hrefPattern: ARTICLE_HREF_PATTERN })) {
    if (!records.has(anchor.url)) records.set(anchor.url, { title: anchor.title, fromArray: false });
  }
  const entries = [];
  for (const [url, record] of records) {
    if (COMMENTARY_PATTERN.test(record.title)) continue;
    if (keywords && !keywords.test(record.title)) continue;
    entries.push(categoryEntry(url, record.title, record.fromArray ? arrayCategory : anchorCategory));
  }
  return entries;
}

function absoluteUrl(href, baseUrl) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function resolveCategories(filters) {
  const category = filters?.category;
  if (!category) return Object.keys(CATEGORY_PATHS);
  if (!CATEGORY_PATHS[category]) {
    throw new StructureDriftError(`unknown party-regulation category: ${category}`, {
      known: Object.keys(CATEGORY_PATHS).join(","),
    });
  }
  return [category];
}

/**
 * Enumerate the whole public catalog: every category page (each embeds its
 * full list) plus, for uncategorized runs, the landing page's 党章 revision
 * history and featured links. A category fetch failure is recorded in
 * unreachablePages and never silently treated as an empty category; a run
 * that enumerates nothing at all throws.
 */
async function listAllCategories(filters, helpers) {
  const categories = resolveCategories(filters);
  const singleCategory = filters?.category ?? null;
  const entries = [];
  const seen = new Set();
  const unreachablePages = [];
  const categoryCounts = {};
  let pages = 0;

  const absorb = (parsed) => {
    let fresh = 0;
    for (const entry of parsed) {
      if (seen.has(entry.source_id)) continue;
      seen.add(entry.source_id);
      entries.push(entry);
      fresh++;
    }
    return fresh;
  };

  for (const category of categories) {
    const url = `${BASE}${CATEGORY_PATHS[category]}`;
    let raw;
    try {
      raw = await helpers.fetchText(url);
    } catch (err) {
      unreachablePages.push({ page: url, reason: `category ${category}: ${String(err?.message ?? err).slice(0, 480)}` });
      continue;
    }
    pages++;
    const keywords = FORM_KEYWORD_CATEGORIES.has(category)
      ? new RegExp(CATEGORY_LABELS[category])
      : GENERIC_KEYWORD_PATTERN;
    const parsed = parsePartyListPage(raw, { baseUrl: url, arrayCategory: category, anchorCategory: category, keywords });
    categoryCounts[category] = parsed.length;
    if (!parsed.length) {
      // The page rendered but listed nothing: the path moved or the list
      // template changed. Record it; the manifest must not read complete.
      unreachablePages.push({ page: url, reason: `category ${category} yielded no entries` });
      continue;
    }
    absorb(parsed);
  }

  if (!singleCategory) {
    // Landing page last: category pages claim the shared articles first, so
    // only the 党章 history and stray featured links keep their landing tags.
    const url = process.env.PARTY_REGULATION_LIST_URL ?? `${BASE}/special/dnfg/`;
    try {
      const raw = await helpers.fetchText(url);
      pages++;
      absorb(parsePartyListPage(raw, {
        baseUrl: url,
        arrayCategory: "constitution",
        anchorCategory: null,
        keywords: GENERIC_KEYWORD_PATTERN,
      }));
    } catch (err) {
      unreachablePages.push({ page: url, reason: `landing: ${String(err?.message ?? err).slice(0, 480)}` });
    }
  }

  if (!entries.length) {
    throw new StructureDriftError("party-regulation enumeration yielded no entries", {
      pages,
      unreachablePages: unreachablePages.length,
    });
  }

  return {
    entries,
    total: entries.length,
    pages,
    unreachablePages,
    categoryCounts,
    raw: [],
  };
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

// The factory's single-URL paginator cannot express this catalog (no
// {page} template, 12 fully-embedded list pages), so the adapter keeps the
// factory's rate-limited detail pipeline and swaps in the multi-category list.
const httpAdapter = createHttpSourceAdapter({
  id: "party-regulation-library",
  envPrefix: "PARTY_REGULATION",
  docType: "party-regulation",
  rateMs: Number(process.env.PARTY_REGULATION_RATE_MS ?? 1100),
  detail: { kind: "html" },
  parseDetail: parsePartyDetail,
});

export const partyRegulationAdapter = {
  id: httpAdapter.id,
  mode: httpAdapter.mode,
  rateMs: httpAdapter.rateMs,
  requiresProxy: httpAdapter.requiresProxy,
  headers: httpAdapter.headers,
  list: listAllCategories,
  detail: (entry, helpers) => httpAdapter.detail(entry, helpers),
};

export default partyRegulationAdapter;
