// Per-identity Chromium profile handling. Two identities must never share a
// directory, context options or captured fingerprint, even if account ids are
// reused across sources.
import { join, resolve } from "node:path";
import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";

const SAFE_SEGMENT = (value) => encodeURIComponent(String(value ?? "")).replace(/[!'()*]/g, (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`);

export function identityKey({ source, accountId }) {
  if (!source || !accountId) throw new Error("identity requires source and accountId");
  return { source: String(source), accountId: String(accountId) };
}

export function profileDirectory(identity, { root = process.env.LEGAL_AUTH_PROFILE_ROOT ?? "/data/legal-auth/profiles" } = {}) {
  const { source, accountId } = identityKey(identity);
  // Percent-encoding keeps account ids visually traceable while making path
  // traversal impossible even when an id contains ../ or an absolute path.
  return resolve(join(root, SAFE_SEGMENT(source), SAFE_SEGMENT(accountId)));
}

export async function ensureProfileDirectory(identity, options = {}) {
  const directory = profileDirectory(identity, options);
  if (directory === resolve(options.root ?? process.env.LEGAL_AUTH_PROFILE_ROOT ?? "/data/legal-auth/profiles")) {
    throw new Error("refusing to use the profile root as an identity profile");
  }
  await mkdir(directory, { recursive: true });
  return directory;
}

export function contextOptions(identity, { headless = false } = {}) {
  const { source, accountId } = identityKey(identity);
  const loginProxyUrl = identity.login_proxy_url ?? null;
  if (identity.requires_login_proxy && !loginProxyUrl) {
    const err = new Error(`${source}/${accountId} requires a login proxy`);
    err.code = "LOGIN_PROXY_REQUIRED";
    throw err;
  }
  // Playwright wants credentials outside the proxy URL. The identity Secret
  // still carries a standard http://user:pass@host:port URL.
  let proxy = undefined;
  if (loginProxyUrl) {
    const parsed = new URL(loginProxyUrl);
    proxy = {
      server: `${parsed.protocol}//${parsed.host}`,
      username: parsed.username ? decodeURIComponent(parsed.username) : undefined,
      password: parsed.password ? decodeURIComponent(parsed.password) : undefined,
    };
  }
  const viewport = identity.viewport?.width && identity.viewport?.height
    ? { width: Number(identity.viewport.width), height: Number(identity.viewport.height) }
    : { width: 1440, height: 900 };
  return {
    headless,
    viewport,
    locale: identity.locale ?? "zh-CN",
    timezoneId: identity.timezone ?? "Asia/Shanghai",
    userAgent: identity.user_agent ?? undefined,
    proxy,
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-first-run",
      "--no-default-browser-check",
    ],
    // Playwright does not use this field, but carrying it in options makes the
    // identity visible in debug dumps without exposing cookies.
    __identity: { source, accountId },
  };
}

// Launch a persistent context in the identity's own directory. Playwright is
// imported lazily so unit tests can validate options without a browser install.
export async function launchIdentityBrowser(identity, { headless = false, root, chromium } = {}) {
  const directory = await ensureProfileDirectory(identity, { root });
  const browserType = chromium ?? (await import("playwright")).chromium;
  return browserType.launchPersistentContext(directory, contextOptions(identity, { headless }));
}

export async function captureBrowserState(context, identity) {
  const storageState = await context.storageState();
  const pages = context.pages?.() ?? [];
  const page = pages.at(-1);
  const fingerprint = {
    userAgent: identity.user_agent ?? await page?.evaluate?.(() => navigator.userAgent).catch(() => null) ?? null,
    viewport: identity.viewport ?? { width: 1440, height: 900 },
    locale: identity.locale ?? "zh-CN",
    timezone: identity.timezone ?? "Asia/Shanghai",
    contextId: randomUUID(),
  };
  return { storageState, fingerprint };
}

export function assertProfileIsolation(identityA, identityB, options = {}) {
  const a = profileDirectory(identityA, options);
  const b = profileDirectory(identityB, options);
  if (a === b) {
    throw new Error("two identities resolved to one browser profile; profile isolation is broken");
  }
  return { a, b };
}
