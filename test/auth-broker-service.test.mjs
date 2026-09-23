import test from "node:test";
import assert from "node:assert/strict";
import { createAuthBrokerHandler, createMemorySessionStore } from "../lib/auth-broker/service.js";
import { decryptSessionJar, encryptSessionJar, redactSessionJar } from "../lib/auth-broker/session-jar.js";

const KEY = Buffer.alloc(32, 9);
const TOKEN = "broker-token";

function identity() {
  return {
    id: 1,
    source: "rmfyalk-case-library",
    account_id: "acct001",
    status: "active",
    mode: "session_jar",
    login_proxy_id: "proxy-a",
    crawl_proxy_id: "proxy-a",
    lease_owner: "crawler-1",
    lease_token: "lease-token",
    lease_expires_at: "2026-01-01T00:00:00Z",
    session_ref: "encrypted-ref",
  };
}

function operations() {
  let current = identity();
  const calls = [];
  return {
    calls,
    object: () => current,
    async getIdentity({ source, accountId }) {
      calls.push(["get", source, accountId]);
      return current.source === source && current.account_id === accountId ? current : null;
    },
    async upsertIdentity(input) {
      calls.push(["upsert", input.source, input.account_id]);
      current = { ...current, ...input };
      return { identity: current, created: false, crossProxyAllowed: true };
    },
    async acquireLease({ source, accountId, owner, ttlMs }) {
      calls.push(["acquire", source, accountId, owner, ttlMs]);
      return {
        lease: { token: current.lease_token, owner, expires_at: current.lease_expires_at },
        identity: current,
      };
    },
    async releaseLease({ source, accountId, token, failure }) {
      calls.push(["release", source, accountId, token, failure]);
      return current;
    },
    async recordFailure({ source, accountId, reason, status }) {
      calls.push(["failure", source, accountId, reason, status]);
      return { ...current, status };
    },
  };
}

function sessionStore(envelope) {
  return {
    async get() {
      return envelope;
    },
    async put(session) {
      return session;
    },
  };
}

function request(handler, method, path, { body, token = TOKEN } = {}) {
  const chunks = [];
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  const req = {
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    headers: null,
    body: "",
    statusCode: 0,
    writeHead(status, responseHeaders) {
      this.statusCode = status;
      this.headers = responseHeaders;
    },
    end(text) {
      this.body = text ?? "";
      chunks.push(this.body);
    },
  };
  return { req, res, done: handler(req, res) };
}

test("health is local-only readiness and all other routes require broker token", async () => {
  const handler = createAuthBrokerHandler({ operations: operations(), brokerToken: TOKEN });
  const health = await request(handler, "GET", "/health");
  await health.done;
  assert.equal(health.res.statusCode, 200);

  const denied = await request(handler, "GET", "/identities/rmfyalk-case-library/acct001", { token: "wrong" });
  await denied.done;
  assert.equal(denied.res.statusCode, 401);

  const unconfiguredHandler = createAuthBrokerHandler({ operations: operations(), brokerToken: "" });
  const unconfigured = await request(unconfiguredHandler, "GET", "/identities/rmfyalk-case-library/acct001", { token: null });
  await unconfigured.done;
  assert.equal(unconfigured.res.statusCode, 503);
});

test("acquire returns only a redacted identity and can issue the encrypted session", async () => {
  const jar = {
    version: 1,
    source: "rmfyalk-case-library",
    account_id: "acct001",
    mode: "session_jar",
    auth: { headerName: "x-token", userToken: "secret" },
    storageState: { cookies: [] },
    browser: { userAgent: "UA" },
    proxy: { login_proxy_id: "a", crawl_proxy_id: "a" },
  };
  const envelope = encryptSessionJar(jar, KEY);
  const ops = operations();
  const store = sessionStore(envelope);
  const handler = createAuthBrokerHandler({
    operations: ops,
    sessionStore: store,
    brokerToken: TOKEN,
  });
  const response = await request(handler, "POST", "/lease/acquire", {
    body: {
      source: "rmfyalk-case-library",
      account_id: "acct001",
      owner: "crawler-1",
      ttl_ms: 60_000,
      include_session: true,
    },
  });
  await response.done;
  assert.equal(response.res.statusCode, 200);
  const body = JSON.parse(response.res.body);
  assert.equal(body.lease.token, "lease-token");
  assert.equal(body.identity.lease_token, "[REDACTED]");
  assert.equal(body.session_jar.magic, envelope.magic);

  const plaintext = decryptSessionJar(body.session_jar, KEY);
  assert.equal(plaintext.auth.userToken, "secret");
  assert.equal(JSON.stringify(body).includes("secret"), false);
});

test("release, failure and session upload routes are token protected and redacted", async () => {
  const ops = operations();
  const handler = createAuthBrokerHandler({ operations: ops, brokerToken: TOKEN });

  const release = await request(handler, "POST", "/lease/release", {
    body: { source: "rmfyalk-case-library", account_id: "acct001", lease_token: "lease-token" },
  });
  await release.done;
  assert.equal(release.res.statusCode, 200);
  assert.equal(JSON.parse(release.res.body).released, true);

  const failure = await request(handler, "POST", "/failure", {
    body: { source: "rmfyalk-case-library", account_id: "acct001", reason: "401", status: "login_required" },
  });
  await failure.done;
  assert.equal(failure.res.statusCode, 200);
  assert.equal(JSON.parse(failure.res.body).identity.status, "login_required");

  const jar = {
    version: 1,
    source: "rmfyalk-case-library",
    account_id: "acct001",
    mode: "browser_session_host",
    storageState: { cookies: [] },
    browser: { userAgent: "UA" },
    proxy: { login_proxy_id: "a", crawl_proxy_id: "a" },
  };
  const store = createMemorySessionStore();
  const uploadHandler = createAuthBrokerHandler({ operations: ops, sessionStore: store, brokerToken: TOKEN });
  const upload = await request(uploadHandler, "POST", "/session", { body: { session_jar: jar } });
  await upload.done;
  assert.equal(upload.res.statusCode, 201);
  assert.equal(store.sessions.size, 1);
});

test("invalid JSON and unknown routes fail without exposing internals", async () => {
  const handler = createAuthBrokerHandler({ operations: operations(), brokerToken: TOKEN });
  const bad = await request(handler, "POST", "/lease/acquire", { body: undefined, token: TOKEN });
  await bad.done;
  assert.equal(bad.res.statusCode, 200);

  const missing = await request(handler, "GET", "/identities/nope/nope");
  await missing.done;
  assert.equal(missing.res.statusCode, 404);

  const unknown = await request(handler, "GET", "/nope");
  await unknown.done;
  assert.equal(unknown.res.statusCode, 404);
});
