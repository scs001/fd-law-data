import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyProbeResponse,
  crossProxyDecision,
  normalizeProxyBinding,
  probeSession,
  selectSessionMode,
} from "../lib/auth-broker/proxy.js";

const jar = {
  source: "rmfyalk-case-library",
  account_id: "acct001",
  mode: "session_jar",
  auth: { headerName: "faxin-cpws-al-token", userToken: "secret" },
  storageState: { cookies: [{ name: "WZWS", value: "x", domain: ".court.gov.cn" }] },
  browser: { userAgent: "UA" },
  proxy: { login_proxy_id: "proxy-a", crawl_proxy_id: "proxy-a" },
};

test("same-proxy binding is allowed; cross-proxy starts disabled", () => {
  assert.deepEqual(normalizeProxyBinding({
    login_proxy_id: "a",
    crawl_proxy_id: "a",
  }), { login_proxy_id: "a", crawl_proxy_id: "a", same: true, cross_proxy_allowed: true });

  assert.deepEqual(normalizeProxyBinding({
    login_proxy_id: "a",
    crawl_proxy_id: "b",
  }), { login_proxy_id: "a", crawl_proxy_id: "b", same: false, cross_proxy_allowed: false });

  assert.equal(normalizeProxyBinding({
    login_proxy_id: "a",
    crawl_proxy_id: "b",
    crawl_proxy_probe_at: "2026-01-01",
    small_batch_at: "2026-01-02",
  }).cross_proxy_allowed, true);
});

test("probe response classification never mistakes a login wall for success", () => {
  assert.equal(classifyProbeResponse({ status: 200, payload: { code: "0" } }).ok, true);
  assert.equal(classifyProbeResponse({ status: 200, payload: { code: "401" } }).kind, "login_required");
  assert.equal(classifyProbeResponse({ status: 200, text: "请登录" }).kind, "login_required");
  assert.equal(classifyProbeResponse({ status: 200, text: "请输入验证码" }).kind, "login_required");
  assert.equal(classifyProbeResponse({ status: 200, text: "账号进行封禁" }).kind, "banned");
  assert.equal(classifyProbeResponse({ status: 403 }).kind, "forbidden");
  assert.equal(classifyProbeResponse({ status: 503 }).kind, "source_error");
});

test("session probe injects header, cookies and identity user agent", async () => {
  let seen;
  const result = await probeSession(jar, {
    purpose: "crawl",
    proxyId: "proxy-a",
    fetchImpl: async (url, options) => {
      seen = { url, options };
      return {
        status: 200,
        text: async () => JSON.stringify({ code: "0", data: { datas: [] } }),
      };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(seen.options.headers["faxin-cpws-al-token"], "secret");
  assert.equal(seen.options.headers.cookie, "WZWS=x");
  assert.equal(seen.options.headers["user-agent"], "UA");
  assert.equal(seen.options.body, JSON.stringify({
    page: 1,
    size: 1,
    searchParams: {
      userSearchType: 1,
      isAdvSearch: "0",
      selectValue: "qw",
      lib: "cpwsAl_qb",
      sort_field: "",
    },
  }));
});

test("probe rejects a proxy that does not match the session binding", async () => {
  await assert.rejects(
    probeSession(jar, { purpose: "crawl", proxyId: "proxy-b", fetchImpl: async () => { throw new Error("must not fetch"); } }),
    /other than crawl_proxy_id/,
  );
});

test("cross-proxy stays disabled until both probes and small batch pass", () => {
  const identity = { login_proxy_id: "login-a", crawl_proxy_id: "crawl-b" };
  assert.equal(crossProxyDecision(identity, {
    loginProbe: { ok: true },
    crawlProbe: { ok: false },
  }).allowed, false);
  assert.equal(crossProxyDecision(identity, {
    loginProbe: { ok: true },
    crawlProbe: { ok: true },
    smallBatch: { ok: false },
  }).allowed, false);
  assert.equal(crossProxyDecision(identity, {
    loginProbe: { ok: true },
    crawlProbe: { ok: true },
    smallBatch: { ok: true },
  }).allowed, true);
  assert.equal(selectSessionMode(identity, {
    loginProbe: { ok: true },
    crawlProbe: { ok: true },
    smallBatch: { ok: true },
  }).mode, "session_jar");
  assert.equal(selectSessionMode(identity, {
    loginProbe: { ok: false },
    crawlProbe: { ok: true },
  }).mode, "browser_session_host_or_relay");
});

test("session alive on login proxy but dead on crawl proxy escalates to a broker-side mode", () => {
  const base = { login_proxy_id: "login-a", crawl_proxy_id: "crawl-b" };
  const probes = {
    loginProbe: { ok: true, kind: "ok", checked_at: "2026-09-24T00:00:00Z" },
    crawlProbe: { ok: false, kind: "login_required", reason: "source code 401", checked_at: "2026-09-24T00:00:01Z" },
  };

  const relayDecision = selectSessionMode({ ...base }, probes);
  assert.equal(relayDecision.allowed, true);
  assert.equal(relayDecision.mode, "proxy_bound_relay");
  assert.match(relayDecision.reason, /fallback to proxy_bound_relay/);
  assert.equal(relayDecision.probes.crawl.kind, "login_required");
  assert.ok(relayDecision.decided_at);

  const hostDecision = selectSessionMode({ ...base, browser_profile_ref: "legal-auth/x/y" }, probes);
  assert.equal(hostDecision.mode, "browser_session_host");
});

test("a plain session expiry never escalates; both probes failing requires re-login", () => {
  const decision = selectSessionMode(
    { login_proxy_id: "proxy-a", crawl_proxy_id: "proxy-a" },
    {
      loginProbe: { ok: false, kind: "login_required", checked_at: "t" },
      crawlProbe: { ok: false, kind: "login_required", checked_at: "t" },
    },
  );
  assert.equal(decision.allowed, false);
  assert.equal(decision.mode, "session_jar");
});

test("operator-pinned relay and host modes are honored when the binding allows them", () => {
  const sameProxy = { login_proxy_id: "proxy-a", crawl_proxy_id: "proxy-a" };
  const pinnedRelay = selectSessionMode({ ...sameProxy, mode: "proxy_bound_relay" }, {});
  assert.equal(pinnedRelay.allowed, true);
  assert.equal(pinnedRelay.mode, "proxy_bound_relay");
  assert.match(pinnedRelay.reason, /pins proxy_bound_relay/);

  const pinnedHost = selectSessionMode({ ...sameProxy, mode: "browser_session_host" }, {});
  assert.equal(pinnedHost.mode, "browser_session_host");

  const blocked = selectSessionMode(
    { login_proxy_id: "a", crawl_proxy_id: "b", mode: "proxy_bound_relay" },
    { loginProbe: { ok: true }, crawlProbe: { ok: true } },
  );
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.mode, "proxy_bound_relay");
});
