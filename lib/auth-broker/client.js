// Crawler-side Auth Broker client. It acquires an exclusive identity lease,
// decrypts only the session it owns, probes before crawling, selects the
// consumption mode, and always releases/marks the identity on exit.
import { authHeadersFromSessionJar, decryptSessionJar, SessionJarError } from "./session-jar.js";
import { probeSession, selectSessionMode } from "./proxy.js";

export class AuthBrokerClientError extends Error {
  constructor(code, message, { statusCode = null, identityStatus = null } = {}) {
    super(message);
    this.name = "AuthBrokerClientError";
    this.code = code;
    this.statusCode = statusCode;
    this.identityStatus = identityStatus;
  }
}

async function requestJson(url, { method = "GET", token, body, signal, fetchImpl = globalThis.fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(url, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (err) {
    throw new AuthBrokerClientError("BROKER_UNREACHABLE", `Auth Broker request failed: ${err.message}`);
  }
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = { error: text.slice(0, 200) };
  }
  if (!response.ok) {
    throw new AuthBrokerClientError(payload.code ?? "BROKER_HTTP_ERROR", payload.error ?? `HTTP ${response.status}`, {
      statusCode: response.status,
      identityStatus: payload.status ?? null,
    });
  }
  return payload;
}

/**
 * Acquire a lease and, for session_jar mode, decrypt the issued session.
 * `jarKey` is supplied by Secret/env and is never logged or persisted.
 */
export async function acquireCrawlerIdentity({
  brokerUrl,
  brokerToken,
  source,
  accountId,
  owner,
  ttlMs = 30 * 60 * 1000,
  jarKey = process.env.LEGAL_AUTH_JAR_KEY,
  includeSession = true,
  brokerFetch = globalThis.fetch,
} = {}) {
  if (!brokerUrl) throw new AuthBrokerClientError("NO_BROKER", "Auth Broker URL is required");
  if (!accountId) throw new AuthBrokerClientError("NO_ACCOUNT", "Auth Broker account_id is required");
  const response = await requestJson(new URL("/lease/acquire", brokerUrl).toString(), {
    method: "POST",
    token: brokerToken,
    body: { source, account_id: accountId, owner, ttl_ms: ttlMs, include_session: includeSession },
    fetchImpl: brokerFetch,
  });
  const jar = response.session_jar
    ? decryptSessionJar(response.session_jar, jarKey)
    : null;
  return {
    lease: response.lease,
    identity: response.identity,
    session: jar,
  };
}

export async function releaseCrawlerIdentity({ brokerUrl, brokerToken, source, accountId, leaseToken, failure = false, outcome = "ok", reason = null, brokerFetch = globalThis.fetch }) {
  return requestJson(new URL("/lease/release", brokerUrl).toString(), {
    method: "POST",
    token: brokerToken,
    body: {
      source,
      account_id: accountId,
      lease_token: leaseToken,
      failure,
      outcome,
      reason,
    },
    fetchImpl: brokerFetch,
  });
}

export async function markCrawlerIdentityFailure({ brokerUrl, brokerToken, source, accountId, reason, status = "login_required", brokerFetch = globalThis.fetch }) {
  return requestJson(new URL("/failure", brokerUrl).toString(), {
    method: "POST",
    token: brokerToken,
    body: { source, account_id: accountId, reason, status },
    fetchImpl: brokerFetch,
  });
}

export function assertSessionMatchesIdentity({ session, identity }) {
  if (session.source !== identity.source) {
    throw new AuthBrokerClientError("SESSION_SOURCE_MISMATCH", "leased session belongs to another source");
  }
  if (session.account_id !== identity.account_id) {
    throw new AuthBrokerClientError("SESSION_ACCOUNT_MISMATCH", "leased session belongs to another account");
  }
  const login = session.proxy?.login_proxy_id;
  const crawl = session.proxy?.crawl_proxy_id;
  if (identity.login_proxy_id && login !== identity.login_proxy_id) {
    throw new AuthBrokerClientError("SESSION_PROXY_MISMATCH", "session login proxy does not match leased identity");
  }
  if (identity.crawl_proxy_id && crawl !== identity.crawl_proxy_id) {
    throw new AuthBrokerClientError("SESSION_PROXY_MISMATCH", "session crawl proxy does not match leased identity");
  }
}

/**
 * Run `work` while holding an identity lease.
 * `work({headers, session, identity, mode})` must not retry auth failures.
 * A 401/403 from source HTTP should be thrown as an Error with `status`.
 */
export async function withCrawlerIdentity({
  brokerUrl,
  brokerToken,
  source,
  accountId,
  owner,
  ttlMs,
  jarKey,
  crawlProxyUrl,
  fetchImpl = globalThis.fetch,
  brokerFetch = fetchImpl,
  work,
  log = () => {},
} = {}) {
  const acquired = await acquireCrawlerIdentity({
    brokerUrl, brokerToken, source, accountId, owner, ttlMs, jarKey,
    brokerFetch,
  });
  const { lease, identity, session } = acquired;
  let released = false;
  const release = async ({ failure = false, outcome = "ok", reason = null } = {}) => {
    if (released) return null;
    released = true;
    return releaseCrawlerIdentity({
      brokerUrl, brokerToken, source, accountId,
      leaseToken: lease.token, failure, outcome, reason,
      brokerFetch,
    });
  };
  try {
    if (!session && identity.mode === "session_jar") {
      throw new AuthBrokerClientError("SESSION_NOT_ISSUED", "identity required a session jar but broker issued none");
    }
    if (session) assertSessionMatchesIdentity({ session, identity });

    // Both probes must be run when binding is cross-proxy. For the default
    // same-proxy binding, one crawl-purpose probe proves the identity.
    const sameProxy = identity.login_proxy_id === identity.crawl_proxy_id;
    const loginProbe = sameProxy && session
      ? await probeSession(session, { purpose: "crawl", proxyId: identity.crawl_proxy_id, fetchImpl })
      : session
        ? await probeSession(session, { purpose: "login", proxyId: identity.login_proxy_id, fetchImpl })
        : { ok: true, kind: "not_applicable" };
    const crawlProbe = sameProxy
      ? loginProbe
      : session
        ? await probeSession(session, { purpose: "crawl", proxyId: identity.crawl_proxy_id, fetchImpl })
        : { ok: true, kind: "not_applicable" };
    if (!loginProbe.ok || !crawlProbe.ok) {
      const failed = !loginProbe.ok ? loginProbe : crawlProbe;
      await release({ failure: true, outcome: "probe_failed", reason: failed.reason });
      await markCrawlerIdentityFailure({
        brokerUrl, brokerToken, source, accountId,
        reason: failed.reason,
        status: failed.kind === "banned" ? "banned" : "login_required",
        brokerFetch,
      });
      throw new AuthBrokerClientError("SESSION_PROBE_FAILED", `session probe failed: ${failed.reason}`, {
        identityStatus: failed.kind,
      });
    }

    const decision = selectSessionMode(identity, { loginProbe, crawlProbe });
    if (!decision.allowed) {
      await release({ failure: true, outcome: "mode_unavailable", reason: decision.reason });
      throw new AuthBrokerClientError("SESSION_MODE_UNAVAILABLE", decision.reason, {
        identityStatus: identity.status,
      });
    }
    if (decision.mode !== "session_jar") {
      await release({ failure: true, outcome: "mode_requires_host", reason: decision.mode });
      throw new AuthBrokerClientError("SESSION_MODE_REQUIRES_HOST", `mode ${decision.mode} must be executed by the Auth Broker`, {
        identityStatus: identity.status,
      });
    }

    const headers = session ? authHeadersFromSessionJar(session) : {};
    const result = await work({
      session,
      identity,
      lease,
      mode: decision.mode,
      headers,
      probe: { loginProbe, crawlProbe },
    });
    await release({ failure: false, outcome: "ok" });
    return result;
  } catch (err) {
    const authFailure = err?.name === "SourceHttpError" && (err.status === 401 || err.status === 403);
    if (authFailure) {
      await release({
        failure: true,
        outcome: "source_auth_failed",
        reason: `source HTTP ${err.status}`,
      }).catch(() => {});
      await markCrawlerIdentityFailure({
        brokerUrl, brokerToken, source, accountId,
        reason: `source HTTP ${err.status}`,
        status: "login_required",
        brokerFetch,
      }).catch(() => {});
      throw err;
    }
    await release({
      failure: true,
      outcome: "error",
      reason: err?.message ?? String(err),
    }).catch(() => {});
    throw err;
  }
}
