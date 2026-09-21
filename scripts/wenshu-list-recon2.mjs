#!/usr/bin/env node
// Logged-in recon: homepage (WAF + stats) → nav-click into 民事案件 list →
// dump list DOM (items/count/pager/filters/detail links) + SPA API calls.
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { downloadSession } from "../lib/wenshu/session.js";
import { chromium } from "playwright";

const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const jar = await downloadSession({ s3, bucket: cfg.wenshuBucket });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: jar?.storageState });
const page = await context.newPage();
const apis = [];
const track = (p) => {
  p.on("request", (r) => {
    const u = r.url();
    if (r.method() === "POST" || /\/(api|restful|portalapi|service|parse)\//i.test(u))
      apis.push(`${r.method()} ${u.replace("https://wenshu.court.gov.cn", "").slice(0, 130)}`);
  });
};
track(page);

try {
  // Homepage first (auth header + stats), then submit a keyword search —
  // the site's own transition yields the real search-page URL + selectors.
  await page.goto("https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);
  const homeStats = await page.evaluate(() => ({
    stats: (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200),
    hasLogout: [...document.querySelectorAll("a,span")].some((e) => /退出/.test(e.textContent || "")),
  }));
  console.log("HOME(after login):", JSON.stringify(homeStats));
  let listPage = page;
  const popupPromise = page.waitForEvent("popup", { timeout: 15000 }).catch(() => null);
  await page.locator("input.searchKey").first().fill("民间借贷");
  await page.keyboard.press("Enter");
  const popup = await popupPromise;
  if (popup) { listPage = popup; track(listPage); await listPage.waitForLoadState("domcontentloaded", { timeout: 30000 }).catch(() => {}); }
  await listPage.waitForTimeout(18000);
  console.log("SEARCH url:", listPage.url());
  const dump = await listPage.evaluate(() => {
    const out = { counts: [], items: [], pagers: [], filters: [], detailLinks: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (/共.{0,16}条/.test(t) && out.counts.length < 4) out.counts.push(t.slice(0, 40));
    }
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/result|caseList|doc[_-]?list|LM[_-]?list/i.test(c) && el.children.length >= 2 && out.items.length < 5)
        out.items.push({ tag: el.tagName, cls: c.slice(0, 60), n: el.children.length, head: txt.slice(0, 60) });
      if (/page/i.test(c) && el.children.length >= 2 && out.pagers.length < 5) out.pagers.push({ tag: el.tagName, cls: c.slice(0, 50), text: txt.slice(0, 50) });
      if (/筛选|裁判年份|法院|地域|案由|文书类型/i.test(txt) && txt.length < 30 && out.filters.length < 10 && c)
        out.filters.push({ tag: el.tagName, cls: c.slice(0, 50), text: txt });
    }
    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href") || "";
      if (/docId=|docid=|\/common|detail/i.test(h) && out.detailLinks.length < 5) out.detailLinks.push(h.slice(0, 130));
    }
    const first = document.querySelector("[class*='result'] li, [class*='caseList'] li, .LM_list li");
    if (first) out.firstItem = { tag: first.tagName, cls: String(first.className).slice(0, 60), html: first.outerHTML.replace(/\s+/g, " ").slice(0, 500) };
    out.bodyLen = (document.body.textContent || "").length;
    return out;
  });
  console.log(JSON.stringify(dump, null, 1));
  console.log("API calls:");
  apis.slice(0, 25).forEach((a) => console.log("  ", a));
} catch (err) {
  console.error("recon error:", String(err).slice(0, 400));
} finally {
  await browser.close();
}
