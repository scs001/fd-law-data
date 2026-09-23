import test from "node:test";
import assert from "node:assert/strict";
import {
  assertProfileIsolation,
  contextOptions,
  profileDirectory,
} from "../lib/auth-broker/browser-profile.js";

const left = { source: "rmfyalk-case-library", accountId: "acct001" };
const right = { source: "rmfyalk-case-library", accountId: "acct002" };
const otherSource = { source: "another-source", accountId: "acct001" };

test("profiles are isolated by both source and account id", () => {
  const a = profileDirectory(left, { root: "/tmp/profile-root" });
  const b = profileDirectory(right, { root: "/tmp/profile-root" });
  const c = profileDirectory(otherSource, { root: "/tmp/profile-root" });
  assert.notEqual(a, b);
  assert.notEqual(a, c);
  assert.equal(assertProfileIsolation(left, right, { root: "/tmp/profile-root" }).a, a);
  assert.throws(() => assertProfileIsolation(left, { source: left.source, accountId: left.accountId }));
});

test("malicious account ids cannot traverse out of the profile root", () => {
  const directory = profileDirectory(
    { source: "../evil", accountId: "../../etc/passwd" },
    { root: "/tmp/profile-root" },
  );
  assert.match(directory, /^\/tmp\/profile-root\/[^/]+\/[^/]+$/);
  assert.ok(!directory.includes("../"));
});

test("context options bind proxy, locale, timezone and viewport per identity", () => {
  const options = contextOptions({
    ...left,
    login_proxy_url: "http://proxy-a:8080",
    user_agent: "UA-1",
    viewport: { width: 1280, height: 800 },
    locale: "zh-CN",
    timezone: "Asia/Shanghai",
  }, { headless: false });
  assert.equal(options.proxy.server, "http://proxy-a:8080");
  assert.equal(options.userAgent, "UA-1");
  assert.equal(options.locale, "zh-CN");
  assert.equal(options.timezoneId, "Asia/Shanghai");
  assert.deepEqual(options.viewport, { width: 1280, height: 800 });
});

test("a required login proxy fails loudly before browser launch", () => {
  assert.throws(
    () => contextOptions({ ...left, requires_login_proxy: true }),
    (err) => err.code === "LOGIN_PROXY_REQUIRED",
  );
});
