#!/usr/bin/env node
// Recon pass 2: follow the real nav (民事案件) into the list page, dump its
// URL, result list classes, count string, pager, filter panels, and one
// detail link shape. Read-only, anonymous.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const apis = [];
page.on("request", (r) => {
  const u = r.url();
  if (/\/(api|rest|service|ws)\//i.test(u) || /\/website\/.*\/(search|list|query)/i.test(u)) apis.push(`${r.method()} ${u.slice(0, 150)}`);
});

try {
  await page.goto("https://wenshu.court.gov.cn/", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(6000);

  // 1) homepage: today-added stats + nav hrefs
  const home = await page.evaluate(() => {
    const grab = (sel) => [...document.querySelectorAll(sel)].map((e) => ({ tag: e.tagName, cls: String(e.className).slice(0, 60), href: e.getAttribute("href") || "", text: (e.textContent || "").replace(/\s+/g, " ").trim().slice(0, 40) }));
    return {
      statsText: (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 160),
      nav: grab(".navlist_aj_ul a"),
      searchBox: (() => { const w = document.querySelector(".search-wrapper"); return w ? { inputs: [...w.querySelectorAll("input")].map((i) => ({ type: i.type, cls: i.className, ph: i.placeholder })), buttons: [...w.querySelectorAll("button,a.btn,[role=button]")].map((b) => b.textContent.trim().slice(0, 20)) } : null; })(),
    };
  });
  console.log("HOME stats:", home.statsText);
  console.log("HOME nav:", JSON.stringify(home.nav.slice(0, 8), null, 1));
  console.log("HOME searchBox:", JSON.stringify(home.searchBox));

  // 2) direct nav into the real civil-case list page
  await page.goto("https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(10000);
  console.log("\nLIST url:", page.url());

  const list = await page.evaluate(() => {
    const out = { counts: [], lists: [], pagers: [], filters: [], detailLinks: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (/^(共|找到|总计).{0,14}条$|^\d+\s*条$|共.{0,14}条/.test(t) && out.counts.length < 5) out.counts.push(t.slice(0, 40));
    }
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      if (/case|result|doc|item/i.test(c) && el.children.length >= 3 && out.lists.length < 8) out.lists.push({ tag: el.tagName, cls: c.slice(0, 70), n: el.children.length, head: (el.textContent || "").replace(/\s+/g, " ").slice(0, 50) });
      if (/page/i.test(c) && el.children.length >= 2 && out.pagers.length < 6) out.pagers.push({ tag: el.tagName, cls: c.slice(0, 50), text: (el.textContent || "").replace(/\s+/g, " ").slice(0, 40) });
      if (/filter|screen|cond|select|date/i.test(c) && out.filters.length < 10) out.filters.push({ tag: el.tagName, cls: c.slice(0, 60), text: (el.textContent || "").replace(/\s+/g, " ").slice(0, 50) });
    }
    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href") || "";
      if (/doc|detail|content|common\/\?/i.test(h) && out.detailLinks.length < 5) out.detailLinks.push(h.slice(0, 140));
    }
    return out;
  });
  console.log("LIST counts:", JSON.stringify(list.counts));
  console.log("LIST lists:", JSON.stringify(list.lists, null, 1));
  console.log("LIST pagers:", JSON.stringify(list.pagers));
  console.log("LIST filters:", JSON.stringify(list.filters, null, 1));
  console.log("LIST detailLinks:", JSON.stringify(list.detailLinks));
  console.log("APIs seen:", JSON.stringify(apis.slice(0, 10), null, 1));
} catch (err) {
  console.error("recon2 error:", String(err).slice(0, 400));
} finally {
  await browser.close();
}
