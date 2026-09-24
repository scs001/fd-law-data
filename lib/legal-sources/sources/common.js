// Factory for the five wave-1 HTTP-first adapters. The factory owns only
// request shape and response routing; each source file supplies pure parsers,
// so fixtures can prove field mapping without network access.
import { StructureDriftError } from "../errors.js";
import {
  cleanText,
  extractAnchors,
  firstArray,
  firstDefined,
  labeledValues,
  paginatePath,
  requireSourceId,
  stripHtml,
  toIsoDateTime,
} from "../parsing.js";

function sourceEnv(config, suffix) {
  return `${config.envPrefix ?? config.id.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function listUrl(config, filters, page) {
  const override = filters.listUrl ?? process.env[sourceEnv(config, "LIST_URL")];
  const url = override ?? paginatePath(page, config.list.url) ?? config.list.url;
  if (!url) throw new StructureDriftError(`${config.id} has no configured list URL`);
  return url;
}

function sourceTotal(config, json, listed) {
  const total = firstDefined(json, config.list.totalPaths ?? []);
  return total == null ? listed.length : Number(total);
}

function totalPagesFrom(config, json, listed, { page, size }) {
  if (config.list.kind !== "html") {
    const total = firstDefined(json, config.list.totalPaths ?? []);
    if (Number.isFinite(Number(total)) && Number(total) > 0) {
      return Math.ceil(Number(total) / Math.max(1, size));
    }
    const pages = firstDefined(json, config.list.pagesPaths ?? []);
    return pages == null ? page : Number(pages);
  }
  const parsed = config.list.parsePages?.(json, { page });
  if (Number.isFinite(Number(parsed)) && Number(parsed) > 0) return Number(parsed);
  return listed.length ? page : 0;
}

export function createHttpSourceAdapter(config) {
  if (!config?.id || !config?.parseDetail) throw new Error("source adapter config requires id and parseDetail");

  async function listPage(filters, helpers, page) {
    const url = listUrl(config, filters, page);
    const opts = {};
    if (config.list.method === "POST") {
      opts.method = "POST";
      opts.headers = { "content-type": "application/json;charset=UTF-8" };
      opts.body = JSON.stringify(config.list.body?.({ ...filters, page }) ?? {});
    } else if (config.list.form) {
      opts.method = "POST";
      opts.headers = { "content-type": "application/x-www-form-urlencoded" };
      const params = new URLSearchParams(config.list.form({ ...filters, page }));
      opts.body = params.toString();
    }
    const raw = config.list.kind === "html"
      ? await helpers.fetchText(url, opts)
      : await helpers.fetchJson(url, opts);
    const entries = config.list.kind === "html"
      ? config.parseList(raw, { baseUrl: url, filters, page })
      : config.parseList(raw, { filters, page });
    if (config.list.kind === "html" && page > 1 && !entries.length) {
      throw new StructureDriftError(`page ${page} yielded no entries`, { url });
    }
    return { url, raw, entries };
  }

  async function list(filters, helpers) {
    const maxPages = Number(filters.maxPages ?? config.list.maxPages ?? 1000);
    const size = Number(filters.size ?? config.list.size ?? 10);
    const page = Number(filters.page ?? 1);
    const seen = new Set();
    const entries = [];
    // Only the current page's raw response is retained (pagination parsing):
    // accumulating every page OOM-killed a whole-catalog crawl on a small
    // node (mfa-treaty: 747 pages of raw HTML ≈ 750MB before details ran).
    let lastRaw = null;
    let sourceTotal = null;
    let totalPages = page;
    let unreachablePages = [];

    for (let current = page; current <= Math.min(totalPages || page, maxPages); current++) {
      let result;
      try {
        result = await listPage(filters, helpers, current);
      } catch (err) {
        if (err?.name === "SessionProxyError" || err?.name === "AccountBannedError") throw err;
        unreachablePages.push({ page: current, reason: String(err?.message ?? err) });
        break;
      }
      lastRaw = result.raw;
      let newRows = 0;
      for (const entry of result.entries) {
        const sourceId = requireSourceId(entry, `${config.id} list item`);
        const key = String(sourceId);
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          ...entry,
          source_id: key,
          url: entry.url ?? config.detail?.urlFromEntry?.({ ...entry, source_id: key }) ?? null,
          doc_type: entry.doc_type ?? config.docType,
        });
        newRows++;
      }
      totalPages = totalPagesFrom(config, result.raw, result.entries, { page: current, size });
      sourceTotal = config.list.kind === "html" ? sourceTotal : sourceTotalFromJson(config, result.raw, entries);
      // A JSON API can return a final empty page; an HTML page that repeats no
      // new ids is the practical terminal signal for mis-declared pagination.
      if (!newRows || current >= maxPages) break;
    }

    return {
      entries,
      total: sourceTotal ?? entries.length,
      pages: totalPages,
      unreachablePages,
      raw: lastRaw ? [lastRaw] : [],
    };
  }

  function sourceTotalFromJson(config, json, entries) {
    if (config.list.kind === "html") return entries.length;
    const total = firstDefined(json, config.list.totalPaths ?? []);
    return total == null ? entries.length : Number(total);
  }

  async function detail(entry, helpers) {
    // API-backed details must not mistake the human page URL for the endpoint:
    // json-post adapters always route through their configured URL.
    const url = config.detail.kind === "json-post"
      ? config.detail.urlFromEntry?.(entry)
      : entry.url ?? config.detail?.urlFromEntry?.(entry);
    if (!url) throw new StructureDriftError(`detail entry has no url`, { sourceId: entry.source_id });
    const opts = {};
    if (config.detail.kind === "json-post") {
      opts.method = "POST";
      opts.headers = { "content-type": "application/json;charset=UTF-8" };
      opts.body = JSON.stringify(config.detail.body?.(entry) ?? { gid: encodeURIComponent(entry.source_id) });
    } else if (config.detail.form) {
      opts.method = "POST";
      opts.headers = { "content-type": "application/x-www-form-urlencoded" };
      const params = new URLSearchParams(config.detail.form(entry));
      opts.body = params.toString();
    }
    const raw = config.detail.kind === "html"
      ? await helpers.fetchText(url, opts)
      : await helpers.fetchJson(url, opts);
    const parsed = config.parseDetail(raw, entry, { baseUrl: url });
    if (!parsed?.title) throw new StructureDriftError(`detail ${entry.source_id} has no title`, { url });
    // Versioned adapters may replace the list token with a canonical-id +
    // content-version id; ordinary adapters keep the stable list token.
    const sourceId = parsed.source_id ?? entry.source_id;
    const artifacts = [];
    for (const attachment of parsed.attachments ?? []) {
      if (!attachment.url) continue;
      const fetched = await helpers.fetchBuffer(attachment.url);
      artifacts.push({
        kind: "attachment",
        filename: attachment.filename ?? new URL(attachment.url).pathname.split("/").pop() ?? `${sourceId}.bin`,
        contentType: fetched.contentType,
        body: fetched.body,
      });
    }
    return {
      document: {
        source_id: sourceId,
        doc_type: parsed.doc_type ?? config.docType,
        title: parsed.title,
        published_at: toIsoDateTime(parsed.published_at),
        effective_at: toIsoDateTime(parsed.effective_at),
        status: parsed.status ?? null,
        authority: parsed.authority ?? null,
        language: parsed.language ?? null,
        content: parsed.content ?? null,
        source_url: url,
        metadata: {
          ...(parsed.metadata ?? {}),
          categories: parsed.categories ?? null,
          sections: parsed.sections ?? null,
          unknown_sections: parsed.unknown_sections ?? null,
          missing_fields: parsed.missing_fields ?? null,
        },
      },
      artifacts,
      hash: parsed.hash ?? null,
    };
  }

  return {
    id: config.id,
    mode: config.mode ?? "http",
    rateMs: config.rateMs ?? 1100,
    requiresProxy: Boolean(config.requiresProxy),
    headers: config.headers,
    list,
    detail,
  };
}

export { cleanText, extractAnchors, firstArray, firstDefined, labeledValues, stripHtml };
