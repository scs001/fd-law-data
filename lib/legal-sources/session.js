// Source-isolated login/proxy plumbing. Wave-1 adapters are HTTP-first, but the
// contract is the same as wenshu: a session jar is stored per source, a proxy is
// bound per source by environment name, and browser mode is opt-in — never a
// fallback that silently logs in or solves a captcha.
import { putIfChanged } from "../s3.js";
import { SessionProxyError } from "./errors.js";

export function sourceSessionKey(source) {
  return `legal-sources/${source}/sessions/session.json`;
}

export function sourceEnvName(source, suffix = "PROXY_URL") {
  return `${String(source).toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

// No global fallback: two sources must not inherit one another's egress.
export function proxyForSource(source, env = process.env) {
  const name = sourceEnvName(source);
  return env[name] || null;
}

export function browserMode(adapter) {
  return adapter?.mode === "browser";
}

export function assertTransportAllowed(adapter) {
  if (!adapter) throw new Error("legal-source adapter is required");
  if (browserMode(adapter) && !adapter.browser) {
    throw new SessionProxyError(
      "adapter declares browser mode but supplies no browser session factory",
      { code: "BROWSER_ADAPTER_INCOMPLETE" },
    );
  }
}

export async function downloadSourceSession(s3, bucket, source) {
  const buf = await s3.getObject(bucket, sourceSessionKey(source));
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    console.error(`[${source}] corrupt session jar; treating as missing`);
    return null;
  }
}

export async function uploadSourceSession(s3, bucket, source, storageState, account = null) {
  const wrapper = {
    version: 1,
    source,
    savedAt: new Date().toISOString(),
    account: account ?? null,
    storageState,
  };
  await putIfChanged(s3, bucket, sourceSessionKey(source), JSON.stringify(wrapper, null, 1), {
    contentType: "application/json",
  });
  return wrapper;
}

// Same fail-loud shape as lib/wenshu/session.js, but namespace-isolated per
// source and never performing an automatic login without explicit callbacks.
export async function ensureSourceSession({ s3, bucket, source, account = null, applyJar, probe, attemptRelogin }) {
  const jar = await downloadSourceSession(s3, bucket, source);
  if (!jar) {
    if (!account || !attemptRelogin) {
      throw new SessionProxyError(`no ${source} session jar and no automatic login is configured`, {
        code: "NO_JAR",
      });
    }
    const storageState = await attemptRelogin({ account });
    const wrapper = await uploadSourceSession(s3, bucket, source, storageState, account.user ?? null);
    await applyJar(wrapper.storageState);
    return wrapper;
  }

  await applyJar(jar.storageState);
  const checked = await probe();
  if (checked?.valid) return jar;

  if (!account || !attemptRelogin) {
    throw new SessionProxyError(`${source} session is stale (${checked?.reason ?? "probe invalid"})`, {
      code: "EXPIRED",
    });
  }
  const storageState = await attemptRelogin({ account });
  const wrapper = await uploadSourceSession(s3, bucket, source, storageState, account.user ?? null);
  await applyJar(wrapper.storageState);
  const checkedAgain = await probe();
  if (!checkedAgain?.valid) {
    throw new SessionProxyError(`${source} re-login did not validate`, { code: "RELOGIN_FAILED" });
  }
  return wrapper;
}
