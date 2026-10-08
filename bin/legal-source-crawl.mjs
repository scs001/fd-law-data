#!/usr/bin/env node
// Unified crawl entry for wave-1 legal sources. The crawler writes object
// storage only; it never holds PG credentials.
import { existsSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { crawlLegalSource, parseEntriesOverride } from "../lib/legal-sources/runtime.js";
import { getSourceAdapter, SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import { withCrawlerIdentity } from "../lib/auth-broker/client.js";
import { createProxyFetch } from "../lib/auth-broker/proxy-fetch.js";
import {
  loadPlatformSessionJar,
  mapPlatformSessionJar,
  platformSessionInjection,
  resolveCrawlProxyUrl,
} from "../lib/legal-sources/platform-session.js";
import { errorHead, finishRun, startRun, telemetrySourceName } from "../lib/telemetry.mjs";

function arg(argv, name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : true;
}

// --entries accepts either an inline comma-separated source-id list or a file
// (an existing path) holding that list or a JSON/JSONL document of full
// entries. A path-looking value that is not there fails loudly instead of
// being mistaken for an id. Exported for tests.
export function readEntriesSpec(value) {
  if (value === true) throw new Error("--entries requires a file path or comma-separated source ids");
  const spec = String(value);
  if (existsSync(spec)) return readFileSync(spec, "utf8");
  if (/[/\\]/.test(spec) && !spec.includes(",")) throw new Error(`--entries file not found: ${spec}`);
  return spec;
}

export async function main({ source: defaultSource, argv = [] } = {}) {
  const source = arg(argv, "source", defaultSource);
  if (!source || source === true) {
    throw new Error(`--source is required; known: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`);
  }
  const adapter = getSourceAdapter(String(source));
  // Federation telemetry: report under the CronJob name, not the library id.
  // startRun/finishRun never throw, so the crawl's exit code is untouched.
  // The platform dispatcher injects FD_ACCOUNT — carry it into the crawl_runs
  // row so runs are traceable to the leased identity (task 5.2 acceptance).
  const identityAlias = process.env.FD_ACCOUNT ?? null;
  const runId = await startRun({
    source: telemetrySourceName(source, "crawl"),
    identityAlias,
  });
  try {
    const result = await runCrawl({ source: String(source), adapter, argv });
    await finishRun(runId, {
      status: "success",
      // rows_written for a crawl = emitted snapshot entries (unique records
      // this run fetched and wrote to the structured prefix).
      rowsWritten: result.records.length,
    });
    return result;
  } catch (err) {
    await finishRun(runId, { status: "failed", rowsWritten: 0, errorHead: errorHead(err) });
    throw err;
  }
}

async function runCrawl({ source, adapter, argv }) {
  const cfg = loadConfig();
  const dryRun = !!arg(argv, "dry-run");
  const s3 = dryRun
    ? { getObject: async () => null, putObject: async () => ({}) }
    : createS3({
        endpoint: cfg.s3Endpoint,
        accessKey: cfg.s3AccessKey,
        secretKey: cfg.s3SecretKey,
        region: cfg.s3Region,
      });
  const filters = {
    scope: arg(argv, "scope") === true ? undefined : arg(argv, "scope"),
    category: arg(argv, "category") === true ? undefined : arg(argv, "category"),
    size: Number(arg(argv, "size", 10)),
    maxPages: Number(arg(argv, "max-pages", 1000)),
  };
  // --entries targets specific source_ids (or full entries from a file): the
  // list phase is skipped entirely and the run uses full semantics, so an
  // unchanged hash can never suppress the write. Manifest / state.json /
  // telemetry stay the same path as any other crawl.
  const entriesValue = arg(argv, "entries");
  const entries = entriesValue === undefined
    ? null
    : parseEntriesOverride(readEntriesSpec(entriesValue), adapter);
  if (entries) {
    console.error(`[${source}] --entries override: ${entries.length} entr(y|ies), full semantics (list phase skipped)`);
  }
  const crawlOptions = {
    s3,
    bucket: cfg.lawsBucket,
    source: String(source),
    adapter,
    mode: entries || arg(argv, "full") ? "full" : "incremental",
    entries,
    filters,
    dryRun,
    rateMs: Number(arg(argv, "rate-ms", adapter.rateMs)),
    partSize: Number(arg(argv, "part-size", 300)),
  };

  const accountId = arg(argv, "account-id") === true ? undefined : arg(argv, "account-id");
  // Egress priority: the platform dispatcher injects the leased identity's
  // exit as standard proxy env (curl-native via createProxyFetch); the
  // broker-era variable stays as the fallback so a fallback run is unchanged.
  const crawlProxyUrl = resolveCrawlProxyUrl(process.env);
  // Dual session source (law-auth-session-consumption): platform injection
  // (inline FD_SESSION_JAR / file FD_SESSION_JAR_PATH) wins and never requests
  // a broker lease; without it the broker path below is unchanged.
  if (platformSessionInjection(process.env)) {
    return runPlatformSessionCrawl({ source, crawlOptions, crawlProxyUrl, accountId, dryRun });
  }
  if (!accountId) {
    const result = await crawlLegalSource(crawlOptions);
    console.log(JSON.stringify({
      mode: dryRun ? "dry-run" : "crawl",
      manifest: result.manifest,
      emitted: result.records.length,
    }, null, 1));
    return result;
  }

  const result = await withCrawlerIdentity({
    brokerUrl: arg(argv, "auth-broker") === true
      ? process.env.LEGAL_AUTH_BROKER_URL
      : arg(argv, "auth-broker"),
    brokerToken: process.env.LEGAL_AUTH_BROKER_TOKEN,
    source: String(source),
    accountId,
    owner: `legal-source-crawl:${process.pid}`,
    ttlMs: Number(arg(argv, "lease-ttl-ms", 30 * 60 * 1000)),
    jarKey: process.env.LEGAL_AUTH_JAR_KEY,
    crawlProxyUrl,
    fetchImpl: createProxyFetch(crawlProxyUrl),
    work: async ({ session, identity, mode, headers, probe }) => {
      const crawl = await crawlLegalSource({
        ...crawlOptions,
        authHeaders: headers,
        fetchImpl: createProxyFetch(crawlProxyUrl),
        auth: {
          broker: arg(argv, "auth-broker") === true
            ? process.env.LEGAL_AUTH_BROKER_URL
            : arg(argv, "auth-broker"),
          accountId,
          mode,
          fingerprint: session.fingerprint ?? session.browser ?? null,
          probe,
        },
      });
      return crawl;
    },
  });
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run" : "crawl",
    manifest: result.manifest,
    emitted: result.records.length,
  }, null, 1));
  return result;
}

// Platform mode: map the injected jar onto the existing auth-header structure
// (authHeadersFromSessionJar via platform-session.js) and run the same crawl
// runtime over the platform egress. No broker lease is acquired or released.
async function runPlatformSessionCrawl({ source, crawlOptions, crawlProxyUrl, accountId, dryRun }) {
  const jar = loadPlatformSessionJar({ env: process.env });
  const mapped = mapPlatformSessionJar(jar, { source: String(source) });
  const identityAlias = process.env.FD_ACCOUNT ?? (typeof accountId === "string" ? accountId : null);
  console.error(
    `[${source}] platform session mode: account=${identityAlias ?? "unknown"} `
    + `egress=${process.env.FD_EGRESS_REF ?? (crawlProxyUrl ? "standard proxy env" : "direct")}`,
  );
  const result = await crawlLegalSource({
    ...crawlOptions,
    authHeaders: mapped.headers,
    fetchImpl: createProxyFetch(crawlProxyUrl),
    auth: {
      broker: null,
      accountId: identityAlias,
      mode: "platform_session_jar",
      fingerprint: mapped.fingerprint,
      probe: null,
    },
  });
  console.log(JSON.stringify({
    mode: dryRun ? "dry-run" : "crawl",
    manifest: result.manifest,
    emitted: result.records.length,
  }, null, 1));
  return result;
}

function invokedDirectly() {
  const entry = process.argv[1];
  return entry && import.meta.url === pathToFileURL(entry).href;
}

if (invokedDirectly()) {
  try {
    await main({ argv: process.argv.slice(2) });
  } catch (err) {
    console.error(`[legal-source-crawl] FATAL: ${err?.stack ?? err}`);
    process.exitCode = 1;
  }
}
