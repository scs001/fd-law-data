#!/usr/bin/env node
// One-off read-only DOM recon against the live search page (anonymous).
// No S3 writes, no login attempts. Prints structural facts the selector
// pass needs: result list containers, count text, pagination controls,
// login indicators, and whether results render without login.
import { chromium } from "playwright";

const SEARCH = process.argv[2] || "https://wenshu.court.gov.cn/website/wenshu/181010CNHSU64YJS/index.html";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const requests = [];
page.on("request", (r) => {
  const u = r.url();
  if (u.includes("court.gov.cn") && !u.match(/\.(js|css|png|jpg|svg|woff2?|ico)(\?|$)/)) {
    requests.push(`${r.method()} ${u.replace("https://wenshu.court.gov.cn", "")}`.slice(0, 140));
  }
});

try {
  await page.goto(SEARCH, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(8000); // SPA settle
  console.log("finalUrl:", page.url());

  const facts = await page.evaluate(() => {
    const out = { title: document.title, bodyClasses: [], candidateLists: [], counts: [], pagers: [], loginish: [], iframes: [] };
    for (const f of document.querySelectorAll("iframe")) out.iframes.push(f.src.slice(0, 120));
    // any element whose class hints at a result/doc list
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      if (/result|list|doc|item|card|search/i.test(c) && el.children.length >= 2 && out.candidateLists.length < 12) {
        out.candidateLists.push({ tag: el.tagName, cls: c.slice(0, 80), children: el.children.length, textHead: (el.textContent || "").trim().slice(0, 60) });
      }
    }
    // texts containing 条/结果 (count strings)
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n, seen = 0;
    while ((n = walker.nextNode()) && seen < 4000) {
      const t = (n.textContent || "").trim();
      seen++;
      if (/共.{0,12}条|找到.{0,12}条|\d+\s*条结果|结果数/.test(t) && out.counts.length < 6) out.counts.push(t.slice(0, 50));
    }
    // pager-ish elements
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      if (/page|pag|next|pager/i.test(c) && out.pagers.length < 8) out.pagers.push({ tag: el.tagName, cls: c.slice(0, 60), text: (el.textContent || "").trim().slice(0, 30) });
    }
    // login-ish anchors/buttons
    for (const el of document.querySelectorAll("a,button,span [class],div [class]")) {
      const t = (el.textContent || "").trim();
      if (/^(登录|登陆|注册|退出|个人中心)$/.test(t) && out.loginish.length < 8) out.loginish.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), text: t });
    }
    out.bodyTextHead = (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 200);
    return out;
  });
  console.log(JSON.stringify(facts, null, 1));
  console.log("apiRequests (non-asset, first 20):");
  requests.slice(0, 20).forEach((r) => console.log("  ", r));
} catch (err) {
  console.error("recon error:", String(err).slice(0, 300));
} finally {
  await browser.close();
}
