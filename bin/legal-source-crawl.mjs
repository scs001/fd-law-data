#!/usr/bin/env node
// Unified crawl entry for wave-1 legal sources. The crawler writes object
// storage only; it never holds PG credentials.
import { pathToFileURL } from "node:url";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { crawlLegalSource } from "../lib/legal-sources/runtime.js";
import { getSourceAdapter, SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import { withCrawlerIdentity } from "../lib/auth-broker/client.js";
import { createProxyFetch } from "../lib/auth-broker/proxy-fetch.js";

function arg(argv, name, def) {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const value = argv[i + 1];
  return value && !value.startsWith("--") ? value : true;
}

export async function main({ source: defaultSource, argv = [] } = {}) {
  const source = arg(argv, "source", defaultSource);
  if (!source || source === true) {
    throw new Error(`--source is required; known: ${[...SOURCE_ADAPTERS.keys()].join(", ")}`);
  }
  const cfg = loadConfig();
  const adapter = getSourceAdapter(String(source));
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
  const crawlOptions = {
    s3,
    bucket: cfg.lawsBucket,
    source: String(source),
    adapter,
    mode: arg(argv, "full") ? "full" : "incremental",
    filters,
    dryRun,
    rateMs: Number(arg(argv, "rate-ms", adapter.rateMs)),
    partSize: Number(arg(argv, "part-size", 300)),
  };

  const accountId = arg(argv, "account-id") === true ? undefined : arg(argv, "account-id");
  const crawlProxyUrl = process.env.LEGAL_AUTH_CRAWL_PROXY_URL ?? null;
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
