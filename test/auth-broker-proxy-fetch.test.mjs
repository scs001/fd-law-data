import test from "node:test";
import assert from "node:assert/strict";
import { createProxyFetch } from "../lib/auth-broker/proxy-fetch.js";

test("proxy fetch falls back to global fetch when no proxy is configured", () => {
  assert.equal(createProxyFetch(null), globalThis.fetch);
});

test("proxy fetch creates a distinct function for a bound egress", () => {
  const proxied = createProxyFetch("http://user:pass@127.0.0.1:9");
  assert.equal(typeof proxied, "function");
  assert.notEqual(proxied, globalThis.fetch);
});
