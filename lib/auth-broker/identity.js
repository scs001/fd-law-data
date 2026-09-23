// Identity pool and lease state machine for the legal Auth Broker. This module
// owns all SQL for legal_source_identity; it never receives or stores account
// credentials, tokens, cookies or personal identity values.
import crypto from "node:crypto";

export const IDENTITY_STATUSES = new Set([
  "login_required",
  "active",
  "cooldown",
  "banned",
  "retired",
]);

export const SESSION_MODES = new Set([
  "session_jar",
  "browser_session_host",
  "proxy_bound_relay",
]);

export const LEASE_ELIGIBLE_STATUSES = new Set(["active"]);

export const DDL_FILE = "db/002_legal_source_identity.sql";

export const IDENTITY_DDL = [
  `CREATE TABLE IF NOT EXISTS legal_source_identity (
     id                    bigserial PRIMARY KEY,
     source                text        NOT NULL,
     account_id            text        NOT NULL,
     status                text        NOT NULL DEFAULT 'login_required',
     mode                  text        NOT NULL DEFAULT 'session_jar',
     login_proxy_id        text,
     crawl_proxy_id        text,
     browser_profile_ref   text        NOT NULL,
     session_ref           text,
     lease_owner           text,
     lease_token           text,
     lease_expires_at      timestamptz,
     concurrency_limit     integer     NOT NULL DEFAULT 1 CHECK (concurrency_limit > 0),
     crawl_proxy_probe_at  timestamptz,
     crawl_proxy_result    jsonb       NOT NULL DEFAULT '{}'::jsonb,
     small_batch_at        timestamptz,
     small_batch_result    jsonb       NOT NULL DEFAULT '{}'::jsonb,
     user_agent            text,
     viewport              jsonb       NOT NULL DEFAULT '{}'::jsonb,
     locale                text        NOT NULL DEFAULT 'zh-CN',
     timezone              text        NOT NULL DEFAULT 'Asia/Shanghai',
     last_login_at         timestamptz,
     last_probe_at         timestamptz,
     last_success_at       timestamptz,
     failure_count         integer     NOT NULL DEFAULT 0,
     created_at            timestamptz NOT NULL DEFAULT now(),
     updated_at            timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT legal_source_identity_status_check CHECK (
       status IN ('login_required', 'active', 'cooldown', 'banned', 'retired')
     ),
     CONSTRAINT legal_source_identity_mode_check CHECK (
       mode IN ('session_jar', 'browser_session_host', 'proxy_bound_relay')
     )
   )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS legal_source_identity_source_account_uniq
     ON legal_source_identity (source, account_id)`,
  `CREATE INDEX IF NOT EXISTS legal_source_identity_status_idx
     ON legal_source_identity (status)`,
  `CREATE INDEX IF NOT EXISTS legal_source_identity_lease_expiry_idx
     ON legal_source_identity (lease_expires_at) WHERE lease_token IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS legal_source_identity_event (
     id            bigserial PRIMARY KEY,
     identity_id   bigint      NOT NULL REFERENCES legal_source_identity(id) ON DELETE CASCADE,
     event_kind    text        NOT NULL,
     outcome       text        NOT NULL,
     actor         text,
     lease_token   text,
     proxy_id      text,
     reason        text,
     metadata      jsonb       NOT NULL DEFAULT '{}'::jsonb,
     occurred_at   timestamptz NOT NULL DEFAULT now(),
     CONSTRAINT legal_source_identity_event_kind_check CHECK (
       event_kind IN (
         'identity_created', 'identity_updated', 'login', 'session_created',
         'probe', 'small_batch', 'lease_acquired', 'lease_released',
         'lease_expired', 'failure', 'identity_retired'
       )
     )
   )`,
  `CREATE INDEX IF NOT EXISTS legal_source_identity_event_identity_time_idx
     ON legal_source_identity_event (identity_id, occurred_at DESC)`,
];

export async function ensureLegalIdentitySchema(client) {
  for (const statement of IDENTITY_DDL) await client.query(statement);
}

export function browserProfileRef({ source, accountId }) {
  if (!source || !accountId) throw new Error("browser profile requires source and account_id");
  return `legal-auth/${encodeURIComponent(source)}/${encodeURIComponent(accountId)}`;
}

function requiredIdentityFields(input) {
  const source = String(input?.source ?? "").trim();
  const accountId = String(input?.account_id ?? "").trim();
  if (!source) throw new Error("identity source is required");
  if (!accountId) throw new Error("identity account_id is required");
  return { source, accountId };
}

// Different login/crawl proxies are represented, but deliberately disabled
// until both probes and a small batch have been recorded by probe code.
export function normalizeIdentityInput(input = {}) {
  const { source, accountId } = requiredIdentityFields(input);
  const mode = input.mode ?? "session_jar";
  const loginProxyId = input.login_proxy_id ?? null;
  const crawlProxyId = input.crawl_proxy_id ?? loginProxyId;
  const status = input.status ?? "login_required";
  if (!IDENTITY_STATUSES.has(status)) throw new Error(`invalid identity status: ${status}`);
  if (!SESSION_MODES.has(mode)) throw new Error(`invalid session mode: ${mode}`);
  const crossProxy = Boolean(loginProxyId && crawlProxyId && loginProxyId !== crawlProxyId);
  return {
    source,
    account_id: accountId,
    status,
    mode,
    login_proxy_id: loginProxyId,
    crawl_proxy_id: crawlProxyId,
    browser_profile_ref: input.browser_profile_ref ?? browserProfileRef({ source, accountId }),
    session_ref: input.session_ref ?? null,
    user_agent: input.user_agent ?? null,
    viewport: input.viewport && typeof input.viewport === "object" ? input.viewport : {},
    locale: input.locale ?? "zh-CN",
    timezone: input.timezone ?? "Asia/Shanghai",
    concurrency_limit: Number(input.concurrency_limit ?? 1),
    crawl_proxy_probe_at: input.crawl_proxy_probe_at ?? null,
    crawl_proxy_result: input.crawl_proxy_result ?? {},
    small_batch_at: input.small_batch_at ?? null,
    small_batch_result: input.small_batch_result ?? {},
    cross_proxy: crossProxy,
    cross_proxy_allowed: !crossProxy || (
      Boolean(input.crawl_proxy_probe_at) && Boolean(input.small_batch_at)
    ),
  };
}

export async function upsertIdentity(client, input, { actor = "auth-broker" } = {}) {
  const row = normalizeIdentityInput(input);
  if (row.concurrency_limit <= 0 || !Number.isFinite(row.concurrency_limit)) {
    throw new Error("concurrency_limit must be positive");
  }
  await client.query("BEGIN");
  try {
    const existing = await client.query(
      "SELECT * FROM legal_source_identity WHERE source=$1 AND account_id=$2 FOR UPDATE",
      [row.source, row.account_id],
    );
    const result = existing.rows[0]
      ? await client.query(
          `UPDATE legal_source_identity SET
             status=$3, mode=$4, login_proxy_id=$5, crawl_proxy_id=$6,
             browser_profile_ref=$7, session_ref=COALESCE($8, session_ref),
             crawl_proxy_probe_at=COALESCE($9, crawl_proxy_probe_at),
             crawl_proxy_result=$10,
             small_batch_at=COALESCE($11, small_batch_at),
             small_batch_result=$12,
             user_agent=COALESCE($13, user_agent), viewport=$14,
             locale=$15, timezone=$16, concurrency_limit=$17, updated_at=now()
           WHERE id=$18
           RETURNING *`,
          [
            row.status, row.mode, row.login_proxy_id, row.crawl_proxy_id,
            row.browser_profile_ref, row.session_ref,
            row.crawl_proxy_probe_at, JSON.stringify(row.crawl_proxy_result),
            row.small_batch_at, JSON.stringify(row.small_batch_result),
            row.user_agent, JSON.stringify(row.viewport), row.locale,
            row.timezone, row.concurrency_limit, existing.rows[0].id,
          ],
        )
      : await client.query(
          `INSERT INTO legal_source_identity
             (source, account_id, status, mode, login_proxy_id, crawl_proxy_id,
              browser_profile_ref, session_ref, crawl_proxy_probe_at,
              crawl_proxy_result, small_batch_at, small_batch_result,
              user_agent, viewport, locale, timezone, concurrency_limit)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
           RETURNING *`,
          [
            row.source, row.account_id, row.status, row.mode,
            row.login_proxy_id, row.crawl_proxy_id, row.browser_profile_ref,
            row.session_ref, row.crawl_proxy_probe_at,
            JSON.stringify(row.crawl_proxy_result), row.small_batch_at,
            JSON.stringify(row.small_batch_result), row.user_agent,
            JSON.stringify(row.viewport), row.locale, row.timezone,
            row.concurrency_limit,
          ],
        );
    const identity = result.rows[0];
    await client.query(
      `INSERT INTO legal_source_identity_event
         (identity_id, event_kind, outcome, actor, reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        identity.id,
        existing.rows[0] ? "identity_updated" : "identity_created",
        "ok",
        actor,
        row.cross_proxy && !row.cross_proxy_allowed
          ? "cross-proxy recorded but not enabled"
          : null,
        JSON.stringify({ source: row.source, account_id: row.account_id, mode: row.mode }),
      ],
    );
    await client.query("COMMIT");
    return { identity, created: !existing.rows[0], crossProxyAllowed: row.cross_proxy_allowed };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

function leaseToken() {
  return crypto.randomUUID().replace(/-/g, "");
}

export async function acquireIdentityLease(client, { source, accountId, owner, ttlMs = 30 * 60 * 1000 }) {
  if (!owner) throw new Error("lease owner is required");
  await client.query("BEGIN");
  try {
    const found = await client.query(
      "SELECT * FROM legal_source_identity WHERE source=$1 AND account_id=$2 FOR UPDATE",
      [source, accountId],
    );
    const identity = found.rows[0];
    if (!identity) {
      await client.query("ROLLBACK");
      const err = new Error(`identity not found: ${source}/${accountId}`);
      err.code = "IDENTITY_NOT_FOUND";
      throw err;
    }
    const expired = identity.lease_expires_at && new Date(identity.lease_expires_at) <= new Date();
    if (identity.lease_token && !expired) {
      await client.query("ROLLBACK");
      const err = new Error(`identity is already leased: ${source}/${accountId}`);
      err.code = "IDENTITY_LEASED";
      throw err;
    }
    if (expired) {
      await client.query(
        `INSERT INTO legal_source_identity_event
           (identity_id,event_kind,outcome,actor,reason) VALUES ($1,'lease_expired','ok',$2,'expired before acquire')`,
        [identity.id, owner],
      );
    }
    if (!LEASE_ELIGIBLE_STATUSES.has(identity.status)) {
      await client.query("ROLLBACK");
      const err = new Error(`identity is not eligible for lease (${identity.status}): ${source}/${accountId}`);
      err.code = "IDENTITY_NOT_ELIGIBLE";
      err.status = identity.status;
      throw err;
    }
    const token = leaseToken();
    const updated = await client.query(
      `UPDATE legal_source_identity
          SET lease_owner=$3, lease_token=$4,
              lease_expires_at=now() + make_interval(secs => $5)
        WHERE id=$1 AND source=$2
        RETURNING *`,
      [identity.id, source, owner, token, Math.max(1, Math.floor(ttlMs / 1000))],
    );
    await client.query(
      `INSERT INTO legal_source_identity_event
         (identity_id,event_kind,outcome,actor,lease_token,metadata)
       VALUES ($1,'lease_acquired','ok',$2,$3,$4)`,
      [identity.id, owner, token, JSON.stringify({ ttl_ms: ttlMs })],
    );
    await client.query("COMMIT");
    return { lease: { token, owner, expires_at: updated.rows[0].lease_expires_at }, identity: updated.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

export async function releaseIdentityLease(client, { source, accountId, token, outcome = "ok", reason = null, failure = false }) {
  await client.query("BEGIN");
  try {
    const found = await client.query(
      "SELECT * FROM legal_source_identity WHERE source=$1 AND account_id=$2 FOR UPDATE",
      [source, accountId],
    );
    const identity = found.rows[0];
    if (!identity || identity.lease_token !== token) {
      await client.query("ROLLBACK");
      const err = new Error(`lease does not match identity: ${source}/${accountId}`);
      err.code = "LEASE_MISMATCH";
      throw err;
    }
    const nextStatus = failure
      ? (identity.status === "active" ? "cooldown" : identity.status)
      : identity.status;
    const updated = await client.query(
      `UPDATE legal_source_identity
          SET lease_owner=NULL, lease_token=NULL, lease_expires_at=NULL,
              status=$3,
              failure_count=failure_count + $4,
              last_success_at=CASE WHEN $5 THEN now() ELSE last_success_at END,
              updated_at=now()
        WHERE id=$1
        RETURNING *`,
      [identity.id, source, nextStatus, failure ? 1 : 0, !failure],
    );
    await client.query(
      `INSERT INTO legal_source_identity_event
         (identity_id,event_kind,outcome,actor,lease_token,reason,metadata)
       VALUES ($1,'lease_released',$2,$3,$4,$5,$6)`,
      [identity.id, outcome, identity.lease_owner, token, reason,
       JSON.stringify({ failure, status: nextStatus })],
    );
    await client.query("COMMIT");
    return updated.rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  }
}

export async function recordIdentityFailure(client, { source, accountId, reason, status = "cooldown" }) {
  const updated = await client.query(
    `UPDATE legal_source_identity
        SET status=$3, failure_count=failure_count+1, lease_owner=NULL,
            lease_token=NULL, lease_expires_at=NULL, updated_at=now()
      WHERE source=$1 AND account_id=$2
      RETURNING *`,
    [source, accountId, status],
  );
  if (!updated.rows[0]) return null;
  await client.query(
    `INSERT INTO legal_source_identity_event
       (identity_id,event_kind,outcome,actor,reason,metadata)
     VALUES ($1,'failure','failed','auth-broker',$2,$3)`,
    [updated.rows[0].id, reason, JSON.stringify({ status })],
  );
  return updated.rows[0];
}
