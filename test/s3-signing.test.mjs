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

// getObject's timeout must cover the body read, not just the response
// headers: a half-open RustFS GET used to hang the loader forever.
test("getObject aborts a stalled download and succeeds on retry", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, { signal } = {}) => {
    calls++;
    if (calls > 1) {
      return Promise.resolve({
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode("payload").buffer,
      });
    }
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  try {
    const s3 = createS3({ endpoint: "http://127.0.0.1:9", accessKey: "a", secretKey: "b" });
    const buf = await s3.getObject("b", "k", { timeoutMs: 25, retries: 1 });
    assert.equal(buf.toString("utf8"), "payload");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getObject surfaces a timeout once retries are exhausted", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (url, { signal } = {}) => {
    calls++;
    return new Promise((resolve, reject) => {
      signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  };
  try {
    const s3 = createS3({ endpoint: "http://127.0.0.1:9", accessKey: "a", secretKey: "b" });
    await assert.rejects(s3.getObject("b", "k", { timeoutMs: 20, retries: 1 }), /timed out after 20ms/);
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("getObject does not retry a 4xx response", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return { ok: false, status: 403, text: async () => "denied" };
  };
  try {
    const s3 = createS3({ endpoint: "http://127.0.0.1:9", accessKey: "a", secretKey: "b" });
    await assert.rejects(s3.getObject("b", "k", { timeoutMs: 500, retries: 2 }), /getObject b\/k: 403/);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
