import test from "node:test";
import assert from "node:assert/strict";
import {
  KIND,
  SOURCE_CRONJOBS,
  createTelemetry,
  errorHead,
  finishRun,
  startRun,
  telemetrySourceName,
} from "../lib/telemetry.mjs";
import { SOURCE_ADAPTERS } from "../lib/legal-sources/sources/index.js";
import { effectiveBodyStats } from "../lib/legal-sources/document-loader.js";

// Fake pg client factory: records every statement, never touches a socket.
// `connectFailures` makes the first N connects throw, exercising the retry-
// then-release path. All telemetry calls must stay failure-safe over this.
function fakeClientFactory({ connectFailures = 0, runId = 42 } = {}) {
  const calls = { created: 0, connected: 0, queries: [] };
  const factory = (url) => {
    calls.created++;
    calls.url = url;
    return {
      async connect() {
        calls.connected++;
        if (calls.connected <= connectFailures) throw new Error(`connect refused ${calls.connected}`);
      },
      async query(sql, params = []) {
        const entry = { sql: sql.replace(/\s+/g, " ").trim(), params };
        calls.queries.push(entry);
        if (entry.sql.startsWith("CREATE TABLE") || entry.sql.startsWith("ALTER TABLE") || entry.sql.startsWith("CREATE INDEX")) {
          return { rows: [] };
        }
        if (entry.sql.startsWith("INSERT INTO crawl_runs")) return { rows: [{ id: runId }] };
        return { rows: [], rowCount: 1 };
      },
      async end() {
        calls.ended = (calls.ended ?? 0) + 1;
      },
    };
  };
  factory.calls = calls;
  return factory;
}

test("telemetry is a full no-op without FD_CRAWL_DB_URL (one stderr notice, zero side effects)", async () => {
  const lines = [];
  const clients = fakeClientFactory();
  const t = createTelemetry({ url: "", clientFactory: clients, stderr: (l) => lines.push(l), sleep: async () => {} });
  const id = await t.startRun({ source: "mfa-treaty-crawl" });
  const closed = await t.finishRun(id, { status: "success", rowsWritten: 3 });
  const reported = await t.reportRun({ source: "mfa-treaty-crawl", status: "failed", rowsWritten: 0, errorHead: "boom" });
  assert.equal(id, null);
  assert.equal(closed, false);
  assert.equal(reported, false);
  assert.equal(clients.calls.created, 0, "no client may be built when disabled");
  assert.deepEqual(lines, ["[telemetry] FD_CRAWL_DB_URL not set; run reporting disabled (no-op)"]);
});

test("startRun inserts a running row and returns its id; finishRun closes it with output and metrics", async () => {
  const lines = [];
  const clients = fakeClientFactory();
  const t = createTelemetry({
    url: "postgresql://telemetry:test@127.0.0.1:1/fd_open_data",
    clientFactory: clients,
    stderr: (l) => lines.push(l),
    sleep: async () => {},
    imageTag: "sha-abc1234",
    commitSha: "deadbeef",
  });
  const id = await t.startRun({ source: "mfa-treaty-crawl" });
  assert.equal(id, 42);
  const insert = clients.calls.queries.find((q) => q.sql.startsWith("INSERT INTO crawl_runs"));
  assert.match(insert.sql, /'running'/);
  assert.match(insert.sql, /RETURNING id/);
  assert.deepEqual(insert.params, ["mfa-treaty-crawl", "federation", "deadbeef", "sha-abc1234", null, null]);
  assert.equal(clients.calls.url, "postgresql://telemetry:test@127.0.0.1:1/fd_open_data");

  const closed = await t.finishRun(id, {
    status: "success",
    rowsWritten: 7,
    metrics: { effective_body_ratio: 0.9812, coverage_count: 120 },
  });
  assert.equal(closed, true);
  const update = clients.calls.queries.find((q) => q.sql.startsWith("UPDATE crawl_runs"));
  assert.match(update.sql, /finished_at = now\(\)/);
  assert.match(update.sql, /metrics = \$4::jsonb/);
  assert.equal(update.params[0], "success");
  assert.equal(update.params[1], 7);
  assert.equal(update.params[2], null);
  assert.equal(update.params[3], JSON.stringify({ effective_body_ratio: 0.9812, coverage_count: 120 }));
  assert.equal(update.params[4], 42);
  assert.deepEqual(lines, []);
  assert.equal(clients.calls.ended, clients.calls.created, "every opened client is closed");
});

test("image_tag falls back to FD_RUNNER_IMAGE_TAG then the package version", async () => {
  const clients = fakeClientFactory();
  const t = createTelemetry({ url: "postgresql://t@127.0.0.1:1/x", clientFactory: clients, sleep: async () => {} });
  const previous = process.env.FD_RUNNER_IMAGE_TAG;
  try {
    process.env.FD_RUNNER_IMAGE_TAG = "sha-envtag";
    await t.startRun({ source: "gov-rules-crawl" });
    assert.equal(clients.calls.queries.at(-1).params[3], "sha-envtag");
    delete process.env.FD_RUNNER_IMAGE_TAG;
    await t.startRun({ source: "gov-rules-crawl" });
    assert.equal(clients.calls.queries.at(-1).params[3], "0.1.0");
    await t.startRun({ source: "gov-rules-crawl", imageTag: "sha-explicit" });
    assert.equal(clients.calls.queries.at(-1).params[3], "sha-explicit");
  } finally {
    if (previous === undefined) delete process.env.FD_RUNNER_IMAGE_TAG;
    else process.env.FD_RUNNER_IMAGE_TAG = previous;
  }
});

test("connection failures are retried twice, then the run id releases as null without throwing", async () => {
  const lines = [];
  const sleeps = [];
  const clients = fakeClientFactory({ connectFailures: 2 });
  const t = createTelemetry({
    url: "postgresql://t@127.0.0.1:1/x",
    clientFactory: clients,
    stderr: (l) => lines.push(l),
    sleep: async (ms) => sleeps.push(ms),
  });
  const id = await t.startRun({ source: "party-regulation-crawl" });
  assert.equal(id, 42, "third attempt lands the running row");
  assert.equal(clients.calls.created, 3, "initial attempt + 2 retries");
  assert.deepEqual(sleeps, [500, 1000]);
  assert.equal(lines.filter((l) => l.includes("attempt")).length, 2, "each failure leaves one stderr trace");

  const dead = fakeClientFactory({ connectFailures: 99 });
  const t2 = createTelemetry({
    url: "postgresql://t@127.0.0.1:1/x",
    clientFactory: dead,
    stderr: (l) => lines.push(l),
    sleep: async () => {},
  });
  assert.equal(await t2.startRun({ source: "party-regulation-crawl" }), null);
  assert.equal(dead.calls.created, 3);
  assert.equal(await t2.finishRun(7, { status: "failed", errorHead: "boom" }), false);
  assert.equal(dead.calls.created, 6, "finishRun also spent its own 3 attempts, all released");
  assert.ok(lines.some((l) => l.includes("start_run(party-regulation-crawl) released")));
  assert.ok(lines.some((l) => l.includes("finish_run(7) released")));
});

test("finishRun serializes metrics to jsonb and drops non-serializable metrics without failing", async () => {
  const lines = [];
  const clients = fakeClientFactory();
  const t = createTelemetry({ url: "postgresql://t@127.0.0.1:1/x", clientFactory: clients, stderr: (l) => lines.push(l), sleep: async () => {} });
  await t.finishRun(9, { status: "success", rowsWritten: 2, metrics: { coverage_count: 2, nested: { ok: true } } });
  let update = clients.calls.queries.find((q) => q.sql.startsWith("UPDATE crawl_runs"));
  assert.equal(update.params[3], JSON.stringify({ coverage_count: 2, nested: { ok: true } }));

  const circular = {};
  circular.self = circular;
  await t.finishRun(9, { status: "success", metrics: circular });
  update = clients.calls.queries.at(-1);
  assert.equal(update.params[3], null, "unserializable metrics become null, not an error");
  assert.ok(lines.some((l) => l.includes("metrics dropped")));
});

test("reportRun inserts a complete one-shot row", async () => {
  const clients = fakeClientFactory();
  const t = createTelemetry({ url: "postgresql://t@127.0.0.1:1/x", clientFactory: clients, sleep: async () => {}, imageTag: "sha-x" });
  const started = new Date("2026-10-07T03:00:00Z");
  const id = await t.reportRun({
    source: "flk-law-crawl",
    status: "failed",
    startedAt: started,
    rowsWritten: 0,
    errorHead: "HTTP 403 for https://flk.npc.gov.cn",
    metrics: { coverage_count: 0 },
  });
  assert.equal(id, 42);
  const insert = clients.calls.queries.find((q) => q.sql.startsWith("INSERT INTO crawl_runs"));
  assert.match(insert.sql, /COALESCE\(\$5, now\(\)\)/);
  assert.equal(insert.params[0], "flk-law-crawl");
  assert.equal(insert.params[1], KIND);
  assert.equal(insert.params[2], "failed");
  assert.equal(insert.params[3], started);
  assert.equal(insert.params[4], null);
  assert.equal(insert.params[5], 0);
  assert.equal(insert.params[6], "HTTP 403 for https://flk.npc.gov.cn");
  assert.equal(insert.params[9], JSON.stringify({ coverage_count: 0 }));
});

test("errorHead caps the reported error at 200 characters", () => {
  assert.equal(errorHead(new Error("x".repeat(500))).length, 200);
  assert.equal(errorHead("plain string"), "plain string");
  assert.equal(errorHead(undefined), "unknown error");
});

test("source names map library ids to CronJob names; identity for every SOURCE_ADAPTERS key", () => {
  assert.equal(telemetrySourceName("mfa-treaty-library"), "mfa-treaty-crawl");
  assert.equal(telemetrySourceName("mfa-treaty-library", "load"), "mfa-treaty-load");
  assert.equal(telemetrySourceName("rmfyalk-case-library", "load"), "rmfyalk-case-load");
  assert.equal(telemetrySourceName("gov-rules-library", "load"), "gov-rules-load");
  assert.equal(telemetrySourceName("party-regulation-library", "load"), "party-regulation-load");
  assert.equal(telemetrySourceName("ccdi-supervisory-regulations"), "ccdi-supervisory-crawl");
  assert.equal(telemetrySourceName("ccdi-supervisory-regulations", "load"), "ccdi-supervisory-load");
  // Standalone pipelines share the same mapping row on both sides.
  assert.equal(telemetrySourceName("flk-law"), "flk-law-crawl");
  assert.equal(telemetrySourceName("flk-law", "load"), "flk-law-load");
  assert.equal(SOURCE_CRONJOBS.get("flk-law")?.load, "flk-law-load", "flk-law-load must stay mapped (observer skips *-load)");
  assert.equal(telemetrySourceName("guide-cases"), "guide-cases-crawl");
  assert.equal(telemetrySourceName("guide-cases", "load"), "guide-cases-load");
  // Unknown names (e.g. frozen wenshu-crawl) pass straight through.
  assert.equal(telemetrySourceName("wenshu-crawl"), "wenshu-crawl");
  // A new adapter without a mapping entry must fail loudly here, not drift
  // into reporting under its library id.
  for (const [id] of SOURCE_ADAPTERS) {
    assert.ok(SOURCE_CRONJOBS.has(id), `missing SOURCE_CRONJOBS mapping for ${id}`);
    assert.match(SOURCE_CRONJOBS.get(id).crawl, /-crawl$/);
    assert.match(SOURCE_CRONJOBS.get(id).load, /-load$/);
  }
  for (const entry of SOURCE_CRONJOBS.values()) {
    assert.match(entry.crawl, /-crawl$/);
    assert.match(entry.load, /-load$/);
  }
});

test("startRun picks up FD_PENDING_RUN_ID from the dispatcher env; invalid values are ignored", async () => {
  const clients = fakeClientFactory();
  const t = createTelemetry({ url: "postgresql://t@127.0.0.1:1/x", clientFactory: clients, sleep: async () => {} });
  const previous = process.env.FD_PENDING_RUN_ID;
  try {
    delete process.env.FD_PENDING_RUN_ID;
    await t.startRun({ source: "mfa-treaty-crawl" });
    assert.equal(clients.calls.queries.at(-1).params[4], null);

    process.env.FD_PENDING_RUN_ID = "123";
    await t.startRun({ source: "mfa-treaty-crawl" });
    assert.equal(clients.calls.queries.at(-1).params[4], 123);
    assert.match(clients.calls.queries.at(-1).sql, /pending_run_id/);

    for (const invalid of ["abc", "", "  ", "run-42"]) {
      process.env.FD_PENDING_RUN_ID = invalid;
      await t.startRun({ source: "mfa-treaty-crawl" });
      assert.equal(clients.calls.queries.at(-1).params[4], null, `invalid value ${JSON.stringify(invalid)} is ignored`);
    }

    await t.startRun({ source: "mfa-treaty-crawl", pendingRunId: 77 });
    assert.equal(clients.calls.queries.at(-1).params[4], 77, "explicit argument wins over env");
  } finally {
    if (previous === undefined) delete process.env.FD_PENDING_RUN_ID;
    else process.env.FD_PENDING_RUN_ID = previous;
  }
});

test("effectiveBodyStats mirrors the report caliber (whitespace-stripped content >= 50 chars)", () => {
  const stats = effectiveBodyStats([
    { content: "a".repeat(50) },
    { content: "短".repeat(49) + "。\n" + "b".repeat(10) },
    { content: "too short" },
    { content: null },
    {},
  ]);
  assert.deepEqual(stats, { coverage_count: 5, effective_body_rows: 2, effective_body_ratio: 0.4 });
  assert.deepEqual(effectiveBodyStats([]), { coverage_count: 0, effective_body_rows: 0, effective_body_ratio: 0 });
});

// Process-wide defaults delegate to the env-driven handle; without env they
// must stay no-ops (the real cron path before the chart injects the DSN).
test("module-level startRun/finishRun are failure-safe no-ops without FD_CRAWL_DB_URL", async () => {
  const previous = process.env.FD_CRAWL_DB_URL;
  delete process.env.FD_CRAWL_DB_URL;
  try {
    const id = await startRun({ source: "rmfyalk-case-crawl" });
    const closed = await finishRun(id, { status: "success", rowsWritten: 1 });
    assert.equal(id, null);
    assert.equal(closed, false);
  } finally {
    if (previous !== undefined) process.env.FD_CRAWL_DB_URL = previous;
  }
});
