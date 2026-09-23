import test from "node:test";
import assert from "node:assert/strict";
import {
  browserMode,
  ensureSourceSession,
  proxyForSource,
  sourceEnvName,
  sourceSessionKey,
} from "../lib/legal-sources/session.js";
import { SessionProxyError } from "../lib/legal-sources/errors.js";

test("proxy names are source isolated with no shared fallback", () => {
  assert.equal(sourceEnvName("mfa-treaty-library"), "MFA_TREATY_LIBRARY_PROXY_URL");
  assert.equal(sourceEnvName("gov-rules-library"), "GOV_RULES_LIBRARY_PROXY_URL");
  assert.equal(proxyForSource("a-source", { A_SOURCE_PROXY_URL: "http://a" }), "http://a");
  assert.equal(proxyForSource("b-source", { A_SOURCE_PROXY_URL: "http://a" }), null);
});

test("HTTP mode never requires a browser adapter; incomplete browser mode fails", async () => {
  assert.equal(browserMode({ mode: "http" }), false);
  const { assertTransportAllowed } = await import("../lib/legal-sources/session.js");
  assert.doesNotThrow(() => assertTransportAllowed({ mode: "http" }));
  assert.throws(() => assertTransportAllowed({ mode: "browser" }), SessionProxyError);
});

test("source sessions are namespaced and revalidated before reuse", async () => {
  const objects = new Map();
  const s3 = {
    async getObject(bucket, key) {
      return objects.get(`${bucket}/${key}`) ?? null;
    },
    async putObject(bucket, key, body) {
      objects.set(`${bucket}/${key}`, Buffer.from(String(body)));
      return {};
    },
    async headObject(bucket, key) {
      const value = objects.get(`${bucket}/${key}`);
      return value ? { contentLength: value.length } : null;
    },
  };
  const bucket = "laws";
  const calls = [];
  let valid = false;
  const wrapper = await ensureSourceSession({
    s3,
    bucket,
    source: "session-source",
    account: { user: "test-operator" },
    applyJar: async () => calls.push("apply"),
    probe: async () => ({ valid }),
    attemptRelogin: async () => ({ cookies: [{ name: "sid" }] }),
  });
  assert.equal(wrapper.storageState.cookies[0].name, "sid");
  const storedKey = [...objects.keys()][0];
  assert.equal(storedKey, `${bucket}/legal-sources/session-source/sessions/session.json`);

  valid = true;
  const reused = await ensureSourceSession({
    s3,
    bucket,
    source: "session-source",
    applyJar: async () => calls.push("apply"),
    probe: async () => ({ valid }),
  });
  assert.equal(reused.storageState.cookies[0].name, "sid");
  assert.equal(calls.filter((x) => x === "apply").length, 2);
});

test("stale session without re-login is loud", async () => {
  const s3 = {
    async getObject() { return Buffer.from(JSON.stringify({ storageState: { cookies: [] } })); },
    async putObject() { return {}; },
  };
  await assert.rejects(
    () => ensureSourceSession({
      s3,
      bucket: "laws",
      source: "stale-source",
      applyJar: async () => {},
      probe: async () => ({ valid: false, reason: "expired" }),
    }),
    /session is stale/,
  );
});
