// flk daily incremental crawler.
// Contract (specs/flk-law-incremental): watermark + look-back discovery over
// all types; docx capture with idempotent upload; daily JSONL + manifest in
// the laws bucket `incremental/` prefix; crawler holds no PG credentials.
import { setMinInterval } from "../http.js";
import { createS3, putIfChanged } from "../s3.js";
import { docxToText } from "../docxtext.js";
import { TOP_LEVEL_CODES, enumData, searchList, detail, downloadDocx, parseOssFile, stripHighlight, sxxName, fitCategory } from "./api.js";

const STATE_KEY = "incremental/state.json";

const todayBeijing = (tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

export function computeWindow({ watermark, lookbackDays, since }) {
  const today = todayBeijing("Asia/Shanghai");
  if (since) return { start: since, end: today };
  if (!watermark) return { start: addDays(today, -30), end: today };
  return { start: addDays(watermark, -Math.max(0, lookbackDays)), end: today };
}

export function buildDocxKey({ category, title, publish, effective }) {
  const enc = (s) => encodeURIComponent(s);
  // laws.file_path is varchar(512); percent-encoding inflates CJK ~9x, so the
  // encoded title is truncated to fit (PG raises 'value too long' otherwise —
  // hit live 2026-09-18 on long 地方性法规 titles).
  const fixed = `_${enc(publish)}_${enc(effective || publish)}.docx`;
  const budget = Math.max(0, 511 - enc(category).length - fixed.length);
  let t = title;
  while (enc(t).length > budget && t.length > 1) t = t.slice(0, -1);
  return {
    key: `${enc(category)}/${enc(t)}${fixed}`,
    truncated: t !== title,
  };
}

async function loadState(s3, bucket) {
  const buf = await s3.getObject(bucket, STATE_KEY);
  if (!buf) return { watermark: null, srcSeq: 0, known: [], lastRun: null };
  return JSON.parse(buf.toString("utf8"));
}

async function saveState(s3, bucket, state) {
  await putIfChanged(s3, bucket, STATE_KEY, JSON.stringify(state, null, 1), { contentType: "application/json" });
}

function rowToCandidate(row) {
  return {
    bbbs: row.bbbs,
    title: stripHighlight(row.title ?? ""),
    gbrq: row.gbrq ?? null,
    sxrq: row.sxrq ?? null,
    sxx: row.sxx ?? null,
    zdjgName: row.zdjgName ?? null,
    flxz: row.flxz ?? null,
    flfgCodeId: row.flfgCodeId ?? null,
  };
}

async function captureCandidate(s3, bucket, cand, nameByCode, assignSrcId) {
  // -> laws-shaped record; failures degrade to content_status pending/missing
  const rec = {
    src_db: "flk",
    source_id: cand.bbbs,
    src_id: null,
    category: fitCategory(cand.flxz, cand.flfgCodeId),
    title: cand.title,
    publish: cand.gbrq,
    expiry: null,
    type: nameByCode.get(cand.flfgCodeId) ?? cand.flxz,
    status: sxxName(cand.sxx),
    file_path: null,
    content: null,
    content_status: "missing",
    quality_flag: null,
    source_note: "flk-incremental",
    publish_effective: cand.sxrq,
    issued_by: cand.zdjgName,
  };
  try {
    const det = await detail(cand.bbbs);
    const oss = parseOssFile(det?.ossFile);
    rec.xgzl_count = (() => {
      try {
        return JSON.parse((det?.xgzl ?? "[]").replace(/'/g, '"')).length;
      } catch {
        return null;
      }
    })();
    if (!oss.ossWordPath) return rec;
    const { docx } = await downloadDocx(cand.bbbs);
    let text = "";
    try {
      text = docxToText(docx);
    } catch {
      rec.content_status = "pending";
      return rec;
    }
    rec.content = text;
    rec.content_status = text.length > 0 ? "ok" : "pending";
    const { key, truncated } = buildDocxKey({ category: rec.category, title: rec.title, publish: rec.publish, effective: rec.publish_effective });
    if (truncated) rec.quality_flag = "long-path";
    if (!s3.dryRun) {
      await putIfChanged(s3, bucket, key, docx, {
        contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });
    }
    rec.file_path = key;
    return rec;
  } catch (err) {
    rec.error = String(err?.message ?? err).slice(0, 300);
    if (rec.content_status === "missing") rec.content_status = "pending";
    return rec;
  }
}

const dailyKey = (dateStr) => {
  const [y, m] = dateStr.split("-");
  return `incremental/${y}/${m}/flk-${dateStr}.jsonl`;
};
const manifestKey = (dateStr) => dailyKey(dateStr).replace(/\.jsonl$/, ".manifest.json");

export async function crawl(opts = {}) {
  const { s3, bucket, lookbackDays, pageSize, since, codes, dryRun } = opts;
  s3.dryRun = !!dryRun;
  setMinInterval(opts.rateMs ?? 1100);

  const state = dryRun ? { watermark: null, srcSeq: 0, known: [], lastRun: null } : await loadState(s3, bucket);
  const window = computeWindow({ watermark: state.watermark, lookbackDays, since });
  const { topLevel, nameByCode } = await enumData();
  // Each top-level type is queried with its full descendant code list — the
  // list API matches flfgCodeId exactly (verified 2026-09-18, design.md D7).
  const codeGroups = codes?.length
    ? topLevel.filter((t) => codes.map(Number).includes(t.code)).map((t) => t.codes)
    : topLevel.map((t) => t.codes);

  const known = new Set(state.known ?? []);
  const candidates = new Map(); // bbbs -> cand
  const byCode = {};
  for (const codeList of codeGroups) {
    let pageNum = 1;
    let total = 0;
    let pages = 0;
    for (;;) {
      const { total: t, rows } = await searchList({ flfgCodeId: codeList, gbrqStart: window.start, gbrqEnd: window.end, pageNum, pageSize });
      total = t;
      pages++;
      for (const row of rows) {
        const cand = rowToCandidate(row);
        if (!cand.bbbs || known.has(cand.bbbs)) continue;
        candidates.set(cand.bbbs, cand);
      }
      if (pageNum * pageSize >= total || rows.length === 0 || pages >= 1000) break;
      pageNum++;
    }
    byCode[codeList.join(",")] = { total, pages };
  }

  const runDate = todayBeijing(opts.tz ?? "Asia/Shanghai");
  const [yy, mm] = runDate.split("-");
  const dayPrefix = `incremental/${yy}/${mm}/flk-${runDate}`;
  // Append-only part files: each part is written once and never rewritten, so
  // checkpoint uploads stay small (~10MB) no matter how long the day runs.
  // (The single-file design re-uploaded a growing 14MB→100MB+ object every 200
  // records and stalled to death on 2026-09-18 — zero progress in 9h.)
  const PART_SIZE = 300;
  const partKey = (n) => `${dayPrefix}-part${String(n).padStart(3, "0")}.jsonl`;
  const records = [];
  let nextPart = 1;
  if (!dryRun) {
    const { contents } = await s3.listObjects(bucket, { prefix: dayPrefix });
    for (const { key } of contents.sort((a, b) => (a.key < b.key ? -1 : 1))) {
      if (!/flk-\d{4}-\d{2}-\d{2}(-part\d+)?\.jsonl$/.test(key)) continue;
      const buf = await s3.getObject(bucket, key);
      for (const line of buf.toString("utf8").split("\n").filter(Boolean)) {
        try {
          const rec = JSON.parse(line);
          records.push(rec);
          known.add(rec.source_id);
          if (Number.isFinite(rec.src_id) && rec.src_id > state.srcSeq) state.srcSeq = rec.src_id;
        } catch { /* torn tail line from a mid-PUT read; skip */ }
      }
      const pm = key.match(/-part(\d+)\.jsonl$/);
      if (pm) nextPart = Math.max(nextPart, Number(pm[1]) + 1);
    }
  }
  const priorCount = records.length;
  let partStartIdx = records.length;
  const candidatesNow = [...candidates.values()].filter((c) => !known.has(c.bbbs));

  const counts = { ok: 0, pending: 0, missing: 0 };
  let sinceCheckpoint = 0;
  const CHECKPOINT_EVERY = 100;
  const checkpoint = async (force) => {
    if (dryRun || (!force && sinceCheckpoint < CHECKPOINT_EVERY)) return;
    sinceCheckpoint = 0;
    try {
      const part = records.slice(partStartIdx);
      if (part.length) {
        await s3.putObject(bucket, partKey(nextPart), part.map((r) => JSON.stringify(r)).join("\n") + "\n", {
          contentType: "application/x-ndjson",
          timeoutMs: 120000,
        });
      }
      state.known = [...known].sort();
      await saveState(s3, bucket, state);
      console.error(`[flk-crawl] checkpoint: ${records.length} records total, part #${nextPart} (+${part.length}), known ${state.known.length}`);
    } catch (err) {
      console.error(`[flk-crawl] checkpoint write failed (will retry at next checkpoint): ${String(err?.message ?? err).slice(0, 200)}`);
    }
  };

  for (const cand of candidatesNow) {
    const rec = await captureCandidate(s3, bucket, cand, nameByCode, () => ++state.srcSeq);
    rec.src_id = ++state.srcSeq;
    records.push(rec);
    counts[rec.content_status] = (counts[rec.content_status] ?? 0) + 1;
    known.add(cand.bbbs);
    sinceCheckpoint++;
    if (records.length - partStartIdx >= PART_SIZE) {
      await checkpoint(true);
      nextPart++;
      partStartIdx = records.length;
    } else {
      await checkpoint(false);
    }
  }

  const manifest = {
    date: runDate,
    window,
    candidates: priorCount + candidatesNow.length,
    resumedFrom: priorCount,
    emitted: records.length,
    counts,
    byCode,
    finishedAt: new Date().toISOString(),
  };
  if (!dryRun) {
    await checkpoint(true);
    await putIfChanged(s3, bucket, manifestKey(runDate), JSON.stringify(manifest, null, 1), { contentType: "application/json" });
    const maxSeen = records.map((r) => r.publish).filter(Boolean).sort().at(-1);
    if (maxSeen && (!state.watermark || maxSeen > state.watermark)) state.watermark = maxSeen;
    state.known = [...known].sort();
    state.lastRun = { at: new Date().toISOString(), window, ...counts };
    await saveState(s3, bucket, state);
  }
  return { manifest, records };
}

// --retry-pending: re-attempt detail/docx/text for non-ok records found in the
// last N days' daily files; rewrite those files in place.
export async function retryPending(opts = {}) {
  const { s3, bucket, days = 14, dryRun } = opts;
  s3.dryRun = !!dryRun;
  setMinInterval(opts.rateMs ?? 1100);
  const { nameByCode } = await enumData();
  const today = todayBeijing(opts.tz ?? "Asia/Shanghai");
  const fixed = [];
  if (dryRun) throw new Error("retry-pending has no dry-run mode (it needs the JSONL files to rewrite; use a real run)");
  for (let i = 1; i <= days; i++) {
    const date = addDays(today, -i);
    const [y2, m2] = date.split("-");
    const { contents } = await s3.listObjects(bucket, { prefix: `incremental/${y2}/${m2}/flk-${date}` });
    for (const { key } of contents) {
      if (!/flk-\d{4}-\d{2}-\d{2}(-part\d+)?\.jsonl$/.test(key)) continue;
      const buf = await s3.getObject(bucket, key);
      if (!buf) continue;
      let records;
      try {
        records = buf.toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        continue;
      }
      const targets = records.filter((r) => r.content_status !== "ok");
      if (!targets.length) continue;
      let changed = false;
      for (const rec of targets) {
        const retry = await captureCandidate(
          s3,
          bucket,
          { bbbs: rec.source_id, title: rec.title, gbrq: rec.publish, sxrq: rec.publish_effective, sxx: null, zdjgName: rec.issued_by, flxz: rec.category, flfgCodeId: null },
          nameByCode,
        );
        rec.content = retry.content;
        rec.content_status = retry.content_status;
        rec.file_path = retry.file_path ?? rec.file_path;
        if (retry.error) rec.error = retry.error;
        else delete rec.error;
        changed = true;
        fixed.push({ source_id: rec.source_id, content_status: rec.content_status });
      }
      if (changed && !dryRun) {
        await s3.putObject(bucket, key, records.map((r) => JSON.stringify(r)).join("\n") + "\n", { contentType: "application/x-ndjson" });
      }
    }
  }
  return { fixed };
}
