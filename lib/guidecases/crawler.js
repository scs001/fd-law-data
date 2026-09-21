// Crawler for the SPC public column of guiding cases.
// Contract (specs/court-guiding-cases): exhaustive column sweep, structured
// section capture, idempotent snapshot in the laws bucket under `guide-cases/`,
// no login, sequential and rate-limited, stop on the first anomaly. The
// crawler holds no PG credentials.
import { createHash } from "node:crypto";
import { setMinInterval, fetchWithRetry } from "../http.js";
import { putIfChanged } from "../s3.js";
import { listPageUrl, parseListPage, parseDetailPage, missingNumbers, normalizeText, SelectorDriftError } from "./site.js";

export const PART_SIZE = 300;
export const FETCH_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
};

/**
 * Default page fetch: returns the page TEXT, never a Response, and turns any
 * non-success status into an error — the crawl stops on the first anomaly
 * instead of retrying (specs/court-guiding-cases). Pacing comes from the
 * shared limiter in lib/http.js.
 */
export async function defaultFetchPage(url) {
  const res = await fetchWithRetry(url, { headers: FETCH_HEADERS }, { retries: 0, timeoutMs: 30000 });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

/** Column pager state: total articles, the last page, and whether 下一页 is live. */
export function parsePager(html) {
  const text = String(html ?? "");
  const ul = text.match(/<ul id="yw1" class="yiiPager">([\s\S]*?)<\/ul>/);
  const scope = ul ? ul[1] : text;
  const totalM = text.match(/共<span class="num">\s*(\d+)\s*<\/span>篇文章/);
  const pageOf = (href) => {
    const m = /_(\d+)\.html$/.exec(href ?? "");
    return m ? Number(m[1]) : 1;
  };
  const link = (cls) => {
    const m = scope.match(new RegExp(`<li class="${cls}([^"]*)"[^>]*>\\s*<a href="([^"]+)"`));
    if (!m) return null;
    return { hidden: m[1].includes("hidden"), page: pageOf(m[2]) };
  };
  const next = link("next");
  const last = link("last");
  return {
    total: totalM ? Number(totalM[1]) : null,
    nextPage: next && !next.hidden ? next.page : null,
    lastPage: last ? last.page : 1,
  };
}

/**
 * Walk the column to its last page. Every page is fetched, every entry
 * classified, and the result is checked against the pager's own totals — a
 * sweep that cannot account for the whole column fails loudly instead of
 * emitting a partial view. Case numbers must be unique.
 */
export async function sweepColumn({ fetchPage, log = () => {} }) {
  const entries = [];
  const seenIds = new Set();
  let total = null;
  let lastPage = null;
  let page = 1;
  let pages = 0;
  for (;;) {
    const url = listPageUrl(page);
    const html = await fetchPage(url);
    const { entries: pageEntries } = parseListPage(html);
    const pager = parsePager(html);
    if (pager.total !== null) total = pager.total;
    lastPage = pager.lastPage;
    if (!pageEntries.length) {
      throw new SelectorDriftError(`list page ${page} yielded no entries`, { url });
    }
    pages++;
    for (const entry of pageEntries) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      entries.push(entry);
    }
    log(`[guide-cases] list page ${page}/${lastPage}: ${pageEntries.length} entries, ${entries.length} seen`);
    if (!pager.nextPage) break;
    if (pager.nextPage <= page) {
      throw new SelectorDriftError(`pager on page ${page} points back to page ${pager.nextPage}`, { url });
    }
    page = pager.nextPage;
    if (pages > 500) throw new SelectorDriftError("column pager did not terminate");
  }
  if (pages !== lastPage) {
    throw new SelectorDriftError(`walked ${pages} page(s) but the pager reports ${lastPage}`);
  }
  if (total !== null && entries.length !== total) {
    throw new SelectorDriftError(`column reports ${total} articles but ${entries.length} entries parsed`);
  }

  const cases = [];
  const notices = [];
  const byNumber = new Map();
  for (const entry of entries) {
    if (entry.kind === "case") {
      if (byNumber.has(entry.caseNo)) {
        throw new SelectorDriftError(
          `case number ${entry.caseNo} appears twice: ${byNumber.get(entry.caseNo).url} and ${entry.url}`,
        );
      }
      byNumber.set(entry.caseNo, entry);
      cases.push(entry);
    } else {
      notices.push(entry);
    }
  }
  return {
    entries,
    cases,
    notices,
    byNumber,
    pages,
    total,
    coverage: missingNumbers(cases.map((c) => c.caseNo)),
  };
}

/** Stable content hash of a record (fetch time is deliberately not part of it). */
export function contentHash(record) {
  const material = JSON.stringify({
    title: record.title,
    source: record.source,
    publishAt: record.publishAt,
    listedAt: record.listedAt,
    sections: record.sections,
    body: record.body,
  });
  return createHash("sha256").update(material).digest("hex");
}

/** "2026-02-28 18:50:04" (Asia/Shanghai wall clock) -> ISO instant, or null. */
export function toInstant(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?$/.exec(String(value ?? "").trim());
  if (!m) return null;
  const [, y, mo, d, hh = "00", mi = "00", ss = "00"] = m;
  return `${y}-${mo}-${d}T${hh}:${mi}:${ss}+08:00`;
}

const runDateBeijing = () => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
}).format(new Date());

export const runPrefix = (runDate) => {
  const [y, m] = runDate.split("-");
  return `guide-cases/${y}/${m}/guide-${runDate}`;
};
export const partKey = (runDate, n) => `${runPrefix(runDate)}-part${String(n).padStart(3, "0")}.jsonl`;
export const manifestKey = (runDate) => `${runPrefix(runDate)}.manifest.json`;

/** First free part number for a run date: parts are append-only, never rewritten. */
export async function nextPartNumber(s3, bucket, runDate) {
  const existing = await listAll(s3, bucket, `${runPrefix(runDate)}-part`);
  let next = 1;
  for (const { key } of existing) {
    const m = /-part(\d+)\.jsonl$/.exec(key);
    if (m) next = Math.max(next, Number(m[1]) + 1);
  }
  return next;
}

async function listAll(s3, bucket, prefix) {
  const out = [];
  let token;
  for (;;) {
    const page = await s3.listObjects(bucket, { prefix, continuationToken: token });
    out.push(...page.contents);
    if (!page.truncated) break;
    token = page.continuationToken;
  }
  return out;
}

/**
 * Hash baseline for the diff: every manifest under the prefix, oldest first,
 * folded into one id -> hash map (a later run's view of an entry wins).
 */
export async function loadSnapshotHashes(s3, bucket, prefix = "guide-cases/") {
  const manifests = (await listAll(s3, bucket, prefix))
    .filter((o) => o.key.endsWith(".manifest.json"))
    .map((o) => o.key)
    .sort();
  const hashes = {};
  for (const key of manifests) {
    const buf = await s3.getObject(bucket, key);
    if (!buf) continue;
    try {
      const manifest = JSON.parse(buf.toString("utf8"));
      Object.assign(hashes, manifest.hashes ?? {});
    } catch {
      // A manifest we cannot read only costs a re-emit; never a hard failure.
    }
  }
  return hashes;
}

function toRecord(entry, parsed, fetchedAt) {
  return {
    source_id: entry.id,
    case_no: entry.caseNo,
    doc_type: entry.kind,
    title: parsed.title || entry.title,
    listed_at: entry.date,
    publish_at: toInstant(parsed.publishAt),
    source: parsed.source,
    source_url: entry.url,
    fetched_at: fetchedAt,
    sections: parsed.sections,
    section_order: parsed.sectionOrder,
    preamble: parsed.preamble,
    body: parsed.body,
  };
}

/**
 * One crawl run: sweep, fetch changed details, then write parts + manifest.
 * Records are buffered and written only after the whole sweep succeeds, so a
 * run that stops on an anomaly leaves the bucket untouched (the corpus is a
 * few MB, so buffering costs nothing).
 */
export async function crawl({
  s3,
  bucket,
  prefix = "guide-cases/",
  rateMs = 1100,
  dryRun = false,
  limit,
  fetchPage,
  log = console.error,
} = {}) {
  setMinInterval(rateMs);
  const doFetch = fetchPage ?? defaultFetchPage;

  const sweep = await sweepColumn({ fetchPage: doFetch, log });
  const wanted = limit ? sweep.entries.slice(0, Number(limit)) : sweep.entries;
  const previous = dryRun ? {} : await loadSnapshotHashes(s3, bucket, prefix);

  const hashes = { ...previous };
  const records = [];
  const fetchedAt = new Date().toISOString();
  let unchanged = 0;
  for (const entry of wanted) {
    const html = await doFetch(entry.url);
    const parsed = parseDetailPage(html, { url: entry.url });
    if (entry.kind === "case" && parsed.sectionOrder.length === 0) {
      throw new SelectorDriftError(
        `case ${entry.caseNo} carries none of the known section headings`,
        { url: entry.url },
      );
    }
    const record = toRecord(entry, parsed, fetchedAt);
    const hash = contentHash(record);
    record.content_hash = hash;
    hashes[entry.id] = hash;
    if (previous[entry.id] === hash) {
      unchanged++;
      continue;
    }
    records.push(record);
  }

  const runDate = runDateBeijing();
  const manifest = {
    runDate,
    partial: !!limit,
    prefix,
    sweep: {
      pages: sweep.pages,
      columnTotal: sweep.total,
      entries: sweep.entries.length,
      cases: sweep.cases.length,
      notices: sweep.notices.length,
      observed: wanted.length,
    },
    coverage: sweep.coverage,
    emitted: records.length,
    unchanged,
    hashes,
    finishedAt: new Date().toISOString(),
  };

  if (!dryRun && records.length) {
    // Parts are append-only: a second run on the same day continues the
    // sequence instead of overwriting the first run's part (which held a
    // different, larger set of records).
    let part = await nextPartNumber(s3, bucket, runDate);
    for (let i = 0; i < records.length; i += PART_SIZE) {
      const slice = records.slice(i, i + PART_SIZE);
      const key = partKey(runDate, part);
      await s3.putObject(bucket, key, slice.map((r) => JSON.stringify(r)).join("\n") + "\n", {
        contentType: "application/x-ndjson",
        timeoutMs: 120000,
      });
      log(`[guide-cases] wrote ${key} (${slice.length} records)`);
      part++;
    }
  }
  if (!dryRun) {
    await putIfChanged(s3, bucket, manifestKey(runDate), JSON.stringify(manifest, null, 1), {
      contentType: "application/json",
    });
  }

  return { manifest, records, sweep };
}

/** Titles in the sweep that carry no case number — provenance for the notices. */
export function noticeTitles(sweep) {
  return sweep.notices.map((n) => ({ id: n.id, title: normalizeText(n.title), date: n.date }));
}

/**
 * Fold every part file under the prefix into source_id -> record, oldest key
 * first so a later run's version of an entry wins. Parts are append-only, so
 * re-folding is the only state the loader needs — no processed-markers.
 */
export async function foldSnapshots(s3, bucket, prefix) {
  const parts = (await listAll(s3, bucket, prefix))
    .filter((o) => o.key.endsWith(".jsonl"))
    .map((o) => o.key)
    .sort();
  const folded = new Map();
  let records = 0;
  for (const key of parts) {
    const buf = await s3.getObject(bucket, key);
    if (!buf) continue;
    for (const line of buf.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // torn tail line from a mid-PUT read
      }
      if (!rec?.source_id) continue;
      folded.set(String(rec.source_id), rec);
      records++;
    }
  }
  return { folded, parts, records };
}
