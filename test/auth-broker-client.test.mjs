import test from "node:test";
import assert from "node:assert/strict";
import { withCrawlerIdentity } from "../lib/auth-broker/client.js";
import { encryptSessionJar } from "../lib/auth-broker/session-jar.js";

const KEY = Buffer.alloc(32, 11);

function jar({ sameProxy = true } = {}) {
  return {
    version: 1,
    source: "rmfyalk-case-library",
    account_id: "acct001",
    mode: "session_jar",
    auth: { headerName: "x-token", userToken: "secret" },
    storageState: { cookies: [{ name: "c", value: "v", domain: ".court.gov.cn" }] },
    browser: { userAgent: "UA" },
    proxy: {
      login_proxy_id: "proxy-a",
      crawl_proxy_id: sameProxy ? "proxy-a" : "proxy-b",
    },
  };
}

function fakeBroker({ identity = {}, jar: sessionJar = jar(), probeStatus = 200, payload = { code: "0" }, calls = [] } = {}) {
  const envelope = encrypt(sessionJar);
  return async (url, options = {}) => {
    const path = new URL(url).pathname;
    calls.push([path, options.body ? JSON.parse(options.body) : null, options.headers]);
    if (path === "/lease/acquire") {
      assert.equal(options.headers.authorization, "Bearer broker-token");
      return jsonResponse(200, {
        lease: { token: "lease-token", owner: "crawler-1" },
        identity: {
          source: "rmfyalk-case-library",
          account_id: "acct001",
          mode: "session_jar",
          login_proxy_id: "proxy-a",
          crawl_proxy_id: sameProxyIdentity(identity) ? "proxy-a" : "proxy-b",
          ...identity,
        },
        session_jar: envelope,
      });
    }
    if (path === "/lease/release") return jsonResponse(200, { released: true });
    if (path === "/failure") return jsonResponse(200, { marked: true });
    throw new Error(`unexpected broker path ${path}`);
  };
}

function sameProxyIdentity(identity) {
  return (identity.crawl_proxy_id ?? "proxy-a") === "proxy-a";
}

function encrypt(session) {
  return encryptSessionJar(session, KEY);
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

const brokerOptions = {
  brokerUrl: "http://auth-broker.internal",
  brokerToken: "broker-token",
  source: "rmfyalk-case-library",
  accountId: "acct001",
  owner: "crawler-1",
  jarKey: KEY,
};

test("same-proxy identity probes once, injects headers, and releases successfully", async () => {
  const brokerCalls = [];
  const broker = fakeBroker({ calls: brokerCalls, probeStatus: 200, payload: { code: "0" } });
  const probeCalls = [];
  const probeStatus = 200;
  const payload = { code: "0" };
  const result = await withCrawlerIdentity({
    ...brokerOptions,
    fetchImpl: async (url, options) => {
      if (!url.includes("rmfyalk")) return broker(url, options);
      probeCalls.push({ url, options });
      return { status: probeStatus, text: async () => JSON.stringify(payload) };
    },
    work: async ({ session, mode, headers }) => {
      assert.equal(mode, "session_jar");
      assert.equal(session.auth.userToken, "secret");
      assert.equal(headers["x-token"], "secret");
      assert.equal(headers.cookie, "c=v");
      return { done: true };
    },
  });
  assert.deepEqual(result, { done: true });
  assert.deepEqual(brokerCalls.map((c) => c[0]), ["/lease/acquire", "/lease/release"]);
  assert.equal(brokerCalls[1][1].lease_token, "lease-token");
  assert.equal(brokerCalls[1][1].failure, false);
  assert.equal(probeCalls.length, 1);
  assert.equal(probeCalls[0].options.headers["x-token"], "secret");
});

test("source 401 marks identity login_required and releases with failure", async () => {
  const brokerCalls = [];
  const broker = fakeBroker({ calls: brokerCalls });
  const err = new Error("HTTP 401");
  err.name = "SourceHttpError";
  err.status = 401;
  await assert.rejects(
    withCrawlerIdentity({
      ...brokerOptions,
      fetchImpl: async (url, options) => url.includes("rmfyalk")
        ? { status: 200, text: async () => JSON.stringify({ code: "0" }) }
        : broker(url, options),
      work: async () => { throw err; },
    }),
    /HTTP 401/,
  );
  assert.deepEqual(brokerCalls.map((c) => c[0]), ["/lease/acquire", "/lease/release", "/failure"]);
  assert.equal(brokerCalls[1][1].failure, true);
  assert.equal(brokerCalls[2][1].status, "login_required");
});

test("probe failure marks identity without invoking work", async () => {
  const brokerCalls = [];
  const broker = fakeBroker({ calls: brokerCalls, payload: { code: "401" } });
  await assert.rejects(
    withCrawlerIdentity({
      ...brokerOptions,
      fetchImpl: async (url, options) => url.includes("rmfyalk")
        ? { status: 200, text: async () => JSON.stringify({ code: "401" }) }
        : broker(url, options),
      work: async () => { throw new Error("must not run"); },
    }),
    (err) => err.code === "SESSION_PROBE_FAILED",
  );
  assert.deepEqual(brokerCalls.map((c) => c[0]), ["/lease/acquire", "/lease/release", "/failure"]);
});

test("cross-proxy identity probes both proxies before allowing work", async () => {
  const brokerCalls = [];
  const broker = fakeBroker({
    calls: brokerCalls,
    identity: {
      crawl_proxy_id: "proxy-b",
      crawl_proxy_probe_at: "2026-01-01",
      small_batch_at: "2026-01-02",
    },
    jar: jar({ sameProxy: false }),
  });
  const probes = [];
  const result = await withCrawlerIdentity({
    ...brokerOptions,
    fetchImpl: async (url, options) => {
      if (!url.includes("rmfyalk")) return broker(url, options);
      probes.push(options.headers.cookie);
      return { status: 200, text: async () => JSON.stringify({ code: "0" }) };
    },
    work: async ({ mode }) => ({ mode }),
  });
  assert.equal(result.mode, "session_jar");
  assert.equal(probes.length, 2);
});
