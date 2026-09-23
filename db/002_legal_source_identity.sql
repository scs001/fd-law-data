-- Auth Broker identity pool. One row per upstream account per legal source.
-- Credentials never live here: this table binds an identity to encrypted
-- session references, isolated browser storage, and proxy identities.
CREATE TABLE IF NOT EXISTS legal_source_identity (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS legal_source_identity_source_account_uniq
  ON legal_source_identity (source, account_id);

CREATE INDEX IF NOT EXISTS legal_source_identity_status_idx
  ON legal_source_identity (status);

CREATE INDEX IF NOT EXISTS legal_source_identity_lease_expiry_idx
  ON legal_source_identity (lease_expires_at)
  WHERE lease_token IS NOT NULL;

-- Append-only lifecycle audit. It intentionally carries outcomes and proxy ids
-- only: tokens, cookies, names and national identifiers are forbidden here.
CREATE TABLE IF NOT EXISTS legal_source_identity_event (
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
);

CREATE INDEX IF NOT EXISTS legal_source_identity_event_identity_time_idx
  ON legal_source_identity_event (identity_id, occurred_at DESC);
