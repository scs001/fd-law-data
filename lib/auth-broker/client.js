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

// The relay channel implements probeSession's fetchImpl contract: every call
// is forwarded to the broker's /relay route, which injects the leased
// identity's session material server-side, so the crawler never holds tokens.
function createRelayChannel({ brokerUrl, brokerToken, source, accountId, leaseToken, fetchImpl = globalThis.fetch }) {
  return async function relayRequest(url, options = {}) {
    const body = options.body === undefined
      ? undefined
      : Buffer.from(typeof options.body === "string" ? options.body : String(options.body));
    const payload = await requestJson(new URL("/relay", brokerUrl).toString(), {
      method: "POST",
      token: brokerToken,
      body: {
        source,
        account_id: accountId,
        lease_token: leaseToken,
        url,
        method: options.method ?? "GET",
        headers: options.headers ?? {},
        ...(body ? { body_base64: body.toString("base64") } : {}),
      },
      signal: options.signal,
      fetchImpl,
    });
    const responseBody = Buffer.from(payload.body_base64 ?? "", "base64");
    return {
      status: payload.status,
      ok: payload.status >= 200 && payload.status < 300,
      headers: { get: (name) => payload.headers?.[String(name).toLowerCase()] ?? null },
      text: async () => payload.body_text ?? responseBody.toString("utf8"),
    };
  };
}

/**
 * Run `work` while holding an identity lease.
 * `work({headers, session, identity, mode, relay})` must not retry auth failures.
 * A 401/403 from source HTTP should be thrown as an Error with `status`.
 * Depending on the selected consumption mode, either `headers`+`session`
 * (session_jar) or `relay` (proxy_bound_relay) is populated — never both.
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
    const decision = selectSessionMode(identity, { loginProbe, crawlProbe });
    const probesFailed = !loginProbe.ok || !crawlProbe.ok;
    if (probesFailed && (!decision.allowed || decision.mode === "session_jar")) {
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
    if (!decision.allowed) {
      await release({ failure: true, outcome: "mode_unavailable", reason: decision.reason });
      throw new AuthBrokerClientError("SESSION_MODE_UNAVAILABLE", decision.reason, {
        identityStatus: identity.status,
      });
    }
    if (decision.mode === "browser_session_host") {
      await release({ failure: true, outcome: "mode_requires_host", reason: decision.mode });
      throw new AuthBrokerClientError("SESSION_MODE_REQUIRES_HOST", `mode ${decision.mode} must be executed by the Auth Broker`, {
        identityStatus: identity.status,
      });
    }
    if (decision.mode === "proxy_bound_relay") {
      // The switch is audited and persisted broker-side; the relay probe then
      // re-proves the session over the new path before any crawl work runs.
      await requestJson(new URL("/mode", brokerUrl).toString(), {
        method: "POST",
        token: brokerToken,
        body: {
          source,
          account_id: accountId,
          lease_token: lease.token,
          mode: decision.mode,
          reason: decision.reason,
          probes: decision.probes,
        },
        fetchImpl: brokerFetch,
      });
      const relay = createRelayChannel({ brokerUrl, brokerToken, source, accountId, leaseToken: lease.token, fetchImpl });
      const relayProbe = await probeSession({
        source,
        mode: "proxy_bound_relay",
        proxy: { login_proxy_id: identity.login_proxy_id, crawl_proxy_id: identity.crawl_proxy_id },
        browser: { userAgent: identity.user_agent ?? "Mozilla/5.0" },
      }, { purpose: "crawl", proxyId: identity.crawl_proxy_id, fetchImpl: relay });
      if (!relayProbe.ok) {
        await release({ failure: true, outcome: "relay_probe_failed", reason: relayProbe.reason });
        await markCrawlerIdentityFailure({
          brokerUrl, brokerToken, source, accountId,
          reason: relayProbe.reason,
          status: relayProbe.kind === "banned" ? "banned" : "login_required",
          brokerFetch,
        });
        throw new AuthBrokerClientError("SESSION_PROBE_FAILED", `relay probe failed: ${relayProbe.reason}`, {
          identityStatus: relayProbe.kind,
        });
      }
      const result = await work({
        session: null,
        identity,
        lease,
        mode: "proxy_bound_relay",
        headers: {},
        relay,
        probe: { loginProbe, crawlProbe, relayProbe },
      });
      await release({ failure: false, outcome: "ok" });
      return result;
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
