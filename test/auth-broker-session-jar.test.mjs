import test from "node:test";
import assert from "node:assert/strict";
import {
  authHeadersFromSessionJar,
  cookieHeaderFromSessionJar,
  decryptSessionJar,
  encryptSessionJar,
  redactSessionJar,
  SessionJarError,
  sessionJarFingerprint,
  validateSessionJar,
} from "../lib/auth-broker/session-jar.js";

const KEY = Buffer.alloc(32, 7);

export const jar = {
  version: 1,
  source: "rmfyalk-case-library",
  account_id: "acct001",
  mode: "session_jar",
  auth: {
    headerName: "faxin-cpws-al-token",
    userToken: "secret-token",
    raw: { alUser: { realName: "张三", userToken: "secret-token" } },
  },
  storageState: {
    cookies: [
      { name: "WZWS_COOKIE", value: "secret-cookie", domain: ".court.gov.cn", path: "/" },
      { name: "other", value: "ignored", domain: "example.com", path: "/" },
    ],
    origins: [{ origin: "https://rmfyalk.court.gov.cn", localStorage: [{ name: "k", value: "v" }] }],
  },
  browser: {
    userAgent: "Mozilla/5.0 legal-test",
    viewport: { width: 1440, height: 900 },
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
  },
  proxy: { login_proxy_id: "proxy-a", crawl_proxy_id: "proxy-a", login_exit_ip: "192.0.2.1", crawl_exit_ip: "192.0.2.1" },
  probe: { login_proxy: { status: 200 }, crawl_proxy: { status: 200 } },
};

test("validates the minimum portable session shape", () => {
  assert.equal(validateSessionJar(jar), jar);
  assert.throws(() => validateSessionJar({ ...jar, auth: { headerName: "x" } }), SessionJarError);
  assert.throws(() => validateSessionJar({ ...jar, proxy: { login_proxy_id: "x" } }), SessionJarError);
});

test("AES-256-GCM roundtrip authenticates and rejects tampering", () => {
  const envelope = encryptSessionJar(jar, KEY);
  assert.equal(envelope.alg, "A256GCM");
  assert.equal(decryptSessionJar(envelope, KEY).auth.userToken, "secret-token");

  const tampered = { ...envelope, ciphertext: Buffer.from("tampered").toString("base64") };
  assert.throws(() => decryptSessionJar(tampered, KEY), SessionJarError);
  assert.throws(() => decryptSessionJar(envelope, Buffer.alloc(32, 8)), SessionJarError);
});

test("redaction removes every sensitive scalar recursively", () => {
  const safe = redactSessionJar(jar);
  const text = JSON.stringify(safe);
  assert.doesNotMatch(text, /secret-token|secret-cookie|张三/);
  assert.equal(safe.auth.raw.alUser.realName, "[REDACTED]");
  assert.equal(safe.storageState, "[REDACTED]");
});

test("builds crawler headers from the source-specific cookie and token", () => {
  const headers = authHeadersFromSessionJar(jar);
  assert.equal(headers["faxin-cpws-al-token"], "secret-token");
  assert.equal(headers.cookie, "WZWS_COOKIE=secret-cookie");
  assert.equal(headers["user-agent"], "Mozilla/5.0 legal-test");

  const browserHost = structuredClone(jar);
  browserHost.mode = "browser_session_host";
  delete browserHost.auth;
  assert.equal(cookieHeaderFromSessionJar(browserHost), "WZWS_COOKIE=secret-cookie");
});

test("fingerprints identity without exposing credentials", () => {
  const fingerprint = sessionJarFingerprint(jar);
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/);
  assert.doesNotMatch(fingerprint, /secret/);
});
