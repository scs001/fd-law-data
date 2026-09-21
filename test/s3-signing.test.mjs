import test from "node:test";
import assert from "node:assert/strict";
import { createS3, putIfChanged } from "../lib/s3.js";

// Optional live check: set RUSTFS_SMOKE=1 with real .env creds to verify
// SigV4 signing against the actual RustFS (read-only listBuckets).
test("s3 client rejects missing credentials", () => {
  assert.throws(() => createS3({ endpoint: undefined, accessKey: "a", secretKey: "b" }));
});

test("putIfChanged skips when content-length matches", async (t) => {
  let putCalls = 0;
  const fakeS3 = {
    headObject: async (bucket, key) => ({ contentLength: 11 }),
    putObject: async () => {
      putCalls++;
      return {};
    },
  };
  const res = await putIfChanged(fakeS3, "b", "k", "hello world");
  assert.equal(res.skipped, true);
  assert.equal(putCalls, 0);
  const res2 = await putIfChanged(fakeS3, "b", "k", "different!");
  assert.equal(res2.skipped, false);
  assert.equal(putCalls, 1);
});

test("live SigV4 smoke (RUSTFS_SMOKE=1)", async (t) => {
  if (!process.env.RUSTFS_SMOKE) return t.skip("set RUSTFS_SMOKE=1 with real .env to run");
  const { loadConfig } = await import("../lib/config.js");
  const cfg = loadConfig();
  const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
  const buckets = await s3.listBuckets();
  assert.ok(Array.isArray(buckets));
  console.log("buckets:", buckets.join(", "));
});
