#!/usr/bin/env node
// Coverage report for all wave-1 legal sources. Reads the laws bucket only;
// it never contacts PG or any upstream site.
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { coverageReport } from "../lib/legal-sources/coverage.js";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";

const cfg = loadConfig();
const s3 = createS3({
  endpoint: cfg.s3Endpoint,
  accessKey: cfg.s3AccessKey,
  secretKey: cfg.s3SecretKey,
  region: cfg.s3Region,
});
const report = await coverageReport(s3, cfg.lawsBucket, [...SOURCE_ADAPTERS.keys()]);
console.log(JSON.stringify(report, null, 1));
if (report.incomplete.length) process.exitCode = 2;
