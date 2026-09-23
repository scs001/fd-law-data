import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  AUTH_HEADER_NAME,
  captureRmfyalkSession,
  extractOAuthCallback,
  parseLoginGdResponse,
} from "../lib/auth-broker/logins/rmfyalk.js";

function fakePage({ callbackUrl, payload }) {
  const page = new EventEmitter();
  page.url = () => callbackUrl;
  page.goto = async () => {
    process.nextTick(() => {
      page.emit("response", {
        url: () => `https://rmfyalk.court.gov.cn/cpws_al_api/api/user/loginGd?ignored=1`,
        json: async () => payload,
      });
    });
  };
  page.close = async () => {};
  page.evaluate = async (expression) => {
    const source = typeof expression === "function" ? expression.toString() : String(expression);
    if (source.includes("userAgent")) return "Test UA";
    if (source.includes("language")) return "zh-CN";
    return null;
  };
  return page;
}

function fakeContext(page) {
  return {
    viewportSize: () => ({ width: 1440, height: 900 }),
    newPage: async () => page,
    storageState: async () => ({
      cookies: [{ name: "WZWS_COOKIE", value: "secret", domain: ".court.gov.cn", path: "/" }],
      origins: [],
    }),
    pages: () => [page],
  };
}

const identity = {
  accountId: "acct001",
  login_proxy_id: "proxy-a",
  crawl_proxy_id: "proxy-a",
  login_exit_ip: "192.0.2.10",
  crawl_exit_ip: "192.0.2.10",
};

test("extracts OAuth code, state and mClient from the callback URL", () => {
  const callback = extractOAuthCallback("https://rmfyalk.court.gov.cn/?code=abc&state=xyz_pc");
  assert.deepEqual(callback, { code: "abc", state: "xyz_pc", mClient: "pc" });
  assert.equal(extractOAuthCallback("https://rmfyalk.court.gov.cn/"), null);
});

test("accepts only a successful loginGd response carrying the header token", () => {
  const parsed = parseLoginGdResponse({
    code: "0",
    data: { alUser: { userToken: "secret", realName: "张三" } },
  });
  assert.equal(parsed.userToken, "secret");
  assert.throws(() => parseLoginGdResponse({ code: "401" }), /rmfyalk loginGd rejected/);
});

test("records the browser loginGd response into a validated session jar", async () => {
  const callbackUrl = "https://rmfyalk.court.gov.cn/?code=abc&state=xyz_pc";
  const page = fakePage({
    callbackUrl,
    payload: { code: "0", data: { alUser: { userToken: "secret", realName: "张三" } } },
  });
  const context = fakeContext(page);
  let loginUrlRequested = false;
  const jar = await captureRmfyalkSession({
    identity,
    context,
    pollMs: 1,
    fetchImpl: async (url) => {
      loginUrlRequested = url.includes("getGdLoginUrl");
      if (!loginUrlRequested) throw new Error("unexpected fetch");
      return {
        ok: true,
        text: async () => JSON.stringify({ code: "0", data: "http://account.court.gov.cn/oauth/authorize?x=1" }),
      };
    },
  });
  assert.ok(loginUrlRequested);
  assert.equal(jar.source, "rmfyalk-case-library");
  assert.equal(jar.account_id, "acct001");
  assert.equal(jar.auth.headerName, AUTH_HEADER_NAME);
  assert.equal(jar.auth.userToken, "secret");
  assert.equal(jar.proxy.login_proxy_id, "proxy-a");
  assert.equal(jar.proxy.crawl_proxy_id, "proxy-a");
  assert.equal(jar.browser.userAgent, "Test UA");
  assert.equal(jar.storageState.cookies[0].name, "WZWS_COOKIE");
});

test("does not accept a session when loginGd rejects", async () => {
  const page = fakePage({
    callbackUrl: "https://rmfyalk.court.gov.cn/?code=abc&state=xyz_pc",
    payload: { code: "401", msg: "未登录" },
  });
  await assert.rejects(
    captureRmfyalkSession({
      identity,
      context: fakeContext(page),
      pollMs: 1,
      fetchImpl: async () => ({
        ok: true,
        text: async () => JSON.stringify({ code: "0", data: "https://account.example/oauth" }),
      }),
    }),
    /rmfyalk loginGd rejected/,
  );
});
