#!/usr/bin/env node
// One-flight spike executor (tasks 1.1–1.3): headed login (human does the
// word-click captcha once) then, IN THE SAME CONTEXT while the session is
// fresh: homepage volume stats → list-page structure + selectors → detail
// page anatomy (3 docs) → one JSON report on stdout.
// Session lifetime is minutes and silent SSO re-auth is unreliable, so every
// observation must ride the same post-login context.
import { homedir } from "node:os";
import { join } from "node:path";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { uploadSession, cookieLifetimeSignals } from "../lib/wenshu/session.js";
import { chromium } from "playwright";

const PROFILE = join(homedir(), ".cache", "fd-law-data", "wenshu-login-profile");
const HOME = "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html";
const SSO = "https://account.court.gov.cn/app#/login";
const CAPTCHA = ".tianai-captcha-popup, .tianai-captcha-mask";

const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const account = { user: cfg.wenshuAccountUser, pass: cfg.wenshuAccountPassword };

const browser = await chromium.launchPersistentContext(PROFILE, { headless: false });
const page = browser.pages()[0] ?? (await browser.newPage());
const report = { startedAt: new Date().toISOString(), steps: {} };

const loggedInHeader = async (p) =>
  /欢迎您|退出/.test(await p.locator("body").innerText({ timeout: 8000 }).catch(() => ""));

try {
  // ---- login (auto fill+submit; human completes the word-click) ----
  await page.goto(SSO, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000);
  await page.locator("input.phone-number-input[name='username']").first().fill(account.user, { timeout: 10000 });
  await page.locator("input.password[name='password']").first().fill(account.pass, { timeout: 10000 });
  await page.locator("span.button.button-primary").first().click({ timeout: 10000 });
  console.log(">>> 请在窗口中按提示依次点击文字验证码（可能多轮）。我不会做任何会抢焦点的操作。");
  let ok = false;
  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000);
    const busy = await page.locator(CAPTCHA).first().isVisible().catch(() => false);
    if (busy) continue;
    ok = await loggedInHeader(page).catch(() => false);
    if (ok) break;
    // captcha gone but not logged in → maybe re-armed; gentle re-submit
    await page.locator("span.button.button-primary").first().click({ timeout: 8000 }).catch(() => {});
  }
  if (!ok) throw new Error("login did not complete in 10 min");
  report.steps.login = { ok: true, at: new Date().toISOString() };
  console.log("login confirmed — uploading jar and running the spike in-flight");

  const state = await browser.storageState();
  const wrapper = await uploadSession({ s3, bucket: cfg.wenshuBucket, storageState: state, account: account.user || null });
  report.session = { savedAt: wrapper.savedAt, cookies: cookieLifetimeSignals(wrapper) };

  // ---- homepage: today volume ----
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);
  report.steps.homeStats = await page.evaluate(() => ({
    stats: (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
    todayAdded: (document.querySelector(".statistics_list li:first-child")?.textContent || "").replace(/\s+/g, " ").trim(),
  }));

  // ---- search: keyword from the homepage box (site-driven transition) ----
  const popupPromise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
  await page.locator("input.searchKey").first().fill("民间借贷");
  await page.keyboard.press("Enter");
  let sp = (await popupPromise) ?? page;
  if (sp !== page) await sp.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {});
  await sp.waitForTimeout(15000);
  report.steps.searchPage = { url: sp.url().slice(0, 160) };
  report.steps.searchDom = await sp.evaluate(() => {
    const out = { counts: [], firstItems: [], pagers: [], filterHeads: [], detailLinks: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (/共.{0,16}条/.test(t) && out.counts.length < 3) out.counts.push(t.slice(0, 40));
    }
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/result|caseList|LM[_-]?list|doc[_-]?list/i.test(c) && el.children.length >= 2 && out.firstItems.length < 3)
        out.firstItems.push({ cls: c.slice(0, 60), n: el.children.length, head: txt.slice(0, 70) });
      if (/page/i.test(c) && el.children.length >= 2 && out.pagers.length < 3) out.pagers.push({ cls: c.slice(0, 50), text: txt.slice(0, 50) });
    }
    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href") || "";
      if (/docId=|docid=|\/common/i.test(h) && out.detailLinks.length < 6) out.detailLinks.push(h.slice(0, 140));
    }
    const li = document.querySelector("[class*='result'] li, [class*='caseList'] li, .LM_list li");
    if (li) out.firstItemHtml = li.outerHTML.replace(/\s+/g, " ").slice(0, 700);
    out.bodyLen = (document.body.textContent || "").length;
    return out;
  });

  // ---- details: follow up to 3 detail links ----
  report.steps.details = [];
  for (const href of (report.steps.searchDom.detailLinks || []).slice(0, 3)) {
    const dp = await browser.newPage();
    try {
      await dp.goto(new URL(href, "https://wenshu.court.gov.cn/").toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
      await dp.waitForTimeout(9000);
      const docId = (new URL(dp.url()).searchParams.get("docId")) || href.match(/docId=([0-9a-f]{32})/)?.[1] || null;
      const anatomy = await dp.evaluate(() => {
        const grab = (re) => {
          for (const el of document.querySelectorAll("li,dd,dt,span,div")) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
            if (re.test(own)) return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 90);
          }
          return null;
        };
        return {
          url: location.href.slice(0, 130),
          案号: grab(/^案\s*号/), 法院: grab(/^法院/), 案由: grab(/^案\s*由/), 标题: document.querySelector("h1,h2,.title,[class*='title']")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? null,
          判决时间: grab(/裁判日期|判决日期|裁判时间/), 发布时间: grab(/公开日期|发布日期/), 判决结果: grab(/^判决结果/), 案例级别: grab(/案例级别|指导案例/),
          qwSelectorHit: !!document.querySelector("[class*='qwContent'], [class*='doc-content'], #qwContent, [class*='content']"),
          qwLen: (document.querySelector("[class*='qwContent'], [class*='doc-content'], #qwContent")?.innerHTML || "").length,
        };
      });
      report.steps.details.push({ docId, ...anatomy });
    } catch (e) {
      report.steps.details.push({ href: href.slice(0, 80), error: String(e).slice(0, 120) });
    } finally {
      await dp.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }
  }

  report.finishedAt = new Date().toISOString();
  writeFileSync("/tmp/wenshu-spike-report.json", JSON.stringify(report, null, 1));
  console.log("SPIKE REPORT (also at /tmp/wenshu-spike-report.json):");
  console.log(JSON.stringify(report, null, 1));
} catch (err) {
  console.error("spike error:", String(err).slice(0, 300));
  process.exitCode = 1;
} finally {
  await browser.close();
}
