// Platform identity-pool session consumption for legal-line crawlers
// (law-auth-session-consumption). The platform dispatcher injects either an
// inline jar (FD_SESSION_JAR — federated k8s jobs, where a shared /tmp path
// cannot reach) or a jar file (FD_SESSION_JAR_PATH — the docker path), plus
// FD_ACCOUNT, the standard proxy env and FD_EGRESS_REF.
//
// The jar is the platform login unit's output (fd-industry-data
// spiders/<source>/login.py): {version, source, account_id, mode,
// auth:{kind, headerName, userToken, raw}, storageState:{cookies, origins},
// browser, captured_at}. This module maps that schema onto the broker session
// consumption structure consumed by lib/auth-broker/session-jar.js, so platform
// mode reuses the existing header/cookie/user-agent path and never grows a
// second request implementation.
import { readFileSync } from "node:fs";
import {
  authHeadersFromSessionJar,
  cookieHeaderFromSessionJar,
  sessionJarFingerprint,
} from "../auth-broker/session-jar.js";

export class PlatformSessionError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "PlatformSessionError";
    this.code = code;
  }
}

// The rmfyalk login unit hard-codes this header name; it is the fallback when a
// jar omits auth.headerName (non-rmfyalk platform jars must carry their own).
function defaultHeaderName(source) {
  return /^rmfyalk/.test(String(source ?? "")) ? "faxin-cpws-al-token" : null;
}

function nonEmpty(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

// Which platform injection form is present, inline first (the platform's k8s
// form). Returns null when the run is not platform-injected.
export function platformSessionInjection(env = process.env) {
  const inline = nonEmpty(env.FD_SESSION_JAR);
  if (inline) return { kind: "inline", value: inline };
  const file = nonEmpty(env.FD_SESSION_JAR_PATH);
  if (file) return { kind: "path", value: file };
  return null;
}

export function loadPlatformSessionJar({ env = process.env, readFile = readFileSync } = {}) {
  const injection = platformSessionInjection(env);
  if (!injection) return null;
  let text;
  if (injection.kind === "inline") {
    text = injection.value;
  } else {
    try {
      text = readFile(injection.value, "utf8");
    } catch (err) {
      throw new PlatformSessionError(
        "NO_PLATFORM_SESSION_FILE",
        `platform session jar file is unreadable at FD_SESSION_JAR_PATH (${injection.value}): ${err.message}`,
        { cause: err },
      );
    }
  }
  let jar;
  try {
    jar = JSON.parse(text);
  } catch (err) {
    throw new PlatformSessionError(
      "BAD_PLATFORM_SESSION",
      `platform session jar is not valid JSON (${injection.kind} injection): ${err.message}`,
      { cause: err },
    );
  }
  if (!jar || typeof jar !== "object" || Array.isArray(jar)) {
    throw new PlatformSessionError("BAD_PLATFORM_SESSION", "platform session jar must be a JSON object");
  }
  return jar;
}

// Map the platform jar onto the broker session shape. `source` is the adapter
// id (e.g. rmfyalk-case-library), used only when the jar carries no source of
// its own. An empty jar (no token and no joinable cookie) fails here, before
// any request can leave unauthenticated.
export function mapPlatformSessionJar(jar, { source = null } = {}) {
  const auth = jar.auth ?? {};
  const storageState = jar.storageState ?? jar.storage_state ?? {};
  const userToken = nonEmpty(auth.userToken) ?? nonEmpty(auth.user_token) ?? nonEmpty(auth.token);
  const headerName = nonEmpty(auth.headerName) ?? nonEmpty(auth.header_name)
    ?? defaultHeaderName(jar.source ?? source);
  const userAgent = nonEmpty(jar.browser?.userAgent) ?? nonEmpty(jar.browser?.user_agent)
    ?? nonEmpty(jar.userAgent) ?? nonEmpty(jar.user_agent);
  const cookies = Array.isArray(storageState?.cookies) ? storageState.cookies : [];

  const session = {
    version: Number.isFinite(jar.version) ? jar.version : 1,
    source: jar.source ?? (source ? String(source) : null),
    account_id: jar.account_id ?? null,
    mode: "session_jar",
    auth: {
      ...(headerName ? { headerName } : {}),
      ...(userToken ? { userToken } : {}),
    },
    storageState: { cookies },
    browser: userAgent ? { userAgent } : {},
  };
  // Reuses the broker cookie join (source-specific domain filter included).
  const cookieHeader = cookieHeaderFromSessionJar(session);
  if (!userToken && !cookieHeader) {
    throw new PlatformSessionError(
      "EMPTY_PLATFORM_SESSION",
      "platform session jar has no auth token and no storageState cookies — session expired or login was never completed",
    );
  }

  let headers;
  if (userToken) {
    try {
      headers = authHeadersFromSessionJar(session);
    } catch (err) {
      throw new PlatformSessionError(
        "BAD_PLATFORM_SESSION",
        `platform session jar cannot build auth headers: ${err.message}`,
        { cause: err },
      );
    }
  } else {
    // Cookie-only jar: same mapping as authHeadersFromSessionJar minus the
    // token header; the source's own 401/未登录 classification then reports it.
    headers = {};
    if (cookieHeader) headers.cookie = cookieHeader;
    if (userAgent) headers["user-agent"] = userAgent;
  }

  return {
    session,
    headers,
    cookieHeader,
    headerName: session.auth.headerName ?? null,
    hasToken: Boolean(userToken),
    fingerprint: sessionJarFingerprint(session),
  };
}

// Crawl egress: the platform injects the identity's egress as standard proxy
// env; the broker-era LEGAL_AUTH_CRAWL_PROXY_URL stays as the fallback so a
// non-platform run keeps its previous exit. createProxyFetch/curl consumes the
// resolved URL, so every adapter request (list, detail, attachments) exits
// through it.
export function resolveCrawlProxyUrl(env = process.env) {
  for (const name of ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "LEGAL_AUTH_CRAWL_PROXY_URL"]) {
    const value = nonEmpty(env[name]);
    if (value) return value;
  }
  return null;
}