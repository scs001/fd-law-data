// Best-effort run reporting into the platform's central crawl_runs table
// (fd_open_data @ FD_CRAWL_DB_URL). Node port of fd-industry-data writer.py's
// contract, not an import: start_run inserts a `running` row first so
// single-flight guards and cancel checks can see in-flight executions,
// finish_run closes it with the final status plus output/quality, report_run
// stays the one-shot path. Reporting failures are retried briefly, then
// released with a stderr trace — they NEVER raise into the crawl. Without
// FD_CRAWL_DB_URL everything is a silent no-op (one stderr notice).
//
// Identity contract (legal-line-federation D1): the reported source name is
// the CronJob name (e.g. mfa-treaty-crawl), not the law_db library id that
// the bins' --source flags carry (mfa-treaty-library). The mapping lives in
// SOURCE_CRONJOBS below and nowhere else.
import pg from "pg";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

export const KIND = "federation";

// Initial attempt + 2 retries, then release (never into the crawl).
const RETRY_DELAYS_MS = [500, 1000];
const CONNECT_TIMEOUT_MS = 8000;
const STATEMENT_TIMEOUT_MS = 15000;
const ERROR_HEAD_MAX = 200;

// Identity keys: the bins' --source library ids (SOURCE_ADAPTERS keys) plus
// the two standalone pipelines (flk-law, guide-cases) whose bins pass a base
// name instead. Values are the live CronJob names (helm-law-scraw values.yaml
// + APPLY-NOTES live inventory).
export const SOURCE_CRONJOBS = new Map([
  ["rmfyalk-case-library", { crawl: "rmfyalk-case-crawl", load: "rmfyalk-case-load" }],
  ["mfa-treaty-library", { crawl: "mfa-treaty-crawl", load: "mfa-treaty-load" }],
  ["gov-rules-library", { crawl: "gov-rules-crawl", load: "gov-rules-load" }],
  ["party-regulation-library", { crawl: "party-regulation-crawl", load: "party-regulation-load" }],
  ["ccdi-supervisory-regulations", { crawl: "ccdi-supervisory-crawl", load: "ccdi-supervisory-load" }],
  ["flk-law", { crawl: "flk-law-crawl", load: "flk-law-load" }],
  ["guide-cases", { crawl: "guide-cases-crawl", load: "guide-cases-load" }],
]);

export function telemetrySourceName(source, role = "crawl") {
  const entry = SOURCE_CRONJOBS.get(String(source));
  if (!entry) return String(source);
  return entry[role] ?? entry.crawl;
}

export function errorHead(err, max = ERROR_HEAD_MAX) {
  const text = String(err?.message ?? err?.stack ?? err ?? "unknown error");
  return text.slice(0, max);
}

// Mirrors writer.py's DDL battery (once per process; deploy-managed schema
// opts out via FD_SCHEMA_MANAGED=1). The ALTERs self-heal the columns the
// parallel platform migration owns, harmlessly no-opping once it has landed.
const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS crawl_runs (
    id          bigserial PRIMARY KEY,
    source      text NOT NULL,
    kind        text NOT NULL DEFAULT 'runtime',
    status      text NOT NULL,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    rows_written integer NOT NULL DEFAULT 0,
    error_head  text,
    commit_sha  text,
    image_tag   text,
    cancel_requested timestamptz,
    pending_run_id bigint,
    identity_alias text,
    metrics jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS identity_alias text;
ALTER TABLE crawl_runs ADD COLUMN IF NOT EXISTS metrics jsonb;
CREATE INDEX IF NOT EXISTS crawl_runs_source_idx ON crawl_runs (source, created_at DESC);
`;

let cachedImageTag;
function packageVersion() {
  if (cachedImageTag === undefined) {
    try {
      cachedImageTag = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8")).version ?? null;
    } catch {
      cachedImageTag = null;
    }
  }
  return cachedImageTag;
}

function defaultImageTag() {
  return process.env.FD_RUNNER_IMAGE_TAG ?? packageVersion() ?? null;
}

function defaultCommitSha() {
  return process.env.FD_COMMIT_SHA ?? null;
}

// The dispatcher injects FD_PENDING_RUN_ID (numeric) into triggered Jobs;
// cancel association keys on crawl_runs.pending_run_id. Invalid values are
// ignored (null), never an error.
function defaultPendingRunId() {
  const raw = process.env.FD_PENDING_RUN_ID;
  if (raw == null || raw === "") return null;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

function defaultClientFactory(url) {
  const client = new pg.Client({
    connectionString: String(url).replace("postgresql+psycopg2://", "postgresql://"),
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: STATEMENT_TIMEOUT_MS,
  });
  return {
    connect: () => client.connect(),
    query: (sql, params) => client.query(sql, params),
    end: () => client.end(),
  };
}

const rowsWrittenOrDefault = (rowsWritten) => {
  const n = Number(rowsWritten ?? 0);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
};

/**
 * Creates a telemetry handle. All methods are failure-safe: they retry on
 * connection/query errors, then give up with a stderr trace and return
 * null/false instead of throwing. `url`, `clientFactory`, `stderr`, `sleep`,
 * `imageTag` and `commitSha` are injectable for tests (fakes never touch PG).
 */
export function createTelemetry({
  url = null,
  clientFactory = defaultClientFactory,
  stderr = (line) => console.error(line),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  imageTag = null,
  commitSha = null,
  retryDelaysMs = RETRY_DELAYS_MS,
} = {}) {
  let schemaReady = false;
  let noEnvNoticed = false;

  const resolveUrl = () => url ?? process.env.FD_CRAWL_DB_URL ?? "";
  const noticeNoEnv = () => {
    if (!noEnvNoticed) {
      noEnvNoticed = true;
      stderr("[telemetry] FD_CRAWL_DB_URL not set; run reporting disabled (no-op)");
    }
  };

  async function ensureSchemaOnce(query) {
    if (schemaReady) return;
    if (process.env.FD_SCHEMA_MANAGED === "1") {
      schemaReady = true;
      return;
    }
    await query(SCHEMA_SQL);
    schemaReady = true;
  }

  function metricsToJson(metrics) {
    if (metrics == null) return null;
    try {
      const json = JSON.stringify(metrics);
      return json === undefined ? null : json;
    } catch (err) {
      stderr(`[telemetry] metrics dropped (not serializable): ${errorHead(err)}`);
      return null;
    }
  }

  // One attempt loop shared by all three entrypoints. `body(client)` runs the
  // statements and returns the method's success value; `disabledValue` is what
  // a missing FD_CRAWL_DB_URL resolves to (null for start ids, false for the
  // boolean entrypoints).
  async function withRetries(label, body, disabledValue = null) {
    if (!resolveUrl()) {
      noticeNoEnv();
      return disabledValue;
    }
    let lastErr;
    for (let attempt = 0; attempt <= retryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(retryDelaysMs[attempt - 1]);
      let client;
      try {
        client = await clientFactory(resolveUrl());
        await client.connect();
        const value = await body(client);
        await client.end();
        return value;
      } catch (err) {
        lastErr = err;
        stderr(`[telemetry] ${label} attempt ${attempt + 1}/${retryDelaysMs.length + 1} failed: ${errorHead(err)}`);
        if (client) {
          try { await client.end(); } catch { /* socket already gone */ }
        }
      }
    }
    stderr(`[telemetry] ${label} released after ${retryDelaysMs.length + 1} attempt(s) (crawl/load result unaffected): ${errorHead(lastErr)}`);
    return disabledValue;
  }

  return {
    /**
     * Inserts a `running` row; returns its id, or null when disabled/failed.
     * pendingRunId defaults from the dispatcher-injected FD_PENDING_RUN_ID
     * env (parsed as int, invalid values ignored); an explicit argument wins.
     */
    startRun({ source, kind = KIND, imageTag: tagOverride, commitSha: shaOverride, pendingRunId = defaultPendingRunId(), identityAlias = null } = {}) {
      if (!source) {
        stderr("[telemetry] startRun called without source; skipped");
        return Promise.resolve(null);
      }
      const tag = tagOverride ?? imageTag ?? defaultImageTag();
      const resolvedSha = shaOverride ?? commitSha ?? defaultCommitSha();
      return withRetries(`start_run(${source})`, async (client) => {
        await ensureSchemaOnce(client.query.bind(client));
        const { rows } = await client.query(
          `INSERT INTO crawl_runs
             (source, kind, status, started_at, commit_sha, image_tag, pending_run_id, identity_alias)
           VALUES ($1, $2, 'running', now(), $3, $4, $5, $6)
           RETURNING id`,
          [String(source), kind, resolvedSha, tag, pendingRunId, identityAlias],
        );
        return Number(rows[0].id);
      });
    },

    /** Closes a running row with its final status, output count and metrics. */
    finishRun(runId, { status = "success", rowsWritten = 0, errorHead: head = null, metrics = null } = {}) {
      if (runId == null) {
        if (!resolveUrl()) noticeNoEnv();
        return Promise.resolve(false);
      }
      return withRetries(`finish_run(${runId})`, async (client) => {
        await client.query(
          `UPDATE crawl_runs
           SET status = $1, finished_at = now(), rows_written = $2, error_head = $3, metrics = $4::jsonb
           WHERE id = $5`,
          [String(status), rowsWrittenOrDefault(rowsWritten), head == null ? null : String(head).slice(0, 1000), metricsToJson(metrics), Number(runId)],
        );
        return true;
      }, false);
    },

    /** One-shot insert for helpers that only report after the fact. */
    reportRun({
      source,
      kind = KIND,
      status = "success",
      startedAt = new Date(),
      finishedAt = null,
      rowsWritten = 0,
      errorHead: head = null,
      commitSha: shaOverride,
      imageTag: tagOverride,
      metrics = null,
    } = {}) {
      if (!source) {
        stderr("[telemetry] reportRun called without source; skipped");
        return Promise.resolve(false);
      }
      const tag = tagOverride ?? imageTag ?? defaultImageTag();
      const resolvedSha = shaOverride ?? commitSha ?? defaultCommitSha();
      return withRetries(`report_run(${source})`, async (client) => {
        await ensureSchemaOnce(client.query.bind(client));
        const { rows } = await client.query(
          `INSERT INTO crawl_runs
             (source, kind, status, started_at, finished_at, rows_written, error_head, commit_sha, image_tag, metrics)
           VALUES ($1, $2, $3, $4, COALESCE($5, now()), $6, $7, $8, $9, $10::jsonb)
           RETURNING id`,
          [
            String(source),
            kind,
            String(status),
            startedAt instanceof Date || typeof startedAt === "string" ? startedAt : new Date(),
            finishedAt instanceof Date || typeof finishedAt === "string" ? finishedAt : null,
            rowsWrittenOrDefault(rowsWritten),
            head == null ? null : String(head).slice(0, 1000),
            resolvedSha,
            tag,
            metricsToJson(metrics),
          ],
        );
        return Number(rows[0].id);
      }, false);
    },
  };
}

// Process-wide default handle: env-driven, lazy per call (FD_CRAWL_DB_URL may
// be injected by the chart at any point before the process starts).
const defaultTelemetry = createTelemetry({});

export const startRun = (options) => defaultTelemetry.startRun(options);
export const finishRun = (runId, options) => defaultTelemetry.finishRun(runId, options);
export const reportRun = (options) => defaultTelemetry.reportRun(options);
