#!/usr/bin/env node
// SENTINEL for the standing standalone Chrome — fully unattended completion:
// watches CDP 9223 for a wenshu login; THE MOMENT the human logs in it
// (1) runs the end-to-end verification crawl via the raw-CDP adapter,
// (2) engages the keepalive so the session never idles,
// (3) records everything to /tmp/wenshu-sentinel-state.json.
// Run with nohup; it waits indefinitely for the login.
import { writeFileSync, readFileSync, existsSync } from "node:fs";

const CDP = "http://localhost:9223";
const HOME = "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html";
const STATE = "/tmp/wenshu-sentinel-state.json";
const CRAWL_OUT = "/tmp/wenshu-crawl-result.json";
const KEEPALIVE_MS = 5 * 60 * 1000;

const state = { startedAt: new Date().toISOString(), loggedInAt: null, crawlStartedAt: null, crawlDoneAt: null, crawlResult: null, keepalives: 0, lastKeepaliveAt: null };
const persist = () => writeFileSync(STATE, JSON.stringify(state, null, 1));
const log = (m) => console.log(`[sentinel ${new Date().toISOString()}] ${m}`);

async function cdpTab() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  return list.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page") ?? null;
}

async function probeLoggedIn() {
  const tab = await cdpTab().catch(() => null);
  if (!tab) return false;
  return await new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "/退出|欢迎您/.test(document.body?.innerText || '')", returnByValue: true } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) done(m.result?.result?.value === true); };
    ws.onerror = () => done(false);
    setTimeout(() => done(false), 15000);
  });
}

async function keepalive(tab) {
  return await new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url: HOME } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) { try { ws.close(); } catch {} resolve(true); } };
    ws.onerror = () => resolve(false);
    setTimeout(() => resolve(false), 20000);
  });
}

log("watching for wenshu login in the standing Chrome (CDP 9223)…");
// phase 1: wait for login (indefinitely)
while (!(await probeLoggedIn())) {
  await new Promise((r) => setTimeout(r, 30000));
}
state.loggedInAt = new Date().toISOString();
persist();
log("LOGIN DETECTED — starting verification crawl");

// phase 2: verification crawl (raw-CDP adapter), 10 min budget, 1-day window
try {
  state.crawlStartedAt = new Date().toISOString();
  persist();
  const { crawl, DEFAULT_REGIONS, DEFAULT_CASE_TYPES } = await import("../lib/wenshu/crawler.js");
  const { createCdpAdapter } = await import("../lib/wenshu/cdp-adapter.js");
  const { loadConfig } = await import("../lib/config.js");
  const { createS3 } = await import("../lib/s3.js");
  const cfg = loadConfig();
  const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
  const adapter = await createCdpAdapter({ cdpUrl: CDP });
  const res = await crawl({
    s3, bucket: cfg.wenshuBucket, adapter,
    lookbackDays: 1, rateMs: 1200, budgetMs: 10 * 60 * 1000,
    resultCap: cfg.wenshuResultCap, maxPages: 10,
    regions: DEFAULT_REGIONS, caseTypes: DEFAULT_CASE_TYPES, dryRun: false,
  });
  state.crawlDoneAt = new Date().toISOString();
  state.crawlResult = res.manifest;
  writeFileSync(CRAWL_OUT, JSON.stringify({ manifest: res.manifest, rows: res.rows.slice(0, 3) }, null, 1));
  log(`CRAWL DONE — emitted ${res.manifest.emitted} docs → ${CRAWL_OUT}`);
} catch (e) {
  state.crawlResult = { error: String(e).slice(0, 500) };
  log(`crawl error: ${e.message}`);
}
persist();

// phase 3: keepalive forever
log("keepalive engaged (5 min)");
setInterval(async () => {
  const tab = await cdpTab().catch(() => null);
  if (!tab) return;
  state.keepalives += 1;
  state.lastKeepaliveAt = new Date().toISOString();
  await keepalive(tab);
  persist();
}, KEEPALIVE_MS);
await new Promise(() => {});
