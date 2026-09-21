#!/usr/bin/env node
// Spike rider on the WARM browser (CDP attach, zero logins): dump search
// results DOM + 3 detail pages + homepage volume, upload the LIVE session
// jar. Task 1.2 evidence collector.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { uploadSession, cookieLifetimeSignals } from "../lib/wenshu/session.js";

const CDP = "http://localhost:9223";
const HOME = "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html";
const SEARCH_URL = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?pageId=0b4d0ade615&s21=%E6%B0%91%E9%97%B4%E5%80%9F%E8%B4%B7";
const WALL = /181010CARHS5BS3C|waf_text_verify/;

const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const report = { startedAt: new Date().toISOString(), steps: {} };

const browser = await chromium.connectOverCDP(CDP);
const context = browser.contexts()[0];
const page = await context.newPage();

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
      if (/page|pager|fanye/i.test(c) && el.children.length >= 1 && out.pagers.length < 4) out.pagers.push({ cls: c.slice(0, 50), text: txt.slice(0, 44) });
      if (/^(裁判日期|法院地域|案由|文书类型|审判程序|案例级别|案件类型)$/.test(txt)) out.filterLabels.push({ tag: el.tagName, cls: c.slice(0, 50), text: txt });
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
  // ---- search page (ride the warm session; wall auto-passes in-session) ----
  await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(3000);
    if (!WALL.test(page.url())) break;
  }
  await page.waitForTimeout(15000);
  report.steps.search = { url: page.url().slice(0, 160) };
  report.steps.searchDom = await dumpSearch(page);
  console.log("SEARCH:", JSON.stringify(report.steps.searchDom, null, 1));

  // ---- homepage volume + login confirmation ----
  const hp = await context.newPage();
  await hp.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
  await hp.waitForTimeout(8000);
  report.steps.homeStats = await hp.evaluate(() => ({
    stats: (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
    loggedIn: [...document.querySelectorAll("a,span")].some((e) => /退出/.test(e.textContent || "")),
  }));
  console.log("HOME:", JSON.stringify(report.steps.homeStats));
  await hp.close().catch(() => {});

  // ---- live jar upload (authoritative, from the warm context) ----
  const state = await context.storageState();
  const wrapper = await uploadSession({ s3, bucket: cfg.wenshuBucket, storageState: state, account: null });
  report.steps.jar = { savedAt: wrapper.savedAt, cookies: cookieLifetimeSignals(wrapper) };

  // ---- details (up to 3) ----
  report.steps.details = [];
  for (const href of (report.steps.searchDom.detailLinks || []).slice(0, 3)) {
    const dp = await context.newPage();
    try {
      const abs = href.startsWith("http") ? href : new URL(href, "https://wenshu.court.gov.cn/").toString();
      await dp.goto(abs, { waitUntil: "domcontentloaded", timeout: 45000 });
      for (let i = 0; i < 10; i++) {
        if (!WALL.test(dp.url())) break;
        await dp.waitForTimeout(3000);
      }
      await dp.waitForTimeout(9000);
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
      console.log("DETAIL", docId, JSON.stringify(anat).slice(0, 220));
    } catch (e) {
      report.steps.details.push({ href: href.slice(0, 80), error: String(e).slice(0, 140) });
    } finally {
      await dp.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  report.finishedAt = new Date().toISOString();
  writeFileSync("/tmp/wenshu-spike-report.json", JSON.stringify(report, null, 1));
  console.log("REPORT → /tmp/wenshu-spike-report.json");
  process.exitCode = 0;
} catch (err) {
  console.error("cdp spike error:", String(err).slice(0, 400));
  process.exitCode = 1;
} finally {
  await page.close().catch(() => {});
  browser.close().catch?.(() => {}); // CDP close detaches, leaves the warm browser alive
}
