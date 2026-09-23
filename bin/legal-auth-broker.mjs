#!/usr/bin/env node
// Auth Broker operator/service entry. `serve` is the crawler-facing lease API;
// `login` starts an isolated headed Chromium and records the upstream session.
// noVNC is provided by the container entrypoint and must be reached only via
// kubectl port-forward, Tailscale or an authenticated internal ingress.
import pg from "pg";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { createPgIdentityOperations, startAuthBrokerServer } from "../lib/auth-broker/service.js";
import { createS3SessionStore } from "../lib/auth-broker/s3-session-store.js";
import {
  encryptSessionJar,
  redactSessionJar,
  validateSessionJar,
} from "../lib/auth-broker/session-jar.js";
import { probeSession } from "../lib/auth-broker/proxy.js";
import { launchIdentityBrowser, captureBrowserState } from "../lib/auth-broker/browser-profile.js";
import { captureRmfyalkSession } from "../lib/auth-broker/logins/rmfyalk.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const value = process.argv[i + 1];
  return value && !value.startsWith("--") ? value : true;
}

function printSafe(label, value) {
  console.log(JSON.stringify({ [label]: redactSessionJar(value) }, null, 1));
}

async function openPg() {
  const cfg = loadConfig();
  const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port) });
  await client.connect();
  return client;
}

function s3FromEnv() {
  const cfg = loadConfig();
  return createS3({
    endpoint: cfg.s3Endpoint,
    accessKey: cfg.s3AccessKey,
    secretKey: cfg.s3SecretKey,
    region: cfg.s3Region,
  });
}

async function commandServe() {
  const client = await openPg();
  const operations = createPgIdentityOperations(client);
  await operations.ensureSchema();
  const store = createS3SessionStore({ s3: s3FromEnv(), bucket: loadConfig().lawsBucket });
  const port = Number(arg("port", process.env.LEGAL_AUTH_BROKER_PORT ?? 8787));
  const host = arg("host", process.env.LEGAL_AUTH_BROKER_HOST ?? "127.0.0.1");
  if (!process.env.LEGAL_AUTH_BROKER_TOKEN) {
    throw new Error("LEGAL_AUTH_BROKER_TOKEN is required");
  }
  const server = await startAuthBrokerServer({
    operations,
    sessionStore: store,
    brokerToken: process.env.LEGAL_AUTH_BROKER_TOKEN,
    log: (event) => console.error(JSON.stringify(event)),
  }, { host, port });
  console.log(JSON.stringify({ serving: true, host, port }, null, 1));
  const shutdown = async () => {
    await new Promise((resolve) => server.close(resolve));
    await client.end().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

async function commandLogin() {
  const source = arg("source");
  const accountId = arg("account-id");
  if (!source || source === true) throw new Error("--source is required");
  if (!accountId || accountId === true) throw new Error("--account-id is required");
  const loginProxyUrl = process.env.LEGAL_AUTH_LOGIN_PROXY_URL ?? null;
  const crawlProxyUrl = process.env.LEGAL_AUTH_CRAWL_PROXY_URL ?? loginProxyUrl;
  if (process.env.REQUIRE_LOGIN_PROXY === "1" && !loginProxyUrl) {
    throw new Error("REQUIRE_LOGIN_PROXY=1 but LEGAL_AUTH_LOGIN_PROXY_URL is unset");
  }
  const client = await openPg();
  const operations = createPgIdentityOperations(client);
  await operations.ensureSchema();
  const registered = await operations.upsertIdentity({
    source,
    account_id: accountId,
    login_proxy_id: process.env.LEGAL_AUTH_LOGIN_PROXY_ID ?? null,
    crawl_proxy_id: process.env.LEGAL_AUTH_CRAWL_PROXY_ID ?? process.env.LEGAL_AUTH_LOGIN_PROXY_ID ?? null,
    user_agent: process.env.LEGAL_AUTH_USER_AGENT ?? null,
    viewport: process.env.LEGAL_AUTH_VIEWPORT ? JSON.parse(process.env.LEGAL_AUTH_VIEWPORT) : undefined,
    locale: process.env.LEGAL_AUTH_LOCALE ?? undefined,
    timezone: process.env.LEGAL_AUTH_TIMEZONE ?? undefined,
  }, { actor: "operator-login" });
  const identity = registered.identity;
  const context = await launchIdentityBrowser({
    source,
    accountId,
    user_agent: identity.user_agent,
    viewport: identity.viewport,
    locale: identity.locale,
    timezone: identity.timezone,
    login_proxy_url: loginProxyUrl,
    requires_login_proxy: process.env.REQUIRE_LOGIN_PROXY === "1",
  }, { headless: Boolean(arg("headless", false)) });

  try {
    let jar;
    if (source === "rmfyalk-case-library") {
      jar = await captureRmfyalkSession({
        identity: {
          accountId,
          login_proxy_id: identity.login_proxy_id,
          crawl_proxy_id: identity.crawl_proxy_id,
        },
        context,
        timeoutMs: Number(arg("timeout-ms", 10 * 60 * 1000)),
      });
    } else {
      throw new Error(`no Auth Broker login adapter for source: ${source}`);
    }

    const loginProbe = await probeSession(jar, {
      purpose: "crawl",
      proxyId: jar.proxy.crawl_proxy_id,
      fetchImpl: globalThis.fetch,
    });
    jar.probe = { crawl_proxy: loginProbe };
    validateSessionJar(jar);

    const store = createS3SessionStore({ s3: s3FromEnv(), bucket: loadConfig().lawsBucket });
    const envelope = encryptSessionJar(jar, process.env.LEGAL_AUTH_JAR_KEY);
    await store.put(envelope);
    const updated = await operations.upsertIdentity({
      source,
      account_id: accountId,
      status: loginProbe.ok ? "active" : "login_required",
      session_ref: store.keyFor(source, accountId),
      last_login_at: new Date().toISOString(),
      last_probe_at: new Date().toISOString(),
      crawl_proxy_probe_at: loginProbe.ok ? new Date().toISOString() : undefined,
      crawl_proxy_result: loginProbe,
      user_agent: jar.browser.userAgent,
      viewport: jar.browser.viewport,
      locale: jar.browser.locale,
      timezone: jar.browser.timezone,
    }, { actor: "operator-login" });
    printSafe("login", {
      source,
      account_id: accountId,
      ok: loginProbe.ok,
      probe: loginProbe,
      identity: updated.identity,
      session_object: store.keyFor(source, accountId),
    });
    if (!loginProbe.ok) process.exitCode = 42;
  } finally {
    await context.close().catch(() => {});
    await client.end().catch(() => {});
  }
}

async function commandProbe() {
  const source = arg("source");
  const accountId = arg("account-id");
  if (!source || source === true || !accountId || accountId === true) {
    throw new Error("--source and --account-id are required");
  }
  const store = createS3SessionStore({ s3: s3FromEnv(), bucket: loadConfig().lawsBucket });
  const stored = await store.get({ source, accountId });
  if (!stored) throw new Error("no stored session envelope");
  const { decryptSessionJar } = await import("../lib/auth-broker/session-jar.js");
  const jar = decryptSessionJar(stored.envelope, process.env.LEGAL_AUTH_JAR_KEY);
  const probe = await probeSession(jar, {
    purpose: arg("purpose", "crawl"),
    proxyId: arg("purpose", "crawl") === "login" ? jar.proxy.login_proxy_id : jar.proxy.crawl_proxy_id,
  });
  printSafe("probe", { source, account_id: accountId, probe });
  if (!probe.ok) process.exitCode = 42;
}

const command = process.argv[2];
try {
  if (command === "serve") await commandServe();
  else if (command === "login") await commandLogin();
  else if (command === "probe") await commandProbe();
  else {
    console.error("usage: legal-auth-broker.mjs <serve|login|probe> [options]");
    process.exitCode = command ? 2 : 0;
  }
} catch (err) {
  console.error(`[legal-auth-broker] ${err.code ?? "ERROR"}: ${err.message}`);
  process.exitCode = 1;
}
