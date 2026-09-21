#!/usr/bin/env node
// FINAL one-flight spike (tasks 1.1-1.3 evidence): real Chrome, persistent
// scratch profile, search via .search-click, ride the wall hop chain, dump
// search page + up to 3 details, upload the jar the moment auth is live.
// The browser stays OPEN until every capture is done.
import { chromium } from "playwright";
import { writeFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { uploadSession, cookieLifetimeSignals } from "../lib/wenshu/session.js";

const SCRATCH = "/tmp/chrome-wenshu-profile";
const HOME = "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html";
const WALL = /181010CARHS5BS3C|waf_text_verify/;
const CAPTCHA = ".tianai-captcha-popup, .tianai-captcha-mask";

const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const report = { startedAt: new Date().toISOString(), steps: {} };

const browser = await chromium.launchPersistentContext(SCRATCH, {
  channel: "chrome",
  headless: false,
  args: ["--no-first-run", "--no-default-browser-check", "--profile-directory=Default"],
});
const page = browser.pages()[0] ?? (await browser.newPage());

const dumpSearch = (p) =>
  p.evaluate(() => {
    const out = { counts: [], listContainers: [], pagers: [], detailLinks: [], filterLabels: [], firstItemHtml: null };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (/共.{0,16}条/.test(t) && out.counts.length < 3) out.counts.push(t.slice(0, 40));
    }
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/result|caseList|LM[_-]?list|doc[_-]?list|search[_-]?list/i.test(c) && el.children.length >= 2 && out.listContainers.length < 4)
        out.listContainers.push({ tag: el.tagName, cls: c.slice(0, 60), n: el.children.length, head: txt.slice(0, 90) });
      if (/page|pager|fanye/i.test(c) && el.children.length >= 1 && out.pagers.length < 4) out.pagers.push({ cls: c.slice(0, 50), text: txt.slice(0, 40) });
      if (/^(裁判日期|法院地域|案由|文书类型|审判程序|案例级别|案件类型|高级法院|中级法院|基层法院)$/.test(txt)) out.filterLabels.push({ tag: el.tagName, cls: c.slice(0, 50), text: txt });
    }
    for (const a of document.querySelectorAll("a[href], [data-docid], [onclick*='docId']")) {
      const h = a.getAttribute("href") || a.getAttribute("data-docid") || (a.getAttribute("onclick") || "");
      if (/docId=|docid/i.test(h) && out.detailLinks.length < 8) out.detailLinks.push(h.slice(0, 150));
    }
    const li = document.querySelector("[class*='result'] li, [class*='caseList'] li, .LM_list li");
    if (li) out.firstItemHtml = li.outerHTML.replace(/\s+/g, " ").slice(0, 900);
    out.bodyLen = (document.body.textContent || "").length;
    return out;
  });

try {
  // ---- homepage + search ----
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(9000);
  report.steps.homeStats = await page.evaluate(() =>
    (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200));
  console.log("HOME stats:", report.steps.homeStats);

  // capture the search target URL from the transient popup, then close it and
  // replay in the MAIN tab — the wall window.close()s popups (anti-automation,
  // hit live 2026-09-19) but cannot close a tab the user/script owns.
  let targetUrl = null;
  {
    const cap = page.waitForEvent("popup", { timeout: 20000 }).then(async (pop) => {
      await pop.waitForLoadState("domcontentloaded", { timeout: 15000 }).catch(() => {});
      const u = pop.url();
      await pop.close().catch(() => {});
      return u;
    }).catch(() => null);
    await page.locator("input.searchKey").first().fill("民间借贷", { timeout: 10000 });
    await page.locator(".search-rightBtn.search-click").first().click({ timeout: 10000 });
    targetUrl = await cap;
  }
  console.log("search target:", (targetUrl || "(none)").slice(0, 140));
  const sp = page;
  await sp.goto(targetUrl || "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?pageId=0b4d0ade615&enterWord=%E6%B0%91%E9%97%B4%E5%80%9F%E8%B4%B7&s21=%E6%B0%91%E9%97%B4%E5%80%9F%E8%B4%B7", { waitUntil: "domcontentloaded", timeout: 45000 });
  console.log("search landed (main tab):", sp.url().slice(0, 140));

  // ---- ride the wall chain / or wait for the human ----
  const hops = [];
  sp.on("framenavigated", (f) => { if (f === sp.mainFrame()) hops.push(f.url().slice(0, 130)); });
  let humanNeeded = false;
  for (let i = 0; i < 20; i++) {
    await sp.waitForTimeout(3000);
    if (WALL.test(sp.url())) continue; // hop chain in progress
    break;
  }
  // check for captcha/login anywhere in the chain
  for (let i = 0; i < 160; i++) {
    const url = sp.url();
    const cap = await sp.locator(CAPTCHA).first().isVisible().catch(() => false);
    const loginForm = await sp.locator("input.phone-number-input[name='username']").first().isVisible().catch(() => false);
    if (cap || loginForm || WALL.test(url)) {
      if (!humanNeeded) {
        humanNeeded = true;
        console.log(">>> 需要你在真实 Chrome 窗口里完成登录/验证码（依次点击文字）。我会安静等待，最多 8 分钟。");
      }
      await sp.waitForTimeout(3000);
      continue;
    }
    break;
  }
  await sp.waitForTimeout(12000); // SPA render
  report.steps.search = { finalUrl: sp.url().slice(0, 160), hops, humanNeeded };
  report.steps.searchDom = await dumpSearch(sp);
  console.log("SEARCH url:", sp.url().slice(0, 140));
  console.log("SEARCH dom:", JSON.stringify(report.steps.searchDom, null, 1));

  // ---- jar upload the moment things work ----
  if (!humanNeeded || report.steps.searchDom.bodyLen > 400) {
    const state = await browser.storageState();
    const wrapper = await uploadSession({ s3, bucket: cfg.wenshuBucket, storageState: state, account: null });
    report.steps.jar = { savedAt: wrapper.savedAt, cookies: cookieLifetimeSignals(wrapper) };
    console.log("jar uploaded at", wrapper.savedAt);
  }

  // ---- details ----
  report.steps.details = [];
  for (const href of (report.steps.searchDom.detailLinks || []).slice(0, 3)) {
    const dp = await browser.newPage();
    try {
      const abs = href.startsWith("http") ? href : new URL(href, "https://wenshu.court.gov.cn/").toString();
      await dp.goto(abs, { waitUntil: "domcontentloaded", timeout: 45000 });
      await dp.waitForTimeout(9000);
      for (let i = 0; i < 10; i++) {
        if (!WALL.test(dp.url())) break;
        await dp.waitForTimeout(3000);
      }
      const docId = new URL(dp.url()).searchParams.get("docId") || href.match(/docId=([0-9a-f]{32})/)?.[1] || null;
      const anat = await dp.evaluate(() => {
        const grab = (re) => {
          for (const el of document.querySelectorAll("li,dd,dt,span,div")) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
            if (re.test(own)) return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 110);
          }
          return null;
        };
        const qwEl = document.querySelector("[id*='qwContent'], [class*='qwContent'], [class*='doc-content']");
        return {
          url: location.href.slice(0, 150),
          title: document.querySelector("h1,h2,[class*='title']")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 90) ?? null,
          案号: grab(/^案\s*号/), 法院: grab(/^法院/), 案由: grab(/^案\s*由/),
          判决时间: grab(/裁判日期|判决日期/), 发布时间: grab(/公开日期|发布日期/), 受理时间: grab(/受理日期/),
          判决结果: grab(/^判决结果/), 案例级别: grab(/案例级别/), 法院级别: grab(/法院级别/), 审理程序: grab(/审判程序|审理程序/), 法条: grab(/法律依据|相关法条/),
          qwSelector: qwEl ? (qwEl.id || qwEl.className).toString().slice(0, 50) : null,
          qwLen: (qwEl?.innerHTML || "").length,
          bodyLen: (document.body.textContent || "").length,
        };
      });
      report.steps.details.push({ docId, ...anat });
    } catch (e) {
      report.steps.details.push({ href: href.slice(0, 80), error: String(e).slice(0, 140) });
    } finally {
      await dp.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  console.log("DETAILS:", JSON.stringify(report.steps.details, null, 1));

  report.finishedAt = new Date().toISOString();
  writeFileSync("/tmp/wenshu-spike-report.json", JSON.stringify(report, null, 1));
  console.log("REPORT written to /tmp/wenshu-spike-report.json");
} catch (err) {
  console.error("final spike error:", String(err).slice(0, 400));
  process.exitCode = 1;
} finally {
  await browser.close();
}
