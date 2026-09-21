#!/usr/bin/env node
// Incremental embed worker: incr-manifest.json shards -> SiliconFlow
// Qwen3-Embedding (same call as the historical corpus) -> Qdrant
// law_chunks_v2. Credentials via env/.env only; this entry point never
// touches PostgreSQL.
import os from "node:os";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { createEmbedder } from "../lib/embed/siliconflow.js";
import { createQdrant } from "../lib/embed/qdrant.js";
import { selfCheck, runEmbedJob } from "../lib/embed/worker.js";

const cfg = loadConfig();
if (!cfg.embedApiKey) {
  console.error("[flk-embed] EMBED_API_KEY is not set (env/.env only; never in code)");
  process.exit(2);
}

const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const embedder = createEmbedder({ endpoint: cfg.embedEndpoint, apiKey: cfg.embedApiKey, model: cfg.embedModel, log: console.error });
const qdrant = createQdrant({ url: cfg.qdrantUrl, collection: cfg.qdrantCollection });

const check = await selfCheck({ s3, bucket: cfg.exportBucket, embedder, qdrant });
console.error(`[flk-embed] self-check ok: probe point ${check.probe}, dim ${check.dim}, cosine ${check.cosine.toFixed(6)}`);

const stats = await runEmbedJob({
  s3,
  embedder,
  qdrant,
  bucket: cfg.exportBucket,
  worker: process.env.EMBED_WORKER ?? `flk-embed-${os.hostname()}`,
  log: console.error,
});
console.log(JSON.stringify({ mode: "embed", ...stats }));
