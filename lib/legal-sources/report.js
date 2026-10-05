// Daily legal-sources report. Joins the object-storage run audit (coverage
// manifests + incremental state.json) with read-only aggregates from
// law_db.legal_documents, judges per-source freshness and persists a dated
// JSON series to legal-sources/report/ so gaps in the series expose report
// outages (spec: 报告自身断流靠日期序列缺口发现).
//
// Staleness caliber: stale only when no successful-run evidence is within the
// 48h green line. A clean run that emitted zero new records still checkpoints
// state.json (runtime.js always saveState()s, but writes a manifest only when
// parts exist), so zero-new keeps freshness green — 零新增不是断流.
import { readSourceManifests, summarizeManifests } from "./coverage.js";
import { stateKey } from "./storage.js";

export const STALE_AFTER_HOURS = 48;
export const STALE_REASON_NO_SUCCESSFUL_RUN = "no_successful_run_48h";

// The report cron fires 06:00 Asia/Shanghai = 22:00Z the previous day, so the
// series date must come from the Shanghai wall clock, not from UTC.
export function shanghaiDateStr(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

export function reportKey(dateStr) {
  return `legal-sources/report/report-${dateStr}.json`;
}

// One-shot staleness verdict. freshnessAt=null means no run evidence at all
// (source never ran, or nothing observable inside the window) -> stale.
// Row counts never enter this verdict: new_today=0 alone is healthy.
export function staleness({ now, freshnessAt, maxAgeHours = STALE_AFTER_HOURS }) {
  if (!freshnessAt) return { stale: true, stale_reason: STALE_REASON_NO_SUCCESSFUL_RUN };
  const ageMs = now.getTime() - new Date(freshnessAt).getTime();
  const stale = Number.isFinite(ageMs) && ageMs > maxAgeHours * 3600 * 1000;
  return { stale, stale_reason: stale ? STALE_REASON_NO_SUCCESSFUL_RUN : null };
}

export function freshnessHours({ now, freshnessAt }) {
  if (!freshnessAt) return null;
  const ageMs = now.getTime() - new Date(freshnessAt).getTime();
  if (!Number.isFinite(ageMs)) return null;
  return Math.round((ageMs / 3600000) * 10) / 10;
}

// Latest manifest finishedAt whose run completed without abort/unreachable
// pages — the report-side "上次成功运行时间". Manifests only exist for runs
// that emitted records; zero-new runs leave their trace in state.updatedAt.
export function lastSuccessfulRunAt(manifests) {
  let latest = null;
  for (const manifest of manifests) {
    const at = manifest?.finishedAt;
    if (!at || manifest?.coverage?.complete !== true) continue;
    if (!latest || new Date(at).getTime() > new Date(latest).getTime()) latest = at;
  }
  return latest;
}

function maxTimestamp(values) {
  const parsed = values.filter(Boolean).map((value) => new Date(value).getTime()).filter(Number.isFinite);
  return parsed.length ? new Date(Math.max(...parsed)).toISOString() : null;
}

async function readStateUpdatedAt(s3, bucket, source) {
  const buf = await s3.getObject(bucket, stateKey(source));
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8"))?.updatedAt ?? null;
  } catch {
    // A corrupt state file says nothing about freshness; treat as no evidence.
    return null;
  }
}

// Effective-body caliber: content with all whitespace stripped must reach 50
// chars, otherwise the row counts as having no effective body. Single
// read-only aggregate per source; null content counts as no body.
const SOURCE_STATS_SQL = `SELECT
  count(*)::bigint AS total_rows,
  max(fetched_at) AS last_fetched_at,
  count(*) FILTER (WHERE fetched_at >= date_trunc('day', now() AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'Asia/Shanghai')::bigint AS new_today,
  count(*) FILTER (WHERE fetched_at >= now() - interval '7 days')::bigint AS new_7d,
  count(*) FILTER (WHERE length(regexp_replace(COALESCE(content, ''), '\\s+', '', 'g')) >= 50)::bigint AS effective_body_rows
FROM legal_documents
WHERE source = $1`;

export async function sourceDbStats(client, source) {
  const { rows } = await client.query(SOURCE_STATS_SQL, [source]);
  const row = rows[0] ?? {};
  const total = Number(row.total_rows ?? 0);
  const effective = Number(row.effective_body_rows ?? 0);
  return {
    total_rows: total,
    last_fetched_at: row.last_fetched_at ? new Date(row.last_fetched_at).toISOString() : null,
    new_today: Number(row.new_today ?? 0),
    new_7d: Number(row.new_7d ?? 0),
    effective_body_rows: effective,
    effective_body_ratio: total ? Math.round((effective / total) * 10000) / 10000 : 0,
  };
}

/**
 * Builds the full report for every source: object-storage coverage summary,
 * DB stats, freshness verdict. Same-day reruns overwrite the same series file
 * (idempotent by date key).
 *
 * @param {object} params
 * @param {object} params.s3 legal-sources s3 client (lib/s3.js)
 * @param {string} params.bucket laws bucket
 * @param {string[]} params.sources source ids (SOURCE_ADAPTERS keys)
 * @param {object} params.pgClient connected pg client (read-only usage)
 * @param {Date} [params.now] injectable clock (tests)
 * @param {number} [params.maxAgeHours] freshness green line in hours
 */
export async function buildLegalSourcesReport({
  s3,
  bucket,
  sources,
  pgClient,
  now = new Date(),
  maxAgeHours = STALE_AFTER_HOURS,
}) {
  const out = {
    date: shanghaiDateStr(now),
    generatedAt: now.toISOString(),
    bucket,
    sources: {},
    stale_sources: [],
  };
  for (const source of sources) {
    const manifests = await readSourceManifests(s3, bucket, source);
    const coverage = summarizeManifests(manifests);
    coverage.state_updated_at = await readStateUpdatedAt(s3, bucket, source);
    const db = await sourceDbStats(pgClient, source);
    const runAt = lastSuccessfulRunAt(manifests);
    // Success evidence in priority order: complete-run manifest, liveness
    // checkpoint (covers zero-new runs), latest loaded row (covers pruned
    // manifests). The newest of the three is the freshness anchor.
    const freshnessAt = maxTimestamp([runAt, coverage.state_updated_at, db.last_fetched_at]);
    const { stale, stale_reason } = staleness({ now, freshnessAt, maxAgeHours });
    out.sources[source] = {
      coverage,
      db,
      last_successful_run_at: runAt,
      freshness_at: freshnessAt,
      freshness_hours: freshnessHours({ now, freshnessAt }),
      stale,
      stale_reason,
    };
    if (stale) out.stale_sources.push(source);
  }
  // Same gap list as coverage.js: latest run missing or not complete.
  out.incomplete = Object.entries(out.sources)
    .filter(([, entry]) => !entry.coverage.latest || entry.coverage.latest.complete !== true)
    .map(([source]) => source);
  return out;
}

export async function persistReport(s3, bucket, report) {
  return s3.putObject(bucket, reportKey(report.date), JSON.stringify(report, null, 1), {
    contentType: "application/json",
  });
}
