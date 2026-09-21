#!/usr/bin/env node
// Spike via the OPERATOR'S REAL CHROME session (profile copy, real chrome
// binary — no test Chromium, no captcha). One flight, in-context: verify
// login → homepage volume stats → keyword search page structure → 3 details.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";

const SCRATCH = "/tmp/chrome-wenshu-profile";
const HOME = "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html";

const browser = await chromium.launchPersistentContext(SCRATCH, {
  channel: "chrome",           // the REAL Chrome binary
  headless: false,
  args: ["--no-first-run", "--no-default-browser-check", "--profile-directory=Default"],
});
const page = browser.pages()[0] ?? (await browser.newPage());
const report = { startedAt: new Date().toISOString(), steps: {} };
const CAPTCHA = ".tianai-captcha-popup, .tianai-captcha-mask";

try {
  await page.goto(HOME, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(10000);
  const home = await page.evaluate(() => ({
    stats: (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
    welcome: (document.body.textContent.match(/欢迎您[，,]\s*\S+/) || [null])[0],
    hasLogout: [...document.querySelectorAll("a,span")].some((e) => /退出/.test(e.textContent || "")),
    captcha: !!document.querySelector(".tianai-captcha-popup, .tianai-captcha-mask"),
  }));
  report.steps.home = home;
  console.log("HOME:", JSON.stringify(home));

  if (home.captcha || (!home.welcome && !home.hasLogout)) {
    console.log(">>> 需要你在真实 Chrome 窗口里过一次验证码（应该只需要这一次）。等 3 分钟。");
    const dl = Date.now() + 180000;
    while (Date.now() < dl) {
      await page.waitForTimeout(3000);
      if (!(await page.locator(CAPTCHA).first().isVisible().catch(() => false))) {
        const h2 = await page.evaluate(() => (document.body.textContent.match(/欢迎您[，,]\s*\S+/) || [null])[0]);
        if (h2) { report.steps.captchaPassed = true; break; }
      }
    }
    // re-read home after captcha
    await page.reload({ waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
    await page.waitForTimeout(8000);
    report.steps.homeAfter = await page.evaluate(() => ({
      stats: (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
      welcome: (document.body.textContent.match(/欢迎您[，,]\s*\S+/) || [null])[0],
    }));
    console.log("HOME after:", JSON.stringify(report.steps.homeAfter));
  }

  // keyword search: capture the popup URL (wall?target=...), then replay it
  // in the MAIN tab where the WAF auto-pass completes its redirect chain.
  const popupPromise2 = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
  await page.locator("input.searchKey").first().fill("民间借贷", { timeout: 10000 });
  await page.keyboard.press("Enter");
  const pop2 = await popupPromise2;
  let targetUrl = null;
  if (pop2) {
    targetUrl = pop2.url();
    await pop2.close().catch(() => {});
  }
  console.log("search target (raw):", targetUrl);
  const sp = page;
  const hops = [];
  sp.on("framenavigated", (f) => { if (f === sp.mainFrame()) hops.push(f.url().slice(0, 130)); });
  await sp.goto(targetUrl || "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?pageId=0b4d0ade615", { waitUntil: "domcontentloaded", timeout: 45000 });
  // wait out the WAF hop chain: until URL leaves the wall or 45 s
  for (let i = 0; i < 15; i++) {
    await sp.waitForTimeout(3000);
    if (!/181010CARHS5BS3C|waf_text_verify/.test(sp.url())) break;
  }
  await sp.waitForTimeout(12000);
  report.steps.search = { requested: targetUrl, finalUrl: sp.url().slice(0, 160), hops };
  report.steps.searchDom = await sp.evaluate(() => {
    const out = { counts: [], listContainers: [], pagers: [], detailLinks: [], filterLabels: [] };
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
        out.listContainers.push({ tag: el.tagName, cls: c.slice(0, 60), n: el.children.length, head: txt.slice(0, 80) });
      if (/page|pager|fanye/i.test(c) && el.children.length >= 1 && out.pagers.length < 4) out.pagers.push({ cls: c.slice(0, 50), text: txt.slice(0, 40) });
      if (/^(裁判日期|法院地域|案由|文书类型|审判程序|案例级别|案件类型)$/.test(txt)) out.filterLabels.push({ tag: el.tagName, cls: c.slice(0, 50) });
    }
    for (const a of document.querySelectorAll("a[href], [data-docid], [onclick*='docId']")) {
      const h = a.getAttribute("href") || a.getAttribute("data-docid") || (a.getAttribute("onclick") || "");
      if (/docId=|docid/i.test(h) && out.detailLinks.length < 6) out.detailLinks.push(h.slice(0, 140));
    }
    const li = document.querySelector("[class*='result'] li, [class*='caseList'] li, .LM_list li");
    if (li) out.firstItemHtml = li.outerHTML.replace(/\s+/g, " ").slice(0, 800);
    out.bodyLen = (document.body.textContent || "").length;
    return out;
  });
  console.log("SEARCH:", JSON.stringify(report.steps.searchDom, null, 1));

  // details: up to 3 links
  report.steps.details = [];
  for (const href of (report.steps.searchDom.detailLinks || []).slice(0, 3)) {
    const dp = await browser.newPage();
    try {
      const abs = new URL(href, "https://wenshu.court.gov.cn/").toString();
      await dp.goto(abs, { waitUntil: "domcontentloaded", timeout: 45000 });
      await dp.waitForTimeout(9000);
      const docId = new URL(dp.url()).searchParams.get("docId") || href.match(/docId=([0-9a-f]{32})/)?.[1] || null;
      const anat = await dp.evaluate(() => {
        const grab = (re) => {
          for (const el of document.querySelectorAll("li,dd,dt,span,div")) {
            const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
            if (re.test(own)) return (el.textContent || "").replace(/\s+/g, " ").trim().slice(0, 100);
          }
          return null;
        };
        return {
          url: location.href.slice(0, 140),
          title: document.querySelector("h1,h2,[class*='title']")?.textContent?.replace(/\s+/g, " ").trim().slice(0, 80) ?? null,
          案号: grab(/^案\s*号/), 法院: grab(/^法院/), 案由: grab(/^案\s*由/), 判决时间: grab(/裁判日期|判决日期/), 发布时间: grab(/公开日期|发布日期/), 受理时间: grab(/受理日期/), 判决结果: grab(/^判决结果/), 案例级别: grab(/案例级别/), 法院级别: grab(/法院级别/), 审理程序: grab(/审判程序|审理程序/), 法条: grab(/法律依据|法条/),
          qwLen: (document.querySelector("[class*='qwContent'], #qwContent, [class*='doc-content']")?.innerHTML || "").length,
          qwFallbackLen: (document.querySelector("[class*='content']")?.innerHTML || document.body.innerHTML).length,
        };
      });
      report.steps.details.push({ docId, ...anat });
    } catch (e) {
      report.steps.details.push({ href: href.slice(0, 80), error: String(e).slice(0, 140) });
    } finally {
      await dp.close().catch(() => {});
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  console.log("DETAILS:", JSON.stringify(report.steps.details, null, 1));

  report.finishedAt = new Date().toISOString();
  writeFileSync("/tmp/wenshu-spike-report.json", JSON.stringify(report, null, 1));
  console.log("FULL REPORT at /tmp/wenshu-spike-report.json");
} catch (err) {
  console.error("chrome spike error:", String(err).slice(0, 400));
  process.exitCode = 1;
} finally {
  await browser.close();
}
