// Dual session source for the legal line (law-auth-session-consumption):
// platform injection (FD_SESSION_JAR inline / FD_SESSION_JAR_PATH file) maps
// onto the existing broker header/cookie/UA consumption path; without it the
// broker lease path is unchanged. Jar fixtures mirror the platform login unit
// output (fd-industry-data spiders/rmfyalk/login.py).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../bin/legal-source-crawl.mjs";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import {
  loadPlatformSessionJar,
  mapPlatformSessionJar,
  PlatformSessionError,
  platformSessionInjection,
  resolveCrawlProxyUrl,
} from "../lib/legal-sources/platform-session.js";

// fd-industry-data runner_cli.py `_AUTH_FAILURE_RE`, lowercased: the crawl
// error head must hit one of these for platform dual-path feedback.
const RUNNER_AUTH_FAILURE_WORDS = [
  "401", "未登录", "login required", "please log in",
  "captcha", "验证码", "登录失效", "session expired",
];

const PLATFORM_JAR = {
  version: 1,
  source: "rmfyalk",
  account_id: "rmfyalk-01",
  mode: "session_jar",
  auth: {
    kind: "header-token",
    headerName: "faxin-cpws-al-token",
    userToken: "platform-user-token",
    raw: { data: { alUser: { userToken: "platform-user-token" } } },
  },
  storageState: {
    cookies: [
      { name: "WZWS_COOKIE", value: "wzws-value", domain: ".court.gov.cn", path: "/" },
      { name: "SESSION", value: "sess-value", domain: "rmfyalk.court.gov.cn", path: "/" },
      { name: "tracker", value: "nope", domain: ".example.com", path: "/" },
    ],
    origins: [{ origin: "https://rmfyalk.court.gov.cn", localStorage: [] }],
  },
  browser: { locale: "zh-CN", timezone: "Asia/Shanghai" },
  captured_at: "2026-10-07T10:00:00+08:00",
};

function tempFile(name, body) {
  const dir = mkdtempSync(join(tmpdir(), "legal-platform-session-"));
  const file = join(dir, name);
  writeFileSync(file, body);
  return file;
}

const MANAGED_ENV = [
  "FD_SESSION_JAR", "FD_SESSION_JAR_PATH", "FD_ACCOUNT", "FD_EGRESS_REF",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy",
  "LEGAL_AUTH_CRAWL_PROXY_URL", "FD_CRAWL_DB_URL",
  "LEGAL_AUTH_BROKER_URL", "LEGAL_AUTH_BROKER_TOKEN", "LEGAL_AUTH_JAR_KEY",
];

async function withEnv(values, fn) {
  const saved = new Map(MANAGED_ENV.map((key) => [key, process.env[key]]));
  for (const key of MANAGED_ENV) delete process.env[key];
  for (const [key, value] of Object.entries(values)) {
    if (value == null) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function quietly(fn) {
  const log = console.log;
  const error = console.error;
  console.log = () => {};
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.log = log;
    console.error = error;
  }
}

test("platform injection is detected from either env form, inline first", () => {
  assert.equal(platformSessionInjection({}), null);
  assert.equal(platformSessionInjection({ FD_SESSION_JAR: "  " }), null);
  assert.deepEqual(
    platformSessionInjection({ FD_SESSION_JAR: "{}" }),
    { kind: "inline", value: "{}" },
  );
  assert.deepEqual(
    platformSessionInjection({ FD_SESSION_JAR_PATH: "/tmp/session-x.json" }),
    { kind: "path", value: "/tmp/session-x.json" },
  );
  assert.deepEqual(
    platformSessionInjection({ FD_SESSION_JAR: "{}", FD_SESSION_JAR_PATH: "/tmp/session-x.json" }),
    { kind: "inline", value: "{}" },
  );
  assert.equal(loadPlatformSessionJar({ env: {} }), null);
});

test("FD_SESSION_JAR_PATH file form loads the same jar schema", () => {
  const file = tempFile("session-rmfyalk-01.json", JSON.stringify(PLATFORM_JAR));
  const jar = loadPlatformSessionJar({ env: { FD_SESSION_JAR_PATH: file } });
  assert.equal(jar.auth.userToken, "platform-user-token");
  const mapped = mapPlatformSessionJar(jar, { source: "rmfyalk-case-library" });
  assert.equal(mapped.headers["faxin-cpws-al-token"], "platform-user-token");
  assert.equal(mapped.headers.cookie, "WZWS_COOKIE=wzws-value; SESSION=sess-value");

  assert.throws(
    () => loadPlatformSessionJar({ env: { FD_SESSION_JAR_PATH: "/no/such/session-jar.json" } }),
    (err) => err instanceof PlatformSessionError && /session jar file is unreadable/.test(err.message),
  );
  assert.throws(
    () => loadPlatformSessionJar({ env: { FD_SESSION_JAR: "{not json" } }),
    (err) => err instanceof PlatformSessionError && /session jar is not valid JSON/.test(err.message),
  );
});

test("platform jar maps token header, court cookies and user-agent variants", () => {
  const camel = mapPlatformSessionJar(PLATFORM_JAR, { source: "rmfyalk-case-library" });
  assert.equal(camel.headers["faxin-cpws-al-token"], "platform-user-token");
  // Only court.gov.cn cookies are joined (same filter as the broker path);
  // the login unit records no userAgent, so the runtime default UA applies.
  assert.equal(camel.headers.cookie, "WZWS_COOKIE=wzws-value; SESSION=sess-value");
  assert.equal("user-agent" in camel.headers, false);
  assert.equal(camel.hasToken, true);
  assert.equal(camel.headerName, "faxin-cpws-al-token");
  assert.match(camel.fingerprint, /^sha256:[0-9a-f]{64}$/);
  // The OAuth raw payload never enters the consumed session structure.
  assert.equal("raw" in camel.session.auth, false);

  /* storage_state / user_agent spelling variant plus an explicit UA. */
  const snake = mapPlatformSessionJar({
    version: 2,
    source: "rmfyalk",
    account_id: "rmfyalk-02",
    mode: "session_jar",
    auth: { header_name: "faxin-cpws-al-token", user_token: "snake-token" },
    storage_state: { cookies: [{ name: "C", value: "v", domain: "court.gov.cn" }] },
    browser: { user_agent: "Mozilla/5.0 platform-jar" },
  }, { source: "rmfyalk-case-library" });
  assert.equal(snake.headers["faxin-cpws-al-token"], "snake-token");
  assert.equal(snake.headers.cookie, "C=v");
  assert.equal(snake.headers["user-agent"], "Mozilla/5.0 platform-jar");

  // A jar without auth.headerName still uses rmfyalk's fixed header.
  const bare = mapPlatformSessionJar({
    version: 1, source: "rmfyalk", auth: { userToken: "t" },
    storageState: { cookies: [] },
  }, { source: "rmfyalk-case-library" });
  assert.equal(bare.headers["faxin-cpws-al-token"], "t");

  // Cookie-only jar (no token) is not treated as empty: it maps cookie + UA and
  // lets the source's own 401/未登录 classification report the auth failure.
  const cookieOnly = mapPlatformSessionJar({
    version: 1, source: "rmfyalk", auth: {},
    storageState: { cookies: [{ name: "WZWS_COOKIE", value: "c", domain: ".court.gov.cn" }] },
    browser: { userAgent: "Mozilla/5.0 cookie-only" },
  }, { source: "rmfyalk-case-library" });
  assert.equal(cookieOnly.headers.cookie, "WZWS_COOKIE=c");
  assert.equal(cookieOnly.headers["user-agent"], "Mozilla/5.0 cookie-only");
  assert.equal(cookieOnly.hasToken, false);
});

test("an empty platform jar fails with a runner-recognizable session error", () => {
  for (const jar of [
    { version: 1, source: "rmfyalk", mode: "session_jar", auth: {}, storageState: { cookies: [] } },
    {},
  ]) {
    assert.throws(
      () => mapPlatformSessionJar(jar, { source: "rmfyalk-case-library" }),
      (err) => {
        assert.equal(err.name, "PlatformSessionError");
        assert.equal(err.code, "EMPTY_PLATFORM_SESSION");
        const head = err.message.toLowerCase();
        assert.match(head, /session/);
        assert.ok(
          RUNNER_AUTH_FAILURE_WORDS.some((word) => head.includes(word)),
          `error head must hit the platform auth word list: ${err.message}`,
        );
        return true;
      },
    );
  }
});

test("crawl proxy resolution prefers standard env, broker variable last", () => {
  assert.equal(resolveCrawlProxyUrl({}), null);
  assert.equal(
    resolveCrawlProxyUrl({
      HTTPS_PROXY: "http://https-exit:1",
      HTTP_PROXY: "http://http-exit:2",
      LEGAL_AUTH_CRAWL_PROXY_URL: "http://broker-exit:3",
    }),
    "http://https-exit:1",
  );
  assert.equal(
    resolveCrawlProxyUrl({
      HTTP_PROXY: "http://http-exit:2",
      LEGAL_AUTH_CRAWL_PROXY_URL: "http://broker-exit:3",
    }),
    "http://http-exit:2",
  );
  assert.equal(
    resolveCrawlProxyUrl({ https_proxy: "http://lower-exit:4" }),
    "http://lower-exit:4",
  );
  assert.equal(
    resolveCrawlProxyUrl({ LEGAL_AUTH_CRAWL_PROXY_URL: "http://broker-exit:3" }),
    "http://broker-exit:3",
  );
});

const TEST_SOURCE = "platform-session-test-source";

function registerFakeAdapter(sink) {
  const adapter = {
    id: TEST_SOURCE,
    mode: "http",
    rateMs: 0,
    requiresProxy: false,
    list: async () => ({ entries: [], total: 0, pages: 0, unreachablePages: [] }),
    detail: async (entry, helpers) => {
      sink.detailCalls++;
      sink.headers = helpers.headers;
      return {
        document: {
          source_id: entry.source_id,
          title: "平台会话单测用例",
          source_url: entry.url,
          content: "正文".repeat(40),
        },
      };
    },
  };
  SOURCE_ADAPTERS.set(TEST_SOURCE, adapter);
  return () => SOURCE_ADAPTERS.delete(TEST_SOURCE);
}

function entriesFile() {
  return tempFile("entries.json", JSON.stringify([
    { source_id: "case-1", url: "https://rmfyalk.court.gov.cn/view/content.html?id=case-1" },
  ]));
}

test("platform injection wins: crawl runs on the injected jar without a broker lease", async () => {
  const sink = { detailCalls: 0 };
  const unregister = registerFakeAdapter(sink);
  try {
    await withEnv({ FD_SESSION_JAR: JSON.stringify(PLATFORM_JAR), FD_ACCOUNT: "rmfyalk-01" }, async () => {
      const result = await quietly(() => main({
        source: TEST_SOURCE,
        argv: [
          "--entries", entriesFile(),
          "--dry-run",
          "--account-id", "broker-only-account",
          "--auth-broker", "http://127.0.0.1:1",
        ],
      }));
      assert.equal(result.records.length, 1);
      assert.equal(sink.detailCalls, 1);
      // The crawl authenticated through the injected jar, not the broker.
      assert.equal(sink.headers["faxin-cpws-al-token"], "platform-user-token");
      assert.equal(sink.headers.cookie, "WZWS_COOKIE=wzws-value; SESSION=sess-value");
      assert.equal(result.manifest.auth.mode, "platform_session_jar");
      assert.equal(result.manifest.auth.account_id, "rmfyalk-01");
      assert.equal(result.manifest.auth.broker, null);
    });
  } finally {
    unregister();
  }
});

test("FD_SESSION_JAR_PATH also selects platform mode end to end", async () => {
  const sink = { detailCalls: 0 };
  const unregister = registerFakeAdapter(sink);
  try {
    const jarFile = tempFile("session-rmfyalk-01.json", JSON.stringify(PLATFORM_JAR));
    await withEnv({ FD_SESSION_JAR_PATH: jarFile, FD_ACCOUNT: "rmfyalk-01" }, async () => {
      const result = await quietly(() => main({
        source: TEST_SOURCE,
        argv: ["--entries", entriesFile(), "--dry-run"],
      }));
      assert.equal(result.records.length, 1);
      assert.equal(sink.headers["faxin-cpws-al-token"], "platform-user-token");
      assert.equal(result.manifest.auth.mode, "platform_session_jar");
    });
  } finally {
    unregister();
  }
});

test("without platform injection the broker lease path is unchanged", async () => {
  const sink = { detailCalls: 0 };
  const unregister = registerFakeAdapter(sink);
  try {
    await withEnv({}, async () => {
      await assert.rejects(
        () => quietly(() => main({
          source: TEST_SOURCE,
          argv: ["--entries", entriesFile(), "--dry-run", "--account-id", "acct001", "--auth-broker", "http://127.0.0.1:1"],
        })),
        /Auth Broker request failed|BROKER_UNREACHABLE/,
      );
      assert.equal(sink.detailCalls, 0);
    });
  } finally {
    unregister();
  }
});

test("an empty injected jar stops the run before any request", async () => {
  const sink = { detailCalls: 0 };
  const unregister = registerFakeAdapter(sink);
  try {
    await withEnv({
      FD_SESSION_JAR: JSON.stringify({ version: 1, source: "rmfyalk", auth: {}, storageState: { cookies: [] } }),
      FD_ACCOUNT: "rmfyalk-01",
    }, async () => {
      await assert.rejects(
        () => quietly(() => main({ source: TEST_SOURCE, argv: ["--entries", entriesFile(), "--dry-run"] })),
        (err) => {
          assert.equal(err.code, "EMPTY_PLATFORM_SESSION");
          assert.match(err.message.toLowerCase(), /session/);
          assert.ok(RUNNER_AUTH_FAILURE_WORDS.some((word) => err.message.toLowerCase().includes(word)));
          return true;
        },
      );
      assert.equal(sink.detailCalls, 0);
    });
  } finally {
    unregister();
  }
});