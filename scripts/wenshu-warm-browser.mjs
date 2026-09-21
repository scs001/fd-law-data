#!/usr/bin/env node
// STANDING wenshu browser — THE durable session answer (2026-09-19).
//
// Investigation summary (all verified live): wenshu sessions are ACTIVITY-
// BOUND server-side — an idle session dies in ~20 min no matter what
// cookies/state a browser holds; the operator's own Chrome stays logged in
// only because it keeps running and browsing. Transplanted jars fail from
// other IPs/contexts. Therefore the durable login state IS a dedicated
// always-on browser: log in ONCE (QR/word-click), then this script's
// KEEPALIVE re-visits wenshu every 5 min so the session never goes idle.
// Crawls attach via CDP (--cdp http://localhost:9223) and ride the live
// session. Safe to minimize the window; do NOT close it (a closed browser
// = idle session = re-login needed).
//
// Playwright's bundled Chromium is used deliberately (not the installed
// Chrome): connectOverCDP from playwright 1.63 cannot drive Chrome 153
// ("Browser context management is not supported") but drives its own
// bundled build fine.
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";

const PROFILE = join(homedir(), ".cache", "fd-law-data", "wenshu-warm-profile");
const CDP_PORT = 9223;
const HOME = "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html";
const SSO = "https://account.court.gov.cn/app#/login";
const CAPTCHA = ".tianai-captcha-popup, .tianai-captcha-mask";
const KEEPALIVE_MS = 5 * 60 * 1000;
const STATE_FILE = "/tmp/wenshu-warm-state.json";

const { chromium } = await import("playwright");
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [`--remote-debugging-port=${CDP_PORT}`, "--window-size=1280,900", "--no-first-run"],
});
const page = context.pages()[0] ?? (await context.newPage());

const state = { startedAt: new Date().toISOString(), loggedInAt: null, keepalives: 0, lastKeepaliveAt: null, sessionAlive: null };
const persist = () => writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));

const loggedInOn = async (p) => {
  try {
    return /退出/.test((await p.locator("body").innerText({ timeout: 8000 })) || "");
  } catch {
    return false;
  }
};

const report = async (event) => {
  state.sessionAlive = await loggedInOn(page).catch(() => false);
  persist();
  const line = `[warm-browser] ${event} at ${new Date().toISOString()} session=${state.sessionAlive ? "ALIVE" : "dead"} keepalives=${state.keepalives}`;
  console.log(line);
};

try {
  // ---- login (once) ----
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(8000);
  if (await loggedInOn(page)) {
    state.loggedInAt = new Date().toISOString();
    await report("already logged in");
  } else {
    await page.goto(SSO, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(4000);
    console.log(`[warm-browser] CDP on http://localhost:${CDP_PORT} — complete the login ONCE in this window (word-click captcha). Keepalive starts automatically. You may MINIMIZE the window; do not close it.`);
    const deadline = Date.now() + 30 * 60 * 1000;
    while (Date.now() < deadline) {
      await page.waitForTimeout(4000);
      const busy = await page.locator(CAPTCHA).first().isVisible().catch(() => false);
      if (busy) continue;
      if (await loggedInOn(page)) break;
      if (page.url().includes("account.court.gov.cn")) {
        await page.locator("span.button.button-primary").first().click({ timeout: 8000 }).catch(() => {});
      }
    }
    if (!(await loggedInOn(page).catch(() => false))) {
      await report("login window expired (30 min) — exiting");
      process.exitCode = 1;
    } else {
      state.loggedInAt = new Date().toISOString();
      await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
      await report("LOGIN OK — keepalive engaged");
    }
  }

  // ---- keepalive loop: the session never goes idle ----
  if (!process.exitCode) {
    setInterval(async () => {
      try {
        state.keepalives += 1;
        state.lastKeepaliveAt = new Date().toISOString();
        await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForTimeout(2500);
        await report(`keepalive #${state.keepalives}`);
      } catch (e) {
        console.log(`[warm-browser] keepalive error: ${String(e).slice(0, 100)}`);
      }
    }, KEEPALIVE_MS);
    await report("standing by — crawls attach via --cdp http://localhost:9223");
    await new Promise(() => {}); // run until killed
  }
} catch (err) {
  console.error(`[warm-browser] fatal: ${err.message}`);
  process.exitCode = 1;
} finally {
  if (process.exitCode) await context.close().catch(() => {});
}
