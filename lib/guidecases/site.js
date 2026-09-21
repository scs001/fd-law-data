// Parsers and URL builders for the Supreme People's Court public column of
// guiding cases (指导性案例). Pure functions only — no network, no storage —
// so the page shapes are pinned by unit tests (specs/court-guiding-cases).
//
// Live shapes verified 2026-09-21:
//   list   /shenpan/gengduo/77.html (+ _2 … _15), 20 entries per page; every
//          entry is <li><a title="FULL TITLE" target="_blank"
//          href="/shenpan/xiangqing/ID.html">TRUNCATED TITLE</a>
//          <i class="date">YYYY-MM-DD</i></li> — the title attribute carries
//          the full title, the anchor text does not; the pager block reports
//          the column total (共293篇文章).
//   detail /shenpan/xiangqing/ID.html — <div class="title">…</div>, metadata
//          in <ul class="clearfix fl message">, body in <div class="txt_txt">
//          with <strong>　　SECTION</strong><br /> headings and the article
//          ending at <div class="txt_etr">.

export const SITE_ORIGIN = "https://www.court.gov.cn";
export const COLUMN_LIST_PATH = "/shenpan/gengduo/77";

// Field names the six case sections map onto. Every field is optional by
// contract: 关键词 is absent on 44 of the 278 cases, and the execution cases
// (251–256, 267) title their holding section 执行实施要点 instead of 裁判要点.
export const CASE_SECTIONS = [
  { title: "关键词", field: "keyword", aliases: [] },
  { title: "裁判要点", field: "gist", aliases: ["执行实施要点"] },
  { title: "基本案情", field: "facts", aliases: [] },
  { title: "裁判结果", field: "result", aliases: [] },
  { title: "裁判理由", field: "reasoning", aliases: [] },
  { title: "相关法条", field: "statutes", aliases: [] },
];

const SECTION_BY_TITLE = new Map(
  CASE_SECTIONS.flatMap((s) => [[s.title, s], ...s.aliases.map((a) => [a, s])]),
);
const SECTION_TITLE_ALT = [...SECTION_BY_TITLE.keys()].join("|");
const SECTION_LINE_RE = new RegExp(`^(${SECTION_TITLE_ALT})(?:\\s+(.*))?$`);
// A line that looks like a section heading we do not know means the page grew
// a section name we have not seen; leaking it into the preceding section would
// corrupt that field silently, so the crawl stops instead.
const UNKNOWN_HEADING_RE = /^[\u4e00-\u9fa5]{2,10}(要点|要旨)$/;

export const CASE_NUMBER_RE = /指导[性]?案例\s*(\d+)\s*号/;

/** Error raised when a page does not match the pinned shape (selector drift). */
export class SelectorDriftError extends Error {
  constructor(message, { url } = {}) {
    super(url ? `${message} (${url})` : message);
    this.name = "SelectorDriftError";
    this.url = url ?? null;
  }
}

export function listPageUrl(page = 1) {
  return page === 1
    ? `${SITE_ORIGIN}${COLUMN_LIST_PATH}.html`
    : `${SITE_ORIGIN}${COLUMN_LIST_PATH}_${page}.html`;
}

export function detailUrl(id) {
  return `${SITE_ORIGIN}/shenpan/xiangqing/${id}.html`;
}

const ENTITIES = new Map([
  ["nbsp", " "],
  ["amp", "&"],
  ["lt", "<"],
  ["gt", ">"],
  ["quot", '"'],
  ["apos", "'"],
  ["ldquo", "“"],
  ["rdquo", "”"],
  ["middot", "·"],
  ["hellip", "…"],
]);

export function decodeEntities(str) {
  return String(str ?? "").replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : all;
    }
    return ENTITIES.get(body.toLowerCase()) ?? all;
  });
}

/** Whitespace/entity-normalized plain text for titles and single-line fields. */
export function normalizeText(str) {
  return decodeEntities(str).replace(/[\u3000\s]+/g, " ").trim();
}

/** HTML fragment -> plain text, one line per source line/block. */
export function htmlToText(fragment) {
  const text = String(fragment ?? "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|ul|ol|tr|table|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  return decodeEntities(text);
}

/**
 * Parse a column list page.
 * -> { entries, total } where each entry is
 *    { id, url, title, date, caseNo, kind } and kind is "case" | "notice".
 * `total` is the column-wide count the pager reports (null when absent).
 */
export function parseListPage(html) {
  const text = String(html ?? "");
  const entries = [];
  const itemRe =
    /<li>\s*<a\s+title="([^"]*)"[^>]*href="\/shenpan\/xiangqing\/(\d+)\.html"[^>]*>[\s\S]*?<\/a>\s*(?:<i class="date">([^<]*)<\/i>)?/g;
  let m;
  while ((m = itemRe.exec(text))) {
    const title = normalizeText(m[1]);
    if (!title) continue;
    const id = m[2];
    const date = normalizeText(m[3] ?? "") || null;
    const caseNo = parseCaseNumber(title);
    entries.push({
      id,
      url: detailUrl(id),
      title,
      date,
      caseNo,
      kind: caseNo === null ? "notice" : "case",
    });
  }
  const totalM = text.match(/共<span class="num">\s*(\d+)\s*<\/span>篇文章/);
  return { entries, total: totalM ? Number(totalM[1]) : null };
}

/** Case number from a title, tolerant of the 指导案例/指导性案例 variants. */
export function parseCaseNumber(title) {
  const m = CASE_NUMBER_RE.exec(normalizeText(title));
  return m ? Number(m[1]) : null;
}

/** Coverage of a set of case numbers: range, distinct count, and the holes. */
export function missingNumbers(numbers) {
  const distinct = [...new Set(numbers)].sort((a, b) => a - b);
  if (!distinct.length) return { min: null, max: null, count: 0, missing: [] };
  const min = distinct[0];
  const max = distinct[distinct.length - 1];
  const seen = new Set(distinct);
  const missing = [];
  for (let n = min; n <= max; n++) if (!seen.has(n)) missing.push(n);
  return { min, max, count: distinct.length, missing };
}

function parseMeta(text) {
  const block = text.match(/<ul class="clearfix fl message">([\s\S]*?)<\/ul>/);
  const scope = block ? block[1] : "";
  const pick = (label) => {
    const m = scope.match(new RegExp(`<li[^>]*>\\s*${label}[：:]\\s*([\\s\\S]*?)</li>`));
    return m ? normalizeText(m[1]) || null : null;
  };
  return { source: pick("来源"), publishAt: pick("发布时间") };
}

/**
 * Split body text into the six named sections.
 * -> { fields, order, preamble, body } — a section the page does not carry is
 *    null (never an empty string), and unrecognized leading text stays in
 *    `preamble` instead of being folded into a section.
 */
export function splitSections(text) {
  const fields = Object.fromEntries(CASE_SECTIONS.map((s) => [s.field, null]));
  const order = [];
  const preamble = [];
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) {
      const joined = buf.join("\n").trim();
      fields[current.field] = joined || null;
    }
    buf = [];
  };
  for (const raw of String(text ?? "").split("\n")) {
    const line = raw.replace(/[\u3000\s]+/g, " ").trim();
    if (!line) continue;
    const m = SECTION_LINE_RE.exec(line);
    if (m) {
      flush();
      current = SECTION_BY_TITLE.get(m[1]);
      order.push(m[1]); // the page's own wording, aliases included
      if (m[2]) buf.push(m[2]);
      continue;
    }
    if (UNKNOWN_HEADING_RE.test(line)) {
      throw new SelectorDriftError(`unrecognized section heading "${line}"`);
    }
    if (current) buf.push(line);
    else preamble.push(line);
  }
  flush();
  return { fields, order, preamble };
}

/**
 * Parse a case (or batch-notice) detail page.
 * -> { title, source, publishAt, sections, sectionOrder, preamble, body }
 * Throws SelectorDriftError when the page does not carry the pinned containers.
 */
export function parseDetailPage(html, { url } = {}) {
  const text = String(html ?? "");
  const titleM = text.match(/<div class="detail">\s*<div class="title">([\s\S]*?)<\/div>/);
  const bodyOpen = '<div class="txt_txt">';
  const bodyStart = text.indexOf(bodyOpen);
  if (!titleM || bodyStart < 0) {
    throw new SelectorDriftError("detail page is missing its title or body container", { url });
  }
  const ends = ['<div class="txt_etr">', "<!--分享-->"]
    .map((marker) => text.indexOf(marker, bodyStart))
    .filter((i) => i > bodyStart);
  const bodyEnd = ends.length ? Math.min(...ends) : text.length;
  const rawBody = text.slice(bodyStart + bodyOpen.length, bodyEnd);
  const bodyText = htmlToText(rawBody);
  let split;
  try {
    split = splitSections(bodyText);
  } catch (err) {
    if (err instanceof SelectorDriftError) throw new SelectorDriftError(err.message, { url });
    throw err;
  }
  const { fields, order, preamble } = split;
  const { source, publishAt } = parseMeta(text);
  return {
    title: normalizeText(htmlToText(titleM[1])),
    source,
    publishAt,
    sections: fields,
    sectionOrder: order,
    preamble,
    body: bodyText
      .split("\n")
      .map((l) => l.replace(/[\u3000\s]+/g, " ").trim())
      .filter(Boolean)
      .join("\n"),
  };
}
