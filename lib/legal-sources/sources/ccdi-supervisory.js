// CCDI supervisory regulations. The public site is behind a three-step JS
// cookie challenge and a per-session request quota. This adapter speaks pure
// HTTP: it extracts the C3VK cookie from the challenge page, follows the
// server-side confirmation redirect, rotates the session before the quota
// trips, and falls back to a fresh session if a captcha page appears.
//
// Content extraction note: the CMS ships two detail-page generations. Legacy
// pages nest <div class="TRS_Editor"> (quoted) inside <DIV class=content>; the
// current template emits <DIV class=TRS_Editor> (upper case, unquoted). The
// body is matched on the class value, not the exact tag spelling — an exact
// `<div class="TRS_Editor"` match silently dropped ~93% of the catalog.
//
// Attachments: detail pages may link .docx/.doc/.pdf files instead of (or in
// addition to) inline text. They are downloaded, stored via the runtime's
// artifacts path (attachments/ prefix, original links kept in
// metadata.attachment_urls), and .docx bodies are text-extracted with the
// shared zero-dependency docxtext helper.
//
// metadata.content_status (metadata jsonb is the store for source-specific
// fields — there is no column and none was added):
//   full_text            body text taken from the detail page
//   from_attachment      body text extracted from a .docx attachment
//   attachment_only      attachments exist but no extractable text (e.g. .doc)
//   no_content_on_source the detail page has neither a body block nor links
import { cleanText, extractAnchors } from "../parsing.js";
import { docxToText } from "../../docxtext.js";
import { SessionProxyError } from "../errors.js";

const BASE_URL = process.env.CCDI_BASE_URL ?? "https://www.ccdi.gov.cn";
const LIST_URL = `${BASE_URL}/fgk/law_pagenumb`;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const SESSION_LIMIT = 6;
// A shorter body than this is a catalog stub, not a readable document (same
// threshold the coverage queries use against legal_documents).
const MIN_BODY_CHARS = 50;

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

// The site answers over-eager clients with a 200 "您的访问请求过于频繁"
// page that is neither the JS challenge nor the captcha. Returning it as a
// normal page silently produced empty documents, so it must be detected and
// escalated (session reset, bounded backoff, then a session-level failure).
function isRateLimitPage(html) {
  return /请求过于频繁/.test(String(html ?? ""));
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

// The CMS hides characters the shared decoding misses: hex numeric refs
// (&#x6cd5;) in 分类/标题 and a wider named-entity set (&ldquo; &ensp; …) in
// bodies. Decoding is local to this source so the shared parsing.js contract
// for the other four adapters stays untouched.
const EXTRA_ENTITIES = {
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  ensp: "\u2002",
  emsp: "\u3000",
  ndash: "\u2013",
  mdash: "\u2014",
  hellip: "\u2026",
  middot: "\u00b7",
  bull: "\u2022",
  times: "\u00d7",
};

export function decodeRichEntities(text) {
  return String(text ?? "")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-zA-Z]+);/g, (raw, name) => EXTRA_ENTITIES[name] ?? raw);
}

function richText(html) {
  if (html == null) return null;
  const text = decodeRichEntities(cleanText(html));
  return text || null;
}

// A div whose class attribute contains TRS_Editor, with quotes optional and
// tag case ignored. The class value is what both template generations share.
const TRS_EDITOR_OPEN = /<div\b[^>]*\bclass\s*=\s*(?:"[^"]*TRS_Editor[^"]*"|'[^']*TRS_Editor[^']*'|[^\s"' >]*TRS_Editor[^\s"' >]*)[^>]*>/i;
const ATTACHMENT_HREF = /\.(pdf|docx?|wps|et|xlsx?)(\?[^"'#]*)?(#.*)?$/i;

function extractContentHtml(html) {
  const open = html.match(TRS_EDITOR_OPEN);
  if (!open) return "";
  const start = html.indexOf(open[0]);
  // Walk the balanced div region so trailing 责任编辑/附件 blocks that sit
  // after the body container are excluded; fall back to the print marker.
  const divTag = /<\/?div\b[^>]*>/gi;
  divTag.lastIndex = start;
  let depth = 0;
  let match;
  while ((match = divTag.exec(html))) {
    depth += match[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(start, match.index + match[0].length);
  }
  const end = html.lastIndexOf("<!--endprint-->");
  return end > start ? html.slice(start, end) : html.slice(start);
}

function extractCcdiAttachments(html, baseUrl) {
  return extractAnchors(html, { baseUrl, hrefPattern: ATTACHMENT_HREF }).map((anchor) => {
    let filename = null;
    try {
      filename = decodeURIComponent(new URL(anchor.url).pathname.split("/").pop() ?? "");
    } catch {
      filename = null;
    }
    return { title: anchor.title, url: anchor.url, filename: filename || null };
  });
}

export function parseCcdiDetailPage(html, entry) {
  const text = String(html ?? "");
  if (isChallengePage(text)) throw new Error("CCDI challenge page");
  if (isCaptchaPage(text)) throw new Error("CCDI captcha page");
  if (isRateLimitPage(text)) throw new SessionProxyError("CCDI rate-limit block page reached the parser", { code: "RATE_LIMITED" });

  // 来源/发布时间 sit inside a commented <H3 class=daty> block on every
  // template generation; matching the raw HTML keeps those values available.
  const titleMatch = text.match(/<h2\b[^>]*\bclass\s*=\s*(?:"[^"]*\btit\b[^"]*"|'[^']*\btit\b[^']*'|[^\s"' >]*\btit\b[^\s"' >]*)[^>]*>([\s\S]*?)<\/h2>/i);
  const stripped = text.replace(/<!--[\s\S]*?-->/g, " ");
  const contentHtml = extractContentHtml(stripped);
  const content = richText(contentHtml);
  const publishedMatch = text.match(/发布时间[：:]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/);
  const sourceMatch = text.match(/来源[：:]\s*([^<\n]+)/);
  const categoryMatch = text.match(/分类[：:]\s*([^<\n]+)/);

  return {
    title: richText(titleMatch?.[1]) ?? entry.title,
    published_at: publishedMatch?.[1] ?? null,
    effective_at: null,
    status: "有效",
    authority: richText(sourceMatch?.[1]) ?? "中共中央纪律检查委员会",
    language: "zh-CN",
    content,
    // full_text is provisional until detail() resolves the attachment path.
    content_status: content ? "full_text" : null,
    attachments: extractCcdiAttachments(text, `${BASE_URL}/fgk/law_display/`),
    metadata: {
      category: richText(categoryMatch?.[1]),
      hierarchy: "党纪法规",
    },
  };
}

export class CcdiHttpClient {
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

  async request(url, options = {}, depth = 0, blockedRetries = 0) {
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
        return this.request(nextUrl, options, depth + 1, blockedRetries);
      }
    }

    const text = await response.text();
    if (isChallengePage(text)) {
      this.jar.set("C3VK", challengeCookie(text));
      return this.request(url, options, depth + 1, blockedRetries);
    }
    if (isCaptchaPage(text)) {
      this.reset();
      return this.request(url, options, depth + 1, blockedRetries);
    }
    if (isRateLimitPage(text)) return this.retryBlocked(url, options, depth, blockedRetries, () => this.request(url, options, depth + 1, blockedRetries + 1));
    this.successfulRequests++;
    return text;
  }

  // Block pages usually clear within a cooldown window. Reset the session,
  // wait once, then give up as a session failure so the run aborts via the
  // shared taxonomy instead of harvesting empty pages (never silent).
  async retryBlocked(url, _options, depth, blockedRetries, retry) {
    this.reset();
    if (blockedRetries >= 1 || depth > 6) {
      throw new SessionProxyError(`CCDI rate-limit block persisted: ${url}`, { code: "RATE_LIMITED" });
    }
    const backoffMs = Number(process.env.CCDI_RATE_LIMIT_BACKOFF_MS ?? 30000);
    await sleep(backoffMs);
    return retry();
  }

  // Binary variant for attachment downloads. A challenge/captcha response is
  // text/html, so challenge handling reuses the text path; an HTML body where
  // a file was expected means the link is dead and must fail the item.
  async requestBuffer(url, depth = 0, blockedRetries = 0) {
    if (depth > 8) throw new Error("CCDI challenge loop did not terminate");
    if (this.successfulRequests >= SESSION_LIMIT) this.reset();

    const wait = this.lastRequestAt + this.rateMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.lastRequestAt = Date.now();

    const response = await fetch(url, {
      headers: this.headers(),
      redirect: "manual",
    });
    captureCookies(response, this.jar);

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location) {
        const nextUrl = new URL(location, url).toString();
        return this.requestBuffer(nextUrl, depth + 1, blockedRetries);
      }
    }

    const contentType = response.headers?.get?.("content-type") ?? "application/octet-stream";
    if (/text\/html/i.test(contentType)) {
      const text = await response.text();
      if (isChallengePage(text)) {
        this.jar.set("C3VK", challengeCookie(text));
        return this.requestBuffer(url, depth + 1, blockedRetries);
      }
      if (isCaptchaPage(text)) {
        this.reset();
        return this.requestBuffer(url, depth + 1, blockedRetries);
      }
      if (isRateLimitPage(text)) {
        return this.retryBlocked(url, null, depth, blockedRetries, () => this.requestBuffer(url, depth + 1, blockedRetries + 1));
      }
      throw new Error(`CCDI attachment returned HTML instead of a file: ${url}`);
    }
    this.successfulRequests++;
    return { body: Buffer.from(await response.arrayBuffer()), contentType };
  }
}

export function createCcdiSupervisoryAdapter({ client: injectedClient = null, rateMs } = {}) {
  const client = injectedClient
    ?? new CcdiHttpClient({ rateMs: rateMs ?? Number(process.env.CCDI_SUPERVISOR_RATE_MS ?? 2000) });
  const effectiveRateMs = rateMs ?? Number(process.env.CCDI_SUPERVISOR_RATE_MS ?? 2000);

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
    const attachments = parsed.attachments ?? [];

    // Attachments are always captured: the runtime uploads artifacts under the
    // attachments/ prefix and metadata keeps the original links (spec: 附件保存
    // 到对象存储，原附件链接保留). Download failures throw — never silent.
    const artifacts = [];
    for (const attachment of attachments) {
      const fetched = await client.requestBuffer(attachment.url);
      artifacts.push({
        kind: "attachment",
        filename: attachment.filename
          ?? new URL(attachment.url).pathname.split("/").pop()
          ?? `${entry.source_id}.bin`,
        contentType: fetched.contentType,
        body: fetched.body,
      });
    }

    let content = parsed.content;
    let contentStatus = parsed.content_status;
    if (!content) {
      const docx = artifacts.find((artifact) => /\.docx$/i.test(artifact.filename));
      if (docx) {
        const text = docxToText(docx.body);
        if (!text || text.replace(/\s+/g, "").length < MIN_BODY_CHARS) {
          throw new Error(`CCDI docx attachment for ${entry.source_id} yielded no readable body`);
        }
        content = text;
        contentStatus = "from_attachment";
      } else {
        contentStatus = attachments.length ? "attachment_only" : "no_content_on_source";
      }
    }

    const metadata = { ...parsed.metadata, content_status: contentStatus };
    if (attachments.length) metadata.attachment_urls = attachments.map((attachment) => attachment.url);

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
        content,
        source_url: entry.url,
        metadata,
      },
      artifacts,
    };
  }

  return {
    id: "ccdi-supervisory-regulations",
    mode: "http",
    rateMs: effectiveRateMs,
    list,
    detail,
  };
}

export const ccdiSupervisoryAdapter = createCcdiSupervisoryAdapter();

export default ccdiSupervisoryAdapter;
