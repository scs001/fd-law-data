// Proxy identity policy and session probes. A proxy is treated as part of the
// account identity: cross-proxy crawling is possible only after both proxy
// probes and a small-batch verification have succeeded.
import { SessionJarError } from "./session-jar.js";

export const DEFAULT_PROBES = {
  "rmfyalk-case-library": {
    method: "POST",
    url: "https://rmfyalk.court.gov.cn/cpws_al_api/api/cpwsAl/search",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      referer: "https://rmfyalk.court.gov.cn/view/list.html",
      origin: "https://rmfyalk.court.gov.cn",
    },
    body: {
      page: 1,
      size: 1,
      searchParams: {
        userSearchType: 1,
        isAdvSearch: "0",
        selectValue: "qw",
        lib: "cpwsAl_qb",
        sort_field: "",
      },
    },
    valid: (payload) => payload?.code === "0" || payload?.code === "401",
  },
};

export function normalizeProxyBinding(identity = {}) {
  const loginProxyId = identity.login_proxy_id ?? identity.loginProxyId ?? null;
  const crawlProxyId = identity.crawl_proxy_id ?? identity.crawlProxyId ?? loginProxyId;
  if (!loginProxyId) throw new Error("identity requires login_proxy_id");
  if (!crawlProxyId) throw new Error("identity requires crawl_proxy_id");
  const same = loginProxyId === crawlProxyId;
  return {
    login_proxy_id: loginProxyId,
    crawl_proxy_id: crawlProxyId,
    same,
    cross_proxy_allowed: same || Boolean(
      identity.crawl_proxy_probe_at && identity.small_batch_at,
    ),
  };
}

export function classifyProbeResponse({ status, text = "", payload = null } = {}) {
  const body = String(text ?? "").toLowerCase();
  if (status === 401) return { ok: false, kind: "login_required", reason: "HTTP 401" };
  if (status === 403) return { ok: false, kind: "forbidden", reason: "HTTP 403" };
  if (status === 429) return { ok: false, kind: "rate_limited", reason: "HTTP 429" };
  if (status >= 500) return { ok: false, kind: "source_error", reason: `HTTP ${status}` };
  if (status !== 200) return { ok: false, kind: "unexpected_status", reason: `HTTP ${status}` };
  if (/account.*ban|账号.*封禁|已对您的账号进行封禁/.test(body)) {
    return { ok: false, kind: "banned", reason: "account ban marker" };
  }
  if (/login|signin|登录|验证码|captcha|slider/i.test(body)) {
    return { ok: false, kind: "login_required", reason: "login or captcha marker" };
  }
  if (payload && typeof payload === "object") {
    if (String(payload.code) === "0") return { ok: true, kind: "ok", reason: "source accepted session" };
    if (String(payload.code) === "401") return { ok: false, kind: "login_required", reason: "source code 401" };
    return { ok: false, kind: "unexpected_payload", reason: `source code ${payload.code}` };
  }
  return { ok: false, kind: "unexpected_payload", reason: "probe response was not JSON" };
}

export async function probeSession(session, {
  purpose = "crawl",
  proxyId,
  proxyUrl,
  fetchImpl = globalThis.fetch,
  dispatcher = null,
  timeoutMs = 30000,
  probe = DEFAULT_PROBES[session?.source],
} = {}) {
  if (!probe) throw new SessionJarError("NO_PROBE", `no probe configured for source: ${session?.source}`);
  if (purpose === "login" && proxyId && session.proxy?.login_proxy_id !== proxyId) {
    throw new SessionJarError("PROXY_MISMATCH", "login probe used a proxy other than login_proxy_id");
  }
  if (purpose === "crawl" && proxyId && session.proxy?.crawl_proxy_id !== proxyId) {
    throw new SessionJarError("PROXY_MISMATCH", "crawl probe used a proxy other than crawl_proxy_id");
  }
  const headers = {
    "user-agent": session.browser?.userAgent ?? "Mozilla/5.0",
    referer: new URL(probe.url).origin + "/",
    ...probe.headers,
  };
  if (session.mode === "session_jar") {
    if (!session.auth?.headerName || !session.auth?.userToken) {
      throw new SessionJarError("BAD_JAR", "session jar lacks auth header");
    }
    headers[session.auth.headerName] = session.auth.userToken;
  }
  const cookies = (session.storageState?.cookies ?? [])
    .filter((cookie) => cookie?.name && cookie?.value)
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
  if (cookies) headers.cookie = cookies;

  const startedAt = new Date().toISOString();
  let response;
  let text;
  let payload = null;
  try {
    response = await fetchImpl(probe.url, {
      method: probe.method,
      headers,
      body: probe.body ? JSON.stringify(probe.body) : undefined,
      dispatcher,
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await response.text();
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
  } catch (err) {
    return {
      ok: false,
      purpose,
      proxy_id: proxyId ?? session.proxy?.[`${purpose}_proxy_id`] ?? null,
      kind: "network_error",
      reason: String(err?.cause?.message ?? err?.message ?? err),
      checked_at: startedAt,
    };
  }
  const verdict = classifyProbeResponse({ status: response.status, text, payload });
  return {
    ...verdict,
    purpose,
    proxy_id: proxyId ?? session.proxy?.[`${purpose}_proxy_id`] ?? null,
    proxy_url_configured: Boolean(proxyUrl),
    status: response.status,
    checked_at: startedAt,
  };
}

// The default policy requires same login/crawl proxy. Cross-proxy is only a
// candidate until probeSession(login) + probeSession(crawl) + recordSmallBatch
// have all succeeded.
export function crossProxyDecision(identity, { loginProbe, crawlProbe, smallBatch = null } = {}) {
  const binding = normalizeProxyBinding(identity);
  if (binding.same) {
    return { allowed: true, mode: "same_proxy", reason: "login and crawl use the same identity proxy" };
  }
  const probesOk = loginProbe?.ok && crawlProbe?.ok;
  const batchOk = Boolean(smallBatch?.ok ?? identity.small_batch_at);
  if (probesOk && batchOk) {
    return {
      allowed: true,
      mode: "cross_proxy",
      reason: "login proxy, crawl proxy and small-batch verification all passed",
    };
  }
  return {
    allowed: false,
    mode: "browser_session_host_or_relay",
    reason: !probesOk
      ? "cross-proxy session probe has not passed"
      : "cross-proxy small-batch verification has not passed",
  };
}

export function selectSessionMode(identity, { loginProbe, crawlProbe, smallBatch = null } = {}) {
  const decision = crossProxyDecision(identity, { loginProbe, crawlProbe, smallBatch });
  if (decision.allowed && bindingWantsSessionJar(identity)) return { ...decision, mode: "session_jar" };
  return { ...decision, mode: decision.allowed ? identity.mode ?? "session_jar" : decision.mode };
}

function bindingWantsSessionJar(identity) {
  return (identity.mode ?? "session_jar") === "session_jar";
}
