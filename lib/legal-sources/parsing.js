// Small, dependency-free HTML/JSON helpers shared by wave-1 source adapters.
// They are intentionally tolerant of common CMS wrappers, but any missing
// source_id/title raises StructureDriftError instead of producing empty rows.
import { StructureDriftError } from "./errors.js";

const ENTITIES = {
  "&nbsp;": " ",
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
};

export function decodeEntities(text) {
  return String(text ?? "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&[a-zA-Z#0-9]+;/g, (entity) => ENTITIES[entity] ?? entity);
}

export function stripHtml(html) {
  return decodeEntities(String(html ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function absoluteUrl(href, baseUrl) {
  if (!href) return null;
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

export function extractAnchors(html, { baseUrl, hrefPattern = null, containerPattern = null } = {}) {
  const scope = containerPattern
    ? String(html ?? "").match(containerPattern)?.[1] ?? String(html ?? "")
    : String(html ?? "");
  const anchors = [];
  const re = /<a\b[^>]*href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  for (const match of scope.matchAll(re)) {
    const href = match[1] ?? match[2] ?? match[3];
    const text = stripHtml(match[4]);
    const url = absoluteUrl(href, baseUrl);
    if (!url || !text) continue;
    if (hrefPattern && !hrefPattern.test(url)) continue;
    anchors.push({ title: text, url, href });
  }
  return anchors;
}

export function pickPath(value, path) {
  let current = value;
  for (const segment of String(path ?? "").split(".").filter(Boolean)) {
    if (current == null) return undefined;
    if (Array.isArray(current)) current = current[Number(segment)];
    else current = current[segment];
  }
  return current;
}

export function firstDefined(value, paths) {
  for (const path of paths) {
    const candidate = pickPath(value, path);
    if (candidate !== undefined && candidate !== null && candidate !== "") return candidate;
  }
  return undefined;
}

export function firstArray(value, paths) {
  for (const path of paths) {
    const candidate = pickPath(value, path);
    if (Array.isArray(candidate)) return candidate;
  }
  return [];
}

export function requireSourceId(candidate, context = "entry") {
  const value = firstDefined(candidate, ["id", "source_id", "uuid", "docId", "url", "href"]);
  if (value == null || String(value).trim() === "") {
    throw new StructureDriftError(`${context} has no id`, { candidate: typeof candidate });
  }
  return String(value);
}

export function cleanText(value) {
  if (value == null) return null;
  const text = stripHtml(String(value));
  return text || null;
}

export function toIsoDateTime(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim().replace(/[年月]/g, "-").replace(/[日时]/g, " ").replace(/:/g, ":");
  const match = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/);
  if (!match) return null;
  const [, y, m, d, hh = "00", mi = "00", ss = "00"] = match;
  const iso = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}T${hh.padStart(2, "0")}:${mi.padStart(2, "0")}:${ss.padStart(2, "0")}+08:00`;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : iso;
}

// Chinese CMS pages commonly use label/value rows in tables or definition lists.
export function labeledValues(html, labels = []) {
  const text = String(html ?? "");
  const out = {};
  for (const label of labels) {
    const patterns = [
      new RegExp(`${label}\\s*[::]\\s*(?:<[^>]+>\\s*)*([^<]+)`, "i"),
      new RegExp(`${label}</[^>]+>\\s*<[^>]+>\\s*([^<]+)`, "i"),
      new RegExp(`${label}\\s*</(?:th|dt|strong|b)>\\s*<(?:td|dd)>\\s*([^<]+)`, "i"),
    ];
    for (const re of patterns) {
      const match = text.match(re);
      if (match) {
        out[label] = cleanText(match[1]);
        break;
      }
    }
  }
  return out;
}

// Split a detail page into named sections while leaving unknown headings
// visible in metadata.unknown_sections. This keeps drift observable without
// throwing away the whole document merely because one optional heading moved.
export function splitChineseSections(html, headings) {
  const text = String(html ?? "");
  const sectionHtml = [];
  const headingRe = new RegExp(
    `<(?:h[1-6]|strong|b|dt|p)\\b[^>]*>\\s*(?:<[^>]+>\\s*)*(${headings.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\s*(?:<[^>]+>\\s*)*<\\/(?:h[1-6]|strong|b|dt|p)>`,
    "gi",
  );
  let match;
  while ((match = headingRe.exec(text))) {
    sectionHtml.push({ heading: match[1], start: match.index + match[0].length });
  }
  const sections = {};
  const unknown = [];
  const headingSet = new Set(headings);
  for (let i = 0; i < sectionHtml.length; i++) {
    const current = sectionHtml[i];
    const end = i + 1 < sectionHtml.length ? sectionHtml[i + 1].start : text.length;
    const body = cleanText(text.slice(current.start, end));
    if (headingSet.has(current.heading)) sections[current.heading] = body;
    else unknown.push(current.heading);
  }
  const headingTexts = [...text.matchAll(/<(?:h[1-6]|strong|b|dt|p)\b[^>]*>\s*([^<]{1,40})\s*<\//gi)]
    .map((m) => cleanText(m[1]))
    .filter(Boolean);
  for (const heading of headingTexts) {
    if (!headingSet.has(heading) && !unknown.includes(heading)) unknown.push(heading);
  }
  return { sections, unknown };
}

export function paginatePath(page, template) {
  if (!template) return null;
  if (!template.includes("{page}")) return page === 1 ? template : null;
  return template.replace("{page}", String(page));
}
