// Nightly wenshu crawl orchestration (spec wenshu-incremental-crawl):
// date-window slicing under the site's result cap → docId collection → paced
// detail capture → one daily JSONL + manifest under raw/{yyyy}/{mm}/;
// per-run resume checkpoint; per-month seen-set against look-back duplicates.
// The browser adapter is injected (dependency inversion) so this module is
// fully unit-testable and never imports playwright. Fail loud on selector
// drift / session loss; never emit partial logged-out results.
import { putIfChanged } from "../s3.js";
import { pickDocId } from "./ids.js";
import { computeWindow, planSlices } from "./slicer.js";

// Schema-D-isomorphic catalog columns, in dict order (17 fields).
const DICT_COLS = [
  "案号", "标题", "法院", "案由", "省", "市",
  "案件类型", "文书类型", "审理程序", "案例级别", "法院级别", "法条",
  "判决时间", "发布时间", "受理时间", "判决年份", "判决结果",
];

// Subdivision axes for slices over the result cap: 34 province-level
// divisions and the site's five case-type facets (names only; the slicer
// passes them straight into the search filters).
export const DEFAULT_REGIONS = [
  "北京市", "天津市", "上海市", "重庆市",
  "河北省", "山西省", "辽宁省", "吉林省", "黑龙江省",
  "江苏省", "浙江省", "安徽省", "福建省", "江西省", "山东省",
  "河南省", "湖北省", "湖南省", "广东省", "海南省",
  "四川省", "贵州省", "云南省", "陕西省", "甘肃省", "青海省", "台湾省",
  "内蒙古自治区", "广西壮族自治区", "西藏自治区", "宁夏回族自治区", "新疆维吾尔自治区",
  "香港特别行政区", "澳门特别行政区",
];
export const DEFAULT_CASE_TYPES = ["民事", "刑事", "行政", "执行", "赔偿"];

const todayBeijing = (tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const yearOf = (t) => {
  const m = /^(\d{4})/.exec(String(t ?? ""));
  return m ? Number(m[1]) : null;
};

// Selector drift or a dead session means every subsequent capture is garbage
// (or a logged-out partial): those abort the run instead of being recorded as
// per-doc errors. SessionError travels by name from lib/wenshu/session.js and
// site.js's assertSession throws plain "wenshu: session invalid — ..." errors.
const isDriftClass = (err) =>
  String(err?.message ?? err).startsWith("selector-drift:") ||
  String(err?.message ?? err).startsWith("wenshu: session invalid") ||
  err?.name === "SessionError";

// The detail page a document lives on. Recorded on every row so a later text pass
// (or the customer, logged in themselves) can fetch it: the docId is the token
// the list links carry.
export const detailUrl = (docId) => `https://wenshu.court.gov.cn/website/wenshu/181107ANFZ0BXSK4/index.html?docId=${docId}`;

// A listing row carries the same catalog fields the detail page does (minus the
// body), so a metadata-only crawl shapes it exactly like a detail capture — same
// doc_id derivation, same columns — and simply has no qwContent.
const metaToDetail = (meta, id) => {
  const ymd = (v) => { const m = String(v || "").match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/); return m ? `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}` : null; };
  return {
    nativeDocId: null,
    案号: meta.案号 ?? null,
    标题: meta.标题 ?? null,
    法院: meta.法院 ?? null,
    案件类型: meta.案件类型 ?? null,
    判决时间: ymd(meta.判决时间),
    qwContent: null,
    url: meta.url ?? detailUrl(id),
  };
};

export function shapeRow(detail, pickId = pickDocId) {
  const { doc_id, id_origin } = pickId({
    native: detail.nativeDocId,
    案号: detail.案号,
    法院: detail.法院,
    判决时间: detail.判决时间,
  });
  const row = { docId: doc_id, id_origin };
  for (const col of DICT_COLS) {
    row[col] = col === "判决年份" ? (detail.判决年份 ?? yearOf(detail.判决时间)) : (detail[col] ?? null);
  }
  row.qwContent = detail.qwContent ?? null; // HTML preserved as-is (spec); may be null
  row.url = detail.url ?? null; // detail page, so the text can be fetched later
  return row;
}

// worker: optional suffix so several crawl workers can write the same run date
// concurrently without clobbering each other's day file (multi-tab backfill).
export const dailyKey = (ymd, worker = "") =>
  `raw/${ymd.slice(0, 4)}/${ymd.slice(5, 7)}/crawl-${ymd}${worker ? `-${worker}` : ""}.jsonl`;
export const manifestKey = (ymd, worker = "") => dailyKey(ymd, worker).replace(/\.jsonl$/, ".manifest.json");
export const seenKey = (ym, worker = "") =>
  `raw/${ym.slice(0, 4)}/${ym.slice(5, 7)}/seen${worker ? `-${worker}` : ""}.json`; // ym = '2026-09'

// A single-day window is one day of data, so the file is named after that day
// rather than the run date: each file then holds exactly one 裁判日期 day and
// sits in that day's month. The loader packs blocks per file month, so a file
// named after the run date would push month-boundary days into the next
// month's blocks (and out of their own). Multi-day windows keep the run date.
export const dayFile = (since, until, runDate, worker = "") => {
  const fileDay = since && until && since === until ? since : runDate;
  return { fileDay, fileMonth: fileDay.slice(0, 7), dayKey: dailyKey(fileDay, worker) };
};

// Every 'YYYY-MM' the [start, end] window overlaps, plus the run month —
// look-back dedup checks the union so a window straddling a month boundary
// is checked against both months' seen sets.
function monthsOf(start, end, extraYm) {
  const yms = new Set(extraYm ? [extraYm] : []);
  let cur = `${start.slice(0, 7)}-01`;
  const last = `${end.slice(0, 7)}-01`;
  for (let i = 0; i < 2400 && cur <= last; i++) { // 200-year sanity guard
    yms.add(cur.slice(0, 7));
    const d = new Date(`${cur}T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + 1);
    cur = d.toISOString().slice(0, 10);
  }
  return [...yms].sort();
}

// Union of seen.json docs across months; also keeps the per-month split so
// checkpoints rewrite only the run month. Missing/corrupt file → empty set.
//
// Seen grows monotonically, so a read-modify-write of one shared file per month
// loses the other worker's entries whenever two of them finish at once (the
// loser's docs get re-fetched on the next look-back). Each worker therefore reads
// the shared file plus its own and writes only its own; days are disjoint across
// workers, so no worker needs the others' fresh entries.
async function loadSeen(s3, bucket, months, worker = "") {
  const docs = new Set();
  const byMonth = new Map();
  for (const ym of months) {
    const set = new Set();
    const keys = worker ? [seenKey(ym), seenKey(ym, worker)] : [seenKey(ym)];
    for (const key of keys) {
      const buf = await s3.getObject(bucket, key);
      if (!buf) continue;
      try {
        for (const d of JSON.parse(buf.toString("utf8"))?.docs ?? []) {
          set.add(d);
          docs.add(d);
        }
      } catch { /* corrupt seen.json: treat as empty; the next save repairs it */ }
    }
    byMonth.set(ym, set);
  }
  return { docs, byMonth };
}

async function saveSeen(s3, bucket, ym, docs, worker = "") {
  await putIfChanged(s3, bucket, seenKey(ym, worker), JSON.stringify({ month: ym, docs: [...new Set(docs)].sort() }, null, 1), {
    contentType: "application/json",
  });
}

const serializeRows = (rows) => (rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "");

export async function crawl(opts = {}) {
  const {
    s3, bucket, adapter,
    today = null, lookbackDays = 7, rateMs = 1000,
    budgetMs = 19 * 3600 * 1000, resultCap = 200, maxPages = 20,
    regions = DEFAULT_REGIONS, caseTypes = DEFAULT_CASE_TYPES,
    checkpointEvery = 100, dryRun = false, since = null, until = null, worker = "",
    // Metadata-only crawl: the list rows carry 标题/法院/案号/裁判日期/案件类型 and the
    // document's token, so skip the detail page entirely — one request per five
    // documents instead of one per document. Rows have no qwContent but do carry
    // the detail `url`, which is what a later text pass (or the customer's own
    // login) needs. See design.md on the account's ban risk.
    metaOnly = false,
    courtLevels = [],
    docTypes = [],
    reasonAxes = {},
    childrenOfReason = null,
  } = opts;

  const t0 = Date.now();
  let window = computeWindow({ today: today ?? todayBeijing("Asia/Shanghai"), lookbackDays });
  if (since) window = { ...window, start: since }; // explicit --since override (CLI)
  if (until) window = { ...window, end: until }; // explicit --until override (CLI)
  const runDate = window.runDate;
  // naming rule: see dayFile above (single-day window → named after the data day)
  const { fileDay, fileMonth, dayKey } = dayFile(since, until, runDate, worker);

  const { slices, stats } = await planSlices({
    window,
    regions,
    caseTypes,
    courtLevels: metaOnly || courtLevels.length ? courtLevels : [],
    docTypes: metaOnly || docTypes.length ? docTypes : [],
    reasonAxes,
    childrenOfReason,
    countOf: (sl) => adapter.searchTotal(sl),
    resultCap,
  });

  const errors = []; // capped below; counts.errors carries the true total
  const MAX_RECORDED_ERRORS = 50;
  let errorTotal = 0;
  const capped = []; // slices the site's per-query cap truncated (recorded, not retried)

  const docIds = new Set();
  const listMeta = new Map(); // docId -> listing metadata (meta-only mode)
  for (const slice of slices) {
    let ids;
    let rows = null;
    try {
      if (metaOnly && typeof adapter.listRows === "function") {
        rows = await adapter.listRows(slice, { maxPages });
        ids = rows.map((r) => r.docId);
      } else {
        ids = await adapter.listDocIds(slice, { maxPages });
      }
      for (const r of rows ?? []) listMeta.set(r.docId, r);
    } catch (err) {
      // A truncated listing is not an empty slice: keep what it did list — those
      // documents exist. A slice cut off by the site's per-query cap is recorded
      // and left alone (re-listing it returns the same documents), while any other
      // shortfall counts as an error so the day is retried; either way the day is
      // never recorded as complete when documents are missing.
      if (err?.name !== "ShortListingError" || !Array.isArray(err.tokens)) throw err;
      ids = err.tokens;
      for (const r of err.rows ?? []) listMeta.set(r.docId, r);
      if (err.capped) {
        capped.push({ slice: JSON.stringify(slice), listed: err.got, total: err.total });
      } else {
        errorTotal++;
        if (errors.length < MAX_RECORDED_ERRORS) errors.push({ slice: JSON.stringify(slice), error: String(err.message).slice(0, 300) });
      }
    }
    for (const id of ids) docIds.add(id);
  }

  // Resume: a same-day file from an interrupted run seeds the row list and
  // the captured set, so a restart re-fetches nothing already emitted
  // (torn tail line from a mid-PUT read tolerated and skipped).
  const rows = [];
  const captured = new Set(); // emitted row docIds AND the native list ids
  if (!dryRun) {
    const prior = await s3.getObject(bucket, dayKey);
    if (prior) {
      for (const line of prior.toString("utf8").split("\n").filter(Boolean)) {
        try {
          const row = JSON.parse(line);
          rows.push(row);
          captured.add(row.docId);
        } catch { /* torn tail line; skip */ }
      }
    }
  }
  const resumedFrom = rows.length;

  // Look-back dedup across every month the window touches plus the run month.
  const { docs: seen, byMonth: seenByMonth } = dryRun
    ? { docs: new Set(), byMonth: new Map() }
    : await loadSeen(s3, bucket, monthsOf(window.start, window.end, fileMonth), worker);
  const skippedSeen = [...docIds].filter((id) => seen.has(id) && !captured.has(id)).length;
  const todo = [...docIds].filter((id) => !captured.has(id) && !seen.has(id)).sort();

  let truncated = false;
  let sinceCheckpoint = 0;

  const checkpoint = async (force) => {
    if (dryRun || (!force && sinceCheckpoint < checkpointEvery)) return;
    sinceCheckpoint = 0;
    // Transient S3 stalls must not kill a multi-hour run — the resume logic
    // picks up from the last successful checkpoint (same policy as flk).
    try {
      await s3.putObject(bucket, dayKey, serializeRows(rows), { contentType: "application/x-ndjson" });
      await saveSeen(s3, bucket, fileMonth, new Set([...(seenByMonth.get(fileMonth) ?? []), ...captured]), worker);
    } catch (err) {
      console.error(`[wenshu-crawl] checkpoint write failed (will retry at next checkpoint): ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };

  let lastFetchAt = 0;
  try {
    for (const id of todo) {
      if (Date.now() - t0 > budgetMs) { truncated = true; break; } // budget first, before pacing
      const wait = lastFetchAt + (metaOnly ? 0 : rateMs) - Date.now();
      if (wait > 0) await sleep(wait); // keep consecutive detail fetches ≥ rateMs apart
      lastFetchAt = Date.now();
      let row;
      try {
        row = metaOnly
          ? shapeRow(metaToDetail(listMeta.get(id) ?? {}, id))
          : shapeRow(await adapter.fetchDetail(id));
      } catch (err) {
        if (isDriftClass(err)) throw err; // abort: everything after this is garbage
        errorTotal++;
        if (errors.length < MAX_RECORDED_ERRORS) errors.push({ docId: id, error: String(err?.message ?? err).slice(0, 300) });
        continue; // ordinary per-doc failure: record and move on
      }
      rows.push(row);
      captured.add(row.docId);
      captured.add(id); // native list id — dedups later runs even when the row id is derived
      sinceCheckpoint++;
      await checkpoint(false);
    }
  } catch (err) {
    if (!dryRun) await checkpoint(true); // keep whatever was captured before aborting
    throw err;
  }

  rows.sort((a, b) => (a.判决时间 ?? "").localeCompare(b.判决时间 ?? "") || (a.docId ?? "").localeCompare(b.docId ?? ""));
  const withText = rows.filter((r) => r.qwContent).length;
  const manifest = {
    date: runDate,
    window,
    metaOnly,
    slices: { planned: slices.length, ...stats, overflow: slices.filter((s) => s.overflow).length },
    candidates: docIds.size,
    skippedSeen,
    resumedFrom,
    emitted: rows.length,
    counts: { withText, missingText: rows.length - withText, errors: errorTotal, capped: capped.length },
    finishedAt: new Date().toISOString(),
  };
  if (capped.length) manifest.capped = capped;
  if (truncated) manifest.truncated = true;
  if (errors.length) manifest.errors = errors;

  if (!dryRun) {
    // A run with zero new docs still (re)writes the daily file and manifest
    // (heartbeat for reconciliation). Exit semantics belong to the CLI.
    await s3.putObject(bucket, dayKey, serializeRows(rows), { contentType: "application/x-ndjson" });
    await saveSeen(s3, bucket, fileMonth, new Set([...(seenByMonth.get(fileMonth) ?? []), ...captured]), worker);
    await putIfChanged(s3, bucket, manifestKey(fileDay, worker), JSON.stringify(manifest, null, 1), { contentType: "application/json" });
  }
  return { manifest, rows };
}
