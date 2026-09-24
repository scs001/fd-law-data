// CCDI supervisory regulations. The public site is behind a three-step JS
// cookie challenge and a per-session request quota. This adapter speaks pure
// HTTP: it extracts the C3VK cookie from the challenge page, follows the
// server-side confirmation redirect, rotates the session before the quota
// trips, and falls back to a fresh session if a captcha page appears.
import { cleanText, stripHtml } from "../parsing.js";

const BASE_URL = process.env.CCDI_BASE_URL ?? "https://www.ccdi.gov.cn";
const LIST_URL = `${BASE_URL}/fgk/law_pagenumb`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/5.36";
const SESSION_LIMIT = 6;

const CATEGORY_CODES = {
  constitution: "0101",
  guidelines: "0102",
  regulations: "0103",
  rules: "0104",
  provisions: "0105",
  measures: "0106",
  detailed_rules: "0107",
  normative_documents: "0108",
  interpretations: "0109",
  administrative_regulations: "0202",
  judicial_interpretations: "0204",
  laws: "0206",
  ministerial_rules: "0207",
  constitution_law: "0209",
  international_conventions: "0210",
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function cookieHeader(jar) {
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
}

function captureCookies(response, jar) {
  const setCookies = response.headers?.getSetCookie?.() ?? [];
  for (const raw of setCookies) {
    const [pair] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (name && value) jar.set(name, value);
  }
}

function isChallengePage(html) {
  return /window\.open\(/.test(String(html ?? "")) && /C3VK\s*=/.test(String(html ?? ""));
}

function isCaptchaPage(html) {
  return /haplat|seccaptcha/i.test(String(html ?? ""));
}

function challengeCookie(html) {
  const match = String(html ?? "").match(/C3VK=([0-9a-f]+)/i);
  if (!match) throw new Error("CCDI challenge page did not expose a C3VK cookie");
  return match[1];
}

export function parseCcdiListPage(html) {
  const text = String(html ?? "");
  if (isChallengePage(text)) throw new Error("CCDI challenge page");
  if (isCaptchaPage(text)) throw new Error("CCDI captcha page");

  const entries = [];
  const seen = new Set();
  const forms = [...text.matchAll(/<form\b[^>]*action=["']law_display\/(\d+)["'][^>]*>[\s\S]*?<a\b[^>]*onclick=["']submitForm_0\(\d+\)["'][^>]*>([\s\S]*?)<\/a>/gi)];
  for (const form of forms) {
    const id = form[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const title = cleanText(form[2]);
    if (!title) continue;
    entries.push({
      source_id: id,
      title,
      url: `${BASE_URL}/fgk/law_display/${id}`,
      doc_type: "supervisory-regulation",
    });
  }

  const pageNumbers = [
    ...[...text.matchAll(/submitForm_1\((\d+)/gi)].map((m) => Number(m[1])),
    ...[...text.matchAll(/submitForm_00\((\d+)/gi)].map((m) => Number(m[1])),
  ].filter((n) => Number.isFinite(n) && n > 0);
  const pages = pageNumbers.length ? Math.max(...pageNumbers) : 1;
  return { entries, pages };
}

export function parseCcdiDetailPage(html, entry) {
  const text = String(html ?? "");
  if (isChallengePage(text)) throw new Error("CCDI challenge page");
  if (isCaptchaPage(text)) throw new Error("CCDI captcha page");

  const titleMatch = text.match(/<h2\b[^>]*class=["'][^"']*tit[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i);
  const contentStart = text.indexOf('<div class="TRS_Editor"');
  const contentEnd = text.indexOf("<!--endprint-->", contentStart);
  const contentHtml = contentStart >= 0 && contentEnd > contentStart
    ? text.slice(contentStart, contentEnd)
    : "";
  const content = cleanText(contentHtml) || null;
  const publishedMatch = text.match(/发布时间[：:]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  const sourceMatch = text.match(/来源[：:]\s*([^<\n]+)/);
  const categoryMatch = text.match(/分类[：:]\s*([^<\n]+)/);

  return {
    title: cleanText(titleMatch?.[1]) ?? entry.title,
    published_at: publishedMatch?.[1] ?? null,
    effective_at: null,
    status: "有效",
    authority: cleanText(sourceMatch?.[1]) ?? "中共中央纪律检查委员会",
    language: "zh-CN",
    content,
    metadata: {
      category: cleanText(categoryMatch?.[1]) ?? null,
      hierarchy: "党纪法规",
    },
  };
}

class CcdiHttpClient {
  constructor({ rateMs = 2000 } = {}) {
    this.rateMs = rateMs;
    this.jar = new Map();
    this.successfulRequests = 0;
    this.lastRequestAt = 0;
  }

  reset() {
    this.jar.clear();
    this.successfulRequests = 0;
  }

  headers(extra = {}) {
    const cookie = cookieHeader(this.jar);
    return {
      "user-agent": UA,
      ...(cookie ? { cookie } : {}),
      ...extra,
    };
  }

  async request(url, options = {}, depth = 0) {
    if (depth > 8) throw new Error("CCDI challenge loop did not terminate");
    if (this.successfulRequests >= SESSION_LIMIT) this.reset();

    const wait = this.lastRequestAt + this.rateMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const response = await fetch(url, {
      ...options,
      headers: this.headers(options.headers ?? {}),
      redirect: "manual",
    });
    captureCookies(response, this.jar);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const nextUrl = new URL(location, url).toString();
        return this.request(nextUrl, options, depth + 1);
      }
    }

    const text = await response.text();
    if (isChallengePage(text)) {
      this.jar.set("C3VK", challengeCookie(text));
      return this.request(url, options, depth + 1);
    }
    if (isCaptchaPage(text)) {
      this.reset();
      return this.request(url, options, depth + 1);
    }
    this.successfulRequests++;
    return text;
  }
}

export const ccdiSupervisoryAdapter = (() => {
  const client = new CcdiHttpClient({ rateMs: Number(process.env.CCDI_SUPERVISOR_RATE_MS ?? 2000) });

  async function list(filters = {}) {
    const category = filters.category && CATEGORY_CODES[filters.category]
      ? CATEGORY_CODES[filters.category]
      : null;
    const types = category ? "fgfl" : "index";
    const maxPages = Number(filters.maxPages ?? 1000);

    const firstUrl = `${LIST_URL}?p=1&types=${types}${category ? `&validity=${category}` : ""}`;
    const firstHtml = await client.request(firstUrl);
    const first = parseCcdiListPage(firstHtml);
    const entries = [...first.entries];
    const pages = Math.min(first.pages || 1, maxPages);

    for (let page = 2; page <= pages; page++) {
      const url = `${LIST_URL}?p=${page}&types=${types}${category ? `&validity=${category}` : ""}`;
      const html = await client.request(url);
      const parsed = parseCcdiListPage(html);
      entries.push(...parsed.entries);
    }

    return {
      entries,
      total: entries.length,
      pages,
      unreachablePages: [],
    };
  }

  async function detail(entry) {
    const html = await client.request(entry.url);
    const parsed = parseCcdiDetailPage(html, entry);
    return {
      document: {
        source_id: entry.source_id,
        doc_type: "supervisory-regulation",
        title: parsed.title,
        published_at: parsed.published_at,
        effective_at: parsed.effective_at,
        status: parsed.status,
        authority: parsed.authority,
        language: parsed.language,
        content: parsed.content,
        source_url: entry.url,
        metadata: parsed.metadata,
      },
      artifacts: [],
    };
  }

  return {
    id: "ccdi-supervisory-regulations",
    mode: "http",
    rateMs: Number(process.env.CCDI_SUPERVISOR_RATE_MS ?? 2000),
    list,
    detail,
  };
})();

export default ccdiSupervisoryAdapter;
