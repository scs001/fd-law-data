// Rmfyalk Auth Broker login adapter. It records the browser's own
// /cpws_al_api/api/user/loginGd response, rather than inventing a replay flow,
// and converts that response plus Playwright storageState into a portable jar.
import { SessionJarError, validateSessionJar } from "../session-jar.js";

export const RMFYALK_BASE_URL = process.env.RMFYALK_BASE_URL ?? "https://rmfyalk.court.gov.cn";
export const LOGIN_URL_ENDPOINT = "/cpws_al_api/api/user/getGdLoginUrl";
export const LOGIN_CALLBACK_ENDPOINT = "/cpws_al_api/api/user/loginGd";
export const AUTH_HEADER_NAME = "faxin-cpws-al-token";

export function extractOAuthCallback(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    return null;
  }
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) return null;
  return { code, state, mClient: state.split("_")[1] || "" };
}

export function parseLoginGdResponse(payload) {
  if (!payload || payload.code !== "0" || !payload.data?.alUser?.userToken) {
    const code = payload?.code ?? "missing";
    const message = payload?.msg ?? "no data.alUser.userToken";
    throw new SessionJarError("LOGIN_RESPONSE_INVALID", `rmfyalk loginGd rejected: code=${code}, ${message}`);
  }
  return {
    userToken: payload.data.alUser.userToken,
    // raw is intentionally retained inside the encrypted jar only.
    raw: payload,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function jsonRequest(fetchImpl, url, options) {
  const response = await fetchImpl(url, options);
  const text = await response.text();
  if (!response.ok) {
    throw new SessionJarError("LOGIN_ENTRY_FAILED", `login URL endpoint returned HTTP ${response.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SessionJarError("LOGIN_ENTRY_DRIFT", "login URL endpoint returned non-JSON");
  }
}

/**
 * Run a human login in a Playwright context. The context must already be bound
 * to the identity's browser profile and login proxy.
 *
 * @param {object} params
 * @param {object} params.context Playwright BrowserContext
 * @param {string} [params.baseUrl]
 * @param {Function} [params.fetchImpl]
 * @param {number} [params.timeoutMs] human login budget
 * @param {number} [params.pollMs]
 */
export async function captureRmfyalkSession({
  identity,
  context,
  baseUrl = RMFYALK_BASE_URL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10 * 60 * 1000,
  pollMs = 500,
} = {}) {
  if (!identity?.accountId && !identity?.account_id) {
    throw new SessionJarError("BAD_IDENTITY", "captureRmfyalkSession requires identity.accountId");
  }
  if (!context?.newPage || !context?.storageState) {
    throw new SessionJarError("BAD_CONTEXT", "captureRmfyalkSession requires a Playwright BrowserContext");
  }
  const entry = await jsonRequest(fetchImpl, new URL(LOGIN_URL_ENDPOINT, baseUrl).toString(), {
    method: "POST",
    headers: { "content-type": "application/json;charset=UTF-8", referer: `${baseUrl}/` },
    body: JSON.stringify({}),
  });
  if (entry.code !== "0" || !entry.data) {
    throw new SessionJarError("LOGIN_ENTRY_FAILED", `getGdLoginUrl rejected: code=${entry.code}`);
  }
  const loginUrl = String(entry.data).replace(/^http:/, "https:");

  const page = await context.newPage();
  let captured;
  let captureError;
  const onResponse = async (response) => {
    if (!response.url().includes(LOGIN_CALLBACK_ENDPOINT) || captured) return;
    try {
      captured = parseLoginGdResponse(await response.json());
    } catch (err) {
      captureError = err;
    }
  };
  page.on("response", onResponse);
  try {
    await page.goto(loginUrl, { waitUntil: "domcontentloaded", timeout: 45_000 });
    const deadline = Date.now() + timeoutMs;
    while (!captured && !captureError && Date.now() < deadline) {
      if (extractOAuthCallback(page.url()) && page.__forceLoginGdForTest) {
        await page.__forceLoginGdForTest();
      }
      await sleep(pollMs);
    }
    if (captureError) throw captureError;
    if (!captured) {
      throw new SessionJarError("LOGIN_TIMEOUT", "human did not complete rmfyalk login before the session deadline");
    }
    const { storageState, fingerprint } = await captureIdentityContext(context);
    const accountId = identity.accountId ?? identity.account_id;
    const jar = {
      version: 1,
      source: "rmfyalk-case-library",
      account_id: accountId,
      mode: "session_jar",
      auth: {
        kind: "header-token",
        headerName: AUTH_HEADER_NAME,
        userToken: captured.userToken,
        raw: captured.raw,
      },
      storageState,
      browser: fingerprint,
      proxy: {
        login_proxy_id: identity.loginProxyId ?? identity.login_proxy_id ?? null,
        crawl_proxy_id: identity.crawlProxyId ?? identity.crawl_proxy_id ?? identity.loginProxyId ?? identity.login_proxy_id ?? null,
        login_exit_ip: identity.loginExitIp ?? identity.login_exit_ip ?? null,
        crawl_exit_ip: identity.crawlExitIp ?? identity.crawl_exit_ip ?? null,
      },
      captured_at: new Date().toISOString(),
    };
    return validateSessionJar(jar);
  } finally {
    page.off("response", onResponse);
    await page.close().catch(() => {});
  }
}

async function captureIdentityContext(context) {
  const storageState = await context.storageState();
  const pages = context.pages?.() ?? [];
  const page = pages.at(-1);
  const fingerprint = {
    userAgent: await page?.evaluate?.(() => navigator.userAgent).catch(() => null),
    viewport: context.viewportSize?.() ?? { width: 1280, height: 720 },
    locale: await page?.evaluate?.(() => navigator.language).catch(() => "zh-CN"),
    timezone: "Asia/Shanghai",
  };
  return { storageState, fingerprint };
}

export async function captureRmfyalkSessionForIdentity({ identity, context, ...options } = {}) {
  return captureRmfyalkSession({ identity, context, ...options });
}
