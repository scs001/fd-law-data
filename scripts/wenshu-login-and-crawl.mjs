#!/usr/bin/env node
// ONE-FLIGHT login + crawl (the definitive session shape, verified live
// 2026-09-19): the wenshu session is activity-bound and dies ~20 min after
// the holding browser closes — so the crawl must start in the SAME browser
// context SECONDS after the human passes the captcha, and the crawl's own
// activity keeps the session alive. One window, one captcha, data flows.
//
// Usage: node scripts/wenshu-login-and-crawl.mjs [--budget-ms N] [--lookback N] [--dry-run]
// The browser stays open for the whole crawl; close nothing.
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { uploadSession } from "../lib/wenshu/session.js";
import { crawl, DEFAULT_REGIONS, DEFAULT_CASE_TYPES } from "../lib/wenshu/crawler.js";
import * as site from "../lib/wenshu/site.js";
import { chromium } from "playwright";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const PROFILE = join(homedir(), ".cache", "fd-law-data", "wenshu-login-profile");
const SSO = "https://account.court.gov.cn/app#/login";
const CAPTCHA = ".tianai-captcha-popup, .tianai-captcha-mask";

const cfg = loadConfig();
const dryRun = !!arg("dry-run");
const s3 = createS3(
  dryRun
    ? { endpoint: "https://dry-run.invalid", accessKey: "dry", secretKey: "run" }
    : { endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region },
);

const context = await chromium.launchPersistentContext(PROFILE, { headless: false });
const page = context.pages()[0] ?? (await context.newPage());

const loggedInOn = async (p) => {
  try {
    return /退出/.test((await p.locator("body").innerText({ timeout: 8000 })) || "");
  } catch {
    return false;
  }
};

try {
  // ---- login: autofill + submit, human completes the word-click ----
  await page.goto(SSO, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);
  if (!(await loggedInOn(page))) {
    if (cfg.wenshuAccountUser && cfg.wenshuAccountPassword) {
      await page.locator("input.phone-number-input[name='username']").first().fill(cfg.wenshuAccountUser, { timeout: 10000 });
      await page.locator("input.password[name='password']").first().fill(cfg.wenshuAccountPassword, { timeout: 10000 });
      await page.locator("span.button.button-primary").first().click({ timeout: 10000 });
    } else {
      console.log("no WENSHU_ACCOUNT_* in .env — log in manually in the window");
    }
    console.log(">>> 请在窗口里完成文字点选验证码（依次点击提示的汉字，可能多轮）。验证码消失后爬取立即自动开始。");
    const deadline = Date.now() + 10 * 60 * 1000;
    let ok = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(3000);
      const busy = await page.locator(CAPTCHA).first().isVisible().catch(() => false);
      if (busy) continue;
      ok = await loggedInOn(page);
      if (ok) break;
      // captcha cleared but still on SSO → maybe re-armed; re-submit gently
      if (page.url().includes("account.court.gov.cn")) {
        await page.locator("span.button.button-primary").first().click({ timeout: 8000 }).catch(() => {});
      }
    }
    if (!ok) throw new Error("login did not complete in 10 min — re-run");
  }
  console.log("login confirmed — crawl starts NOW in this same browser");

  // fresh jar for the record (cluster/other runs may use it while it lasts)
  if (!dryRun) {
    try {
      await uploadSession({ s3, bucket: cfg.wenshuBucket, storageState: await context.storageState(), account: cfg.wenshuAccountUser || null });
      console.log("session jar uploaded (freshness ~minutes — profile-mode crawls don't need it)");
    } catch (e) {
      console.error("jar upload failed (non-fatal for this run):", String(e).slice(0, 120));
    }
  }

  // ---- crawl, riding THIS context's live session ----
  const adapter = {
    probeSession: () => site.probeSession({ page }),
    searchTotal: (slice) => site.searchTotal({ page, slice }),
    listDocIds: (slice, opts = {}) => site.listDocIds({ page, slice, ...opts }),
    fetchDetail: (docId) => site.fetchDetail({ page, docId, rateMs: 0 }),
  };
  const res = await crawl({
    s3,
    bucket: cfg.wenshuBucket,
    adapter,
    lookbackDays: Number(arg("lookback", cfg.wenshuLookbackDays)),
    rateMs: Number(arg("rate-ms", cfg.wenshuRateMs)),
    budgetMs: Number(arg("budget-ms", 4 * 3600 * 1000)),
    resultCap: cfg.wenshuResultCap,
    maxPages: Number(arg("max-pages", 20)),
    regions: DEFAULT_REGIONS,
    caseTypes: DEFAULT_CASE_TYPES,
    dryRun,
  });
  console.log(JSON.stringify({ mode: dryRun ? "dry-run" : "login-and-crawl", manifest: res.manifest }, null, 1));
} catch (err) {
  console.error(`login-and-crawl error: ${err.message}`);
  process.exitCode = 1;
} finally {
  await context.close().catch(() => {});
}
