// flk.npc.gov.cn API client — endpoints verified live 2026-09-18 (design.md D7).
// SPA-era API: no login, no captcha, no signing; pacing only.
import { fetchJson, fetchWithRetry } from "../http.js";

const BASE = "https://flk.npc.gov.cn/law-search";
const BROWSER_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  referer: "https://flk.npc.gov.cn/",
};

// Top-level flfg categories (enumData tree roots). flk adds entries rarely;
// enumData() refreshes this at runtime, this is the fallback + ordering.
export const TOP_LEVEL_CODES = [
  { code: 100, name: "宪法" },
  { code: 101, name: "法律" },
  { code: 201, name: "行政法规" },
  { code: 220, name: "监察法规" },
  { code: 221, name: "地方法规" },
  { code: 311, name: "司法解释" },
];

export function stripHighlight(title) {
  return title.replace(/<em[^>]*>/g, "").replace(/<\/em>/g, "").trim();
}

export async function enumData() {
  const json = await fetchJson(`${BASE}/search/enumData`, { headers: BROWSER_HEADERS });
  const roots = json?.data?.flfgfl?.children ?? [];
  // The list API matches codes exactly, so a top-level category must be
  // queried with its full descendant list (node.codeIdList = self + subtree).
  const topLevel = roots.map((r) => ({
    code: r.codeId,
    name: r.name,
    codes: r.codeIdList?.filter((c) => c != null) ?? collectCodes(r),
    children: (r.children ?? []).map((c) => ({ code: c.codeId, name: c.name })),
  }));
  const nameByCode = new Map();
  const walk = (nodes) => {
    for (const n of nodes) {
      nameByCode.set(n.codeId, n.name);
      if (n.children) walk(n.children);
    }
  };
  walk(roots);
  return { topLevel, nameByCode };
}

function collectCodes(node) {
  const out = [node.codeId];
  for (const c of node.children ?? []) out.push(...collectCodes(c));
  return out;
}

export async function searchList({ flfgCodeId, gbrqStart, gbrqEnd, pageNum = 1, pageSize = 100, searchContent = "" }) {
  const body = {
    searchRange: 1,
    sxrq: [],
    gbrq: gbrqStart && gbrqEnd ? [gbrqStart, gbrqEnd] : [],
    sxx: [],
    searchType: 2,
    xgzlSearch: false,
    searchContent,
    orderByParam: { order: "-1", sort: "" },
    flfgCodeId: Array.isArray(flfgCodeId) ? flfgCodeId : flfgCodeId != null ? [flfgCodeId] : [],
    zdjgCodeId: [],
    gbrqYear: [],
    pageNum,
    pageSize,
  };
  const json = await fetchJson(`${BASE}/search/list`, {
    method: "POST",
    headers: { ...BROWSER_HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (json.code !== 200) throw new Error(`flk search/list: code=${json.code} msg=${json.msg}`);
  return { total: json.total ?? 0, rows: json.rows ?? [] };
}

export async function detail(bbbs) {
  const json = await fetchJson(`${BASE}/search/flfgDetails?bbbs=${encodeURIComponent(bbbs)}`, {
    headers: BROWSER_HEADERS,
  });
  if (json.code !== 200) throw new Error(`flk flfgDetails: code=${json.code} msg=${json.msg}`);
  return json.data;
}

// Returns {docx: Buffer} — download/pc hands back a presigned object-storage
// link (1 h validity); follow it for the bytes. The OBS link is a different
// host than flk, so it is fetched without the flk rate gate.
export async function downloadDocx(bbbs) {
  const json = await fetchJson(
    `${BASE}/download/pc?bbbs=${encodeURIComponent(bbbs)}&format=docx`,
    { headers: BROWSER_HEADERS },
  );
  if (json.code !== 200 || !json.data?.url) throw new Error(`flk download/pc: code=${json.code} msg=${json.msg}`);
  const res = await fetchWithRetry(json.data.url, { headers: BROWSER_HEADERS }, { retries: 3, rateLimit: false });
  if (!res.ok) throw new Error(`flk docx GET: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { docx: buf };
}

export function parseOssFile(ossFile) {
  // flk serves this field inconsistently: real JSON on some entries,
  // Python-style dict (single quotes, None) on others. Handle both.
  if (!ossFile) return {};
  if (typeof ossFile === "object") return ossFile;
  try {
    return JSON.parse(ossFile);
  } catch {
    /* fall through to python-style parsing */
  }
  const out = {};
  const re = /'([A-Za-z0-9]+)'\s*:\s*(None|'[^']*')/g;
  let m;
  while ((m = re.exec(ossFile))) {
    out[m[1]] = m[2] === "None" ? null : m[2].slice(1, -1);
  }
  return out;
}

export const SXX_NAMES = { 1: "失效", 2: "已失效", 3: "已修改", 4: "有效", 5: "尚未生效" };
export const sxxName = (sxx) => SXX_NAMES[sxx] ?? (sxx == null ? null : `sxx:${sxx}`);

// laws.category is varchar(16); some flk leaf categories exceed it (e.g.
// 有关法律问题和重大问题的决定（部分）= 18 chars, hit live 2026-09-18).
// Fall back to the top-level group name — laws.type (varchar 32) keeps the
// full leaf name, so nothing is lost.
export function fitCategory(category, flfgCodeId) {
  if (!category || category.length <= 16) return category;
  if (flfgCodeId == null) return category.slice(0, 16);
  if (flfgCodeId >= 311) return "司法解释";
  if (flfgCodeId >= 221) return "地方法规";
  if (flfgCodeId === 220) return "监察法规";
  if (flfgCodeId >= 201) return "行政法规";
  if (flfgCodeId >= 100) return "法律";
  return category.slice(0, 16);
}
