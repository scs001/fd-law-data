// National rules library via the search gateway used by the live front end.
// No login, no dynamic signature: the gateway only needs an RSA-derived
// athenaAppKey header, which can be generated offline from the public key
// embedded in the site bundle.
import { createPublicKey, publicEncrypt, constants } from "node:crypto";
import { cleanText, stripHtml, toIsoDateTime } from "../parsing.js";

const GATEWAY = "https://sousuoht.www.gov.cn/athena/forward/BD8730CDDA12515E2D9E1B21AA11C0D6";
const PUBLIC_KEY = "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCWGTHvPbNkzQNxTJwSZbsgHKyLl/OK11kCZNmVVSFK3lUbmHgh7Ain1gdaf7G/ETh/wQm/9BAO/U36yWPizzlwHCUcWJXBRsY10PsnYIlBXH/cjqQaEbmEghxcjdYtLtkudoMfoMDiJk+tPC7UEZd8TI2u26vttNF++6tHi1HdeQIDAQAB";
const APP_SECRET = "f8f49ea85885466598c5261f7f8607fb";
const APP_NAME = encodeURIComponent("规章库");

const CATEGORY_DEPARTMENT = "部门规章";
const CATEGORY_LOCAL = "地方政府规章";

function athenaHeaders() {
  const key = createPublicKey({ key: Buffer.from(PUBLIC_KEY, "base64"), format: "der", type: "spki" });
  const encrypted = publicEncrypt({ key, padding: constants.RSA_PKCS1_PADDING }, Buffer.from(APP_SECRET)).toString("base64");
  return {
    "content-type": "application/json;charset=utf-8",
    "athenaAppKey": encodeURIComponent(encrypted),
    "athenaAppName": APP_NAME,
  };
}

function searchField(fieldName, searchWord, extra = {}) {
  return { fieldName, searchWord, searchType: "TERM", withHighLight: true, ...extra };
}

function listBody({ category, page = 1, size = 500, title = "", province = "", city = "", department = "" }) {
  return {
    code: "18258ab0ac9",
    preference: "pref-0001",
    searchFields: [
      searchField("f_202321807875", category),
      searchField("f_202321360426", title),
      searchField("f_202321758948", ""),
      searchField("f_202321423473", province),
      { fieldName: "f_202321159816", searchWord: "", searchType: "TERM" },
      searchField("f_20232380533", city),
      searchField("f_202328191239", department),
      searchField("f_20221110222856", ""),
    ],
    sorts: [{ sortField: "f_202321915922", sortOrder: "DESC" }],
    resultFields: [
      "f_202321360426", "f_202321807875", "f_202344311304",
      "f_202321915922", "f_202323394765", "f_202328191239",
      "f_2023425676953", "f_202321423473", "f_20232380533",
      "doc_pub_url", "f_202321758948",
    ],
    trackTotalHits: "true",
    tableName: "t_1860c735d31",
    pageSize: size,
    pageNo: page,
    granularity: "ALL",
  };
}

function firstArrayValue(value) {
  if (Array.isArray(value)) return value.map((item) => cleanText(item)).filter(Boolean).join("、");
  return cleanText(value) || null;
}

// Identity must survive across runs. The same document is served under both
// http:// and https:// depending on the crawl (2026-10-10 audit: one run held
// 7,945 http ids against 2,612 https ones, and no raw id matched across two
// runs although the titles did), so the URL is normalised before it becomes
// the key — otherwise every scheme flip masquerades as a brand-new document.
// Only harmless normalisation: scheme and a trailing slash. Path case and
// query params are left alone so distinct documents never collide.
function canonicalUrlKey(url) {
  const raw = cleanText(url);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    parsed.protocol = "https:";
    parsed.hash = "";
    if (parsed.pathname.endsWith("/") && parsed.pathname.length > 1) {
      parsed.pathname = parsed.pathname.slice(0, -1);
    }
    return parsed.toString();
  } catch {
    // Not a parseable URL: fall back to a light textual normalisation so a
    // plain scheme flip still collapses onto one key.
    return raw.trim().replace(/^http:\/\//i, "https://").replace(/\/+$/, "");
  }
}

function parseListRow(row) {
  const title = cleanText(row.f_202321360426);
  const publishedAt = cleanText(row.f_202321915922);
  const url = cleanText(row.doc_pub_url) || (Array.isArray(row.f_20232124962) ? cleanText(row.f_20232124962[0]) : null);
  const category = cleanText(row.f_202321807875);
  const content = cleanText(row.f_202321758948);
  const authority = firstArrayValue(row.f_202323394765)
    ?? firstArrayValue(row.f_202328191239)
    ?? firstArrayValue(row.f_2023425676953)
    ?? firstArrayValue(row.f_202321423473);
  return {
    source_id: canonicalUrlKey(url) || `${title}|${publishedAt}`,
    title,
    url,
    doc_type: "rule",
    published_at: publishedAt,
    content,
    authority,
    category,
    document_no: cleanText(row.f_202344311304),
    province: firstArrayValue(row.f_202321423473),
    city: cleanText(row.f_20232380533),
    department: firstArrayValue(row.f_202328191239) ?? firstArrayValue(row.f_2023425676953),
  };
}

async function fetchCategory({ category, filters, helpers }) {
  const size = Math.min(1000, Math.max(1, Number(filters.size ?? 500)));
  const maxPages = Number(filters.maxPages ?? 1000);
  const entries = [];
  let total = 0;
  let pages = 0;
  for (let page = 1; page <= maxPages; page++) {
    const body = listBody({
      category,
      page,
      size,
      title: filters.title ?? "",
      province: filters.province ?? "",
      city: filters.city ?? "",
      department: filters.department ?? "",
    });
    const json = await helpers.fetchJson(GATEWAY, { method: "POST", headers: athenaHeaders(), body: JSON.stringify(body) });
    const code = json?.resultCode?.code ?? json?.code;
    if (String(code) !== "200") throw new Error(`gov-rules gateway rejected request: ${JSON.stringify(json?.resultCode ?? json).slice(0, 200)}`);
    const data = json?.result?.data;
    const rows = Array.isArray(data?.list) ? data.list : [];
    total = Number(data?.pager?.total ?? rows.length);
    pages = Number(data?.pager?.pageCount ?? 1);
    for (const row of rows) {
      const entry = parseListRow(row);
      if (entry.title) entries.push({ ...entry, list_row: row });
    }
    if (page >= pages || !rows.length) break;
  }
  return { entries, total, pages };
}

export const govRulesAdapter = {
  id: "gov-rules-library",
  mode: "http",
  rateMs: Number(process.env.GOV_RULES_RATE_MS ?? 1100),

  async list(filters, helpers) {
    const categories = filters.scope === "department"
      ? [CATEGORY_DEPARTMENT]
      : filters.scope === "local"
        ? [CATEGORY_LOCAL]
        : [CATEGORY_DEPARTMENT, CATEGORY_LOCAL];
    const results = [];
    for (const category of categories) {
      results.push(await fetchCategory({ category, filters, helpers }));
    }
    const seen = new Set();
    const entries = [];
    for (const result of results) {
      for (const entry of result.entries) {
        if (seen.has(entry.source_id)) continue;
        seen.add(entry.source_id);
        entries.push(entry);
      }
    }
    return {
      entries,
      total: results.reduce((sum, result) => sum + result.total, 0),
      pages: results.reduce((sum, result) => sum + result.pages, 0),
      unreachablePages: [],
    };
  },

  async detail(entry) {
    const row = entry.list_row ?? {};
    const content = cleanText(row.f_202321758948) ?? entry.content ?? null;
    return {
      document: {
        source_id: entry.source_id,
        doc_type: "rule",
        title: entry.title,
        published_at: toIsoDateTime(entry.published_at),
        effective_at: null,
        status: "现行有效",
        authority: entry.authority ?? null,
        language: "zh-CN",
        content,
        source_url: entry.url,
        metadata: {
          category: entry.category ?? null,
          document_no: entry.document_no ?? null,
          province: entry.province ?? null,
          city: entry.city ?? null,
          department: entry.department ?? null,
          source: "gov-rules-gateway",
        },
      },
      artifacts: [],
    };
  },
};

export default govRulesAdapter;
