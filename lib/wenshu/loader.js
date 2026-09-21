// Data-machine loader for wenshu crawl JSONL (spec: register in src_files,
// dict upsert, per-file DELETE→(COPY-equivalent batched INSERT) into judgments,
// month block rebuild; feed-CSV precedence; idempotent re-runs).
// Implementation note: the storage doc words the rule as DELETE→COPY; this
// loader executes the identical semantics (whole-file replace within one
// transaction) via batched INSERT (500 rows/chunk) because node-pg has no
// STDIN COPY without an extra dependency. Documented in design.md.
//
// Live schema (wenshu_db, verified 2026-09-18):
//   src_files(src_id smallint PK — no serial, loader assigns max+1; path UNIQUE;
//             schema='D' for crawl rows too, provenance carried by the raw/ path — design D3)
//   dict_texts("列", ref_key int, txt) PK("列",ref_key) UNIQUE("列",txt);
//             ref_key counters are PER-列 from 1; 法条 multi-article strings stored WHOLE
//   judgments(... doc_id text PK ...) — cross-file duplicate doc_ids resolve
//             first-capture-wins via ON CONFLICT (doc_id) DO NOTHING
import { createHash } from "node:crypto";
import { putIfChanged } from "../s3.js";
import { rebuildMonth, readDocFromBucket } from "../wenshu/blocks.js";

export const DICT_COLUMNS = [
  ["法院", "法院引用"],
  ["案由", "案由引用"],
  ["省", "省引用"],
  ["市", "市引用"],
  ["案件类型", "案件类型引用"],
  ["文书类型", "文书类型引用"],
  ["审理程序", "审理程序引用"],
  ["案例级别", "案例级别引用"],
  ["法院级别", "法院级别引用"],
  ["法条", "法条引用"],
];

const CRAWL_KEY_RE = /^raw\/\d{4}\/\d{2}\/crawl-\d{4}-\d{2}-\d{2}(-w\d+)?\.jsonl$/;
const CHUNK = 500; // INSERT/UPDATE batch size (DELETE→COPY equivalent)
const JUDGMENT_COLS = [
  "doc_id", "id_origin", "案号", "标题",
  "法院引用", "案由引用", "省引用", "市引用", "案件类型引用", "文书类型引用",
  "审理程序引用", "案例级别引用", "法院级别引用", "法条引用",
  "判决时间", "发布时间", "受理时间", "判决年份", "判决结果", "正文形态",
  "block_key", "block_ordinal", "src_id",
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
// double-quote CJK identifiers (pg accepts "案号"-style quoted identifiers)
const qident = (c) => (/^[A-Za-z0-9_]+$/.test(c) ? c : `"${c}"`);

export async function listCrawlFiles(s3, bucket) {
  const files = [];
  let token;
  for (;;) {
    const page = await s3.listObjects(bucket, { prefix: "raw/", continuationToken: token });
    files.push(...page.contents.filter((c) => CRAWL_KEY_RE.test(c.key)).map((c) => c.key));
    if (!page.truncated) break;
    token = page.continuationToken;
  }
  return files.sort();
}

export function monthOfKey(key) {
  const m = key.match(/^raw\/(\d{4})\/(\d{2})\//);
  if (!m) throw new Error(`monthOfKey: not a crawl file key: ${key}`);
  return `${m[1]}-${m[2]}`;
}

// Tolerate a torn tail line (crash mid-PUT): only the LAST non-empty line may
// fail JSON.parse; any earlier malformed line fails loud.
function parseJsonl(buf, key) {
  const lines = buf.toString("utf8").split("\n");
  while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    try {
      rows.push(JSON.parse(lines[i]));
    } catch (err) {
      if (i === lines.length - 1) {
        console.error(`[wenshu-load] ${key}: dropping torn tail line`);
      } else {
        throw new Error(`[wenshu-load] ${key}: malformed JSON line ${i + 1}: ${err.message}`);
      }
    }
  }
  return rows;
}

// dict_texts upsert with a per-run memo: the INSERT..SELECT grabs the next free
// per-列 ref_key under the UNIQUE("列",txt) guard; a lost race (or a
// pre-existing row) falls back to the SELECT. Memo dedupes queries per run.
async function dictRef(pg, memo, col, txt) {
  const mk = `${col}\u0000${txt}`;
  if (memo.has(mk)) return memo.get(mk);
  const ins = await pg.query(
    `INSERT INTO dict_texts ("列", ref_key, txt)
     SELECT $1, coalesce(max(ref_key),0)+1, $2 FROM dict_texts WHERE "列"=$1
     ON CONFLICT ("列",txt) DO NOTHING RETURNING ref_key`,
    [col, txt],
  );
  let ref = ins.rows.length ? ins.rows[0].ref_key : null;
  if (ref == null) {
    const sel = await pg.query(`SELECT ref_key FROM dict_texts WHERE "列"=$1 AND txt=$2`, [col, txt]);
    ref = sel.rows[0]?.ref_key ?? null;
  }
  if (ref == null) throw new Error(`[wenshu-load] dict_texts upsert lost row ("${col}", ${JSON.stringify(txt.slice(0, 64))})`);
  memo.set(mk, ref);
  return ref;
}

async function registerSrcFile(pg, key, year, month) {
  const nextId = (await pg.query("SELECT coalesce(max(src_id),0)+1 AS src_id FROM src_files")).rows[0].src_id;
  const ins = await pg.query(
    `INSERT INTO src_files (src_id, path, schema, year, month) VALUES ($1,$2,'D',$3,$4)
     ON CONFLICT (path) DO NOTHING RETURNING src_id`,
    [nextId, key, year, month],
  );
  if (ins.rows.length) return ins.rows[0].src_id;
  const sel = await pg.query("SELECT src_id FROM src_files WHERE path = $1", [key]);
  const srcId = sel.rows[0]?.src_id;
  if (srcId == null) throw new Error(`[wenshu-load] ${key}: src_files registration lost its row`);
  return srcId;
}

async function processFile({ s3, bucket, pg, key, markerKey, fileBuf, digest, rows, year, month, dictMemo, summary }) {
  const srcId = await registerSrcFile(pg, key, year, month);

  // resolve every distinct dict value first (memo makes each a single query)
  const need = [];
  const seen = new Set();
  for (const r of rows) {
    for (const [col] of DICT_COLUMNS) {
      if (r[col] == null || r[col] === "") continue;
      const txt = String(r[col]);
      const mk = `${col}\u0000${txt}`;
      if (dictMemo.has(mk) || seen.has(mk)) continue;
      seen.add(mk);
      need.push([col, txt]);
    }
  }
  for (const [col, txt] of need) await dictRef(pg, dictMemo, col, txt);
  const refOf = (col, val) => {
    if (val == null || val === "") return null;
    const ref = dictMemo.get(`${col}\u0000${String(val)}`);
    if (ref == null) throw new Error(`[wenshu-load] ${key}: dict ref unresolved for ${col}`);
    return ref;
  };

  // dates stay 'YYYY-MM-DD' strings (pg casts); 法条 whole; blocks set post-rebuild
  const tuples = rows.map((r) => {
    if (!r.docId) throw new Error(`[wenshu-load] ${key}: row without docId`);
    if (r.id_origin == null) throw new Error(`[wenshu-load] ${key}: doc ${r.docId} missing id_origin (NOT NULL)`);
    return [
      r.docId,
      r.id_origin,
      r.案号 ?? null,
      r.标题 ?? null,
      ...DICT_COLUMNS.map(([col]) => refOf(col, r[col])),
      r.判决时间 ?? null,
      r.发布时间 ?? null,
      r.受理时间 ?? null,
      r.判决年份 == null ? null : Number(r.判决年份),
      r.判决结果 ?? null,
      r.qwContent ? "html" : "none",
      null, // block_key — set after the month rebuild
      null, // block_ordinal
      srcId,
    ];
  });

  const colList = JUDGMENT_COLS.map(qident).join(",");
  await pg.query("BEGIN");
  try {
    await pg.query("DELETE FROM judgments WHERE src_id=$1", [srcId]);
    for (let i = 0; i < tuples.length; i += CHUNK) {
      const part = tuples.slice(i, i + CHUNK);
      const params = [];
      const values = part.map((t, j) => {
        const ph = [];
        for (let k = 0; k < JUDGMENT_COLS.length; k++) {
          params.push(t[k]);
          ph.push(`$${j * JUDGMENT_COLS.length + k + 1}`);
        }
        return `(${ph.join(",")})`;
      });
      const res = await pg.query(
        `INSERT INTO judgments (${colList}) VALUES ${values.join(",")} ON CONFLICT (doc_id) DO NOTHING`,
        params,
      );
      const n = typeof res.rowCount === "number" ? res.rowCount : part.length;
      summary.rowsInserted += n;
      summary.rowsSkippedConflict += part.length - n;
    }
    await pg.query("COMMIT");
  } catch (err) {
    await pg.query("ROLLBACK");
    throw err;
  }
  console.error(`[wenshu-load] ${key}: ${rows.length} row(s) -> src_id ${srcId}`);

  // processed marker last: file fully handled (putIfChanged = idempotent upload)
  const w = await putIfChanged(
    s3,
    bucket,
    markerKey,
    JSON.stringify({ file: key, rows: rows.length, sha256: digest, processedAt: new Date().toISOString() }),
    { contentType: "application/json" },
  );
  if (!w.skipped) summary.markersWritten++;
}

export async function load(opts) {
  const { s3, bucket, pg, dryRun = false, verify = true } = opts;
  const summary = {
    filesProcessed: 0,
    rowsInserted: 0,
    rowsSkippedConflict: 0,
    monthsRebuilt: 0,
    blocksWritten: 0,
    verifiedDocs: 0,
    skippedMonths: [],
    markersWritten: 0,
  };

  const files = await listCrawlFiles(s3, bucket);
  const byMonth = new Map();
  for (const key of files) {
    const month = monthOfKey(key);
    if (!byMonth.has(month)) byMonth.set(month, []);
    byMonth.get(month).push(key);
  }

  const dictMemo = new Map();
  for (const month of [...byMonth.keys()].sort()) {
    const [year, mon] = month.split("-").map(Number);

    // feed-CSV precedence: a registered monthly feed owns the whole month
    const feed = await pg.query(
      "SELECT 1 FROM src_files WHERE schema='D' AND year=$1 AND month=$2 AND path NOT LIKE 'raw/%' LIMIT 1",
      [year, mon],
    );
    if (feed.rows.length) {
      console.error(`[wenshu-load] month ${month} skipped: feed CSV registered (precedence)`);
      summary.skippedMonths.push(month);
      continue;
    }

    let touched = false;
    const fileBufs = new Map();
    for (const key of byMonth.get(month)) {
      const markerKey = `raw/processed/${key.replace(/\//g, "_")}.done`;
      const fileBuf = await s3.getObject(bucket, key);
      if (!fileBuf) continue;
      const digest = sha256(fileBuf);
      let marker = null;
      const markerBuf = await s3.getObject(bucket, markerKey);
      if (markerBuf) {
        try {
          marker = JSON.parse(markerBuf.toString("utf8"));
        } catch {
          marker = null;
        }
      }
      if (marker?.sha256 === digest) {
        fileBufs.set(key, fileBuf); // month rebuild still needs this file's content
        continue; // idempotent no-op
      }

      const rows = parseJsonl(fileBuf, key);
      summary.filesProcessed++;
      touched = true;
      fileBufs.set(key, fileBuf);
      if (dryRun) {
        summary.rowsInserted += rows.length;
        continue;
      }
      await processFile({ s3, bucket, pg, key, markerKey, fileBuf, digest, rows, year, month: mon, dictMemo, summary });
    }

    if (!touched || dryRun) continue;

    // month rebuild from ALL crawl files of the month (marker-skipped included)
    const docs = [];
    const monthDocIds = new Set();
    for (const key of byMonth.get(month)) {
      const buf = fileBufs.get(key) ?? (await s3.getObject(bucket, key));
      if (!buf) continue;
      for (const r of parseJsonl(buf, key)) {
        monthDocIds.add(r.docId);
        if (r.qwContent) docs.push({ docId: r.docId, bytes: Buffer.from(r.qwContent, "utf8") });
      }
    }
    // A batch with no text at all (metadata-only crawl) must not delete a month's
    // existing blocks in order to write none.
    if (!docs.length && !verify) {
      console.error(`[wenshu-load] month ${month}: no text in this batch — blocks left as they are`);
      continue;
    }
    const out = await rebuildMonth({ s3, bucket, month, docs });
    summary.monthsRebuilt++;
    summary.blocksWritten += out.blocks.length;

    // only this month's crawl docs get block refs; single batched UPDATE per chunk
    const refs = out.refs.filter((r) => monthDocIds.has(r.docId));
    for (let i = 0; i < refs.length; i += CHUNK) {
      const part = refs.slice(i, i + CHUNK);
      const params = [];
      const values = part.map((r, j) => {
        params.push(r.docId, r.block_key, r.block_ordinal);
        const b = j * 3;
        return `($${b + 1}::text,$${b + 2}::text,$${b + 3}::int)`;
      });
      await pg.query(
        `UPDATE judgments SET block_key = v.block_key, block_ordinal = v.block_ordinal
         FROM (VALUES ${values.join(",")}) AS v(doc_id, block_key, block_ordinal)
         WHERE judgments.doc_id = v.doc_id`,
        params,
      );
    }

    // fail-loud verification: sample ≤3 docs, bytes must round-trip through the block
    if (verify) {
      const byId = new Map(docs.map((d) => [d.docId, d.bytes]));
      for (const ref of refs.slice(0, 3)) {
        const want = byId.get(ref.docId);
        const got = await readDocFromBucket({ s3, bucket, blockKey: ref.block_key, docId: ref.docId });
        if (!want || !got || !got.equals(want)) {
          throw new Error(`[wenshu-load] verify failed: doc ${ref.docId} bytes differ in ${ref.block_key}`);
        }
        summary.verifiedDocs++;
      }
    }
  }
  return summary;
}
