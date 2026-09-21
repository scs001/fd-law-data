#!/usr/bin/env node
// Recon pass 3: with the current (anonymous) session jar from the bucket,
// load the real list page and dump CONTENT: does it render result items,
// count strings, pagination, filters, detail links — or a login overlay?
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { downloadSession } from "../lib/wenshu/session.js";
import { chromium } from "playwright";

const LIST = process.argv[2] || "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";

const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const jar = await downloadSession({ s3, bucket: cfg.wenshuBucket });
console.log("jar cookies:", (jar?.storageState?.cookies || []).map((c) => c.name).join(", ") || "(none)");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ storageState: jar?.storageState });
const page = await context.newPage();
const apis = [];
page.on("request", (r) => {
  const u = r.url();
  if (/court\.gov\.cn\/(api|restful|website\/wenshu\/\w+\/(api|rest))|\/portalapi\//i.test(u)) apis.push(`${r.method()} ${u.replace("https://wenshu.court.gov.cn", "").slice(0, 150)}`);
});

try {
  await page.goto(LIST, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(12000);
  console.log("url:", page.url());

  const dump = await page.evaluate(() => {
    const out = { counts: [], items: [], pagers: [], filters: [], overlays: [], detailLinks: [] };
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = walker.nextNode())) {
      const t = (n.textContent || "").trim();
      if (/共.{0,16}条/.test(t) && out.counts.length < 4) out.counts.push(t.slice(0, 40));
    }
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      const txt = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/result|caseList|doc[_-]?list|LM[_-]?list/i.test(c) && el.children.length >= 2 && out.items.length < 6)
        out.items.push({ tag: el.tagName, cls: c.slice(0, 60), n: el.children.length, head: txt.slice(0, 70) });
      if (/page/i.test(c) && el.children.length >= 2 && out.pagers.length < 4) out.pagers.push({ cls: c.slice(0, 50), text: txt.slice(0, 40) });
      if (/筛选|日期|法院|地域|案由/.test(txt) && el.children.length >= 1 && out.filters.length < 8 && c) out.filters.push({ cls: c.slice(0, 50), text: txt.slice(0, 40) });
    }
    // overlays/dialogs that might be login prompts
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      const st = getComputedStyle(el);
      if (/dialog|modal|pop|mask|login|qr/i.test(c) && st.display !== "none" && el.offsetHeight > 80 && out.overlays.length < 5)
        out.overlays.push({ cls: c.slice(0, 60), text: (el.textContent || "").replace(/\s+/g, " ").slice(0, 60) });
    }
    for (const a of document.querySelectorAll("a[href]")) {
      const h = a.getAttribute("href") || "";
      if (/docId=|docid=|\/common|detail/i.test(h) && out.detailLinks.length < 5) out.detailLinks.push(h.slice(0, 130));
    }
    out.bodyHead = (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 300);
    return out;
  });
  console.log(JSON.stringify(dump, null, 1));
  console.log("api calls:");
  apis.slice(0, 15).forEach((a) => console.log("  ", a));
} catch (err) {
  console.error("list recon error:", String(err).slice(0, 300));
} finally {
  await browser.close();
}
