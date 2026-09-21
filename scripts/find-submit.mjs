import { chromium } from "playwright";
import { loadConfig } from '/Users/chengsishi/finddata/fd-law-data/lib/config.js';
const cfg = loadConfig();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.goto("https://account.court.gov.cn/app#/login", { waitUntil: "domcontentloaded", timeout: 45000 });
await page.waitForTimeout(9000);
await page.locator("input.phone-number-input[name='username']").first().fill(cfg.wenshuAccountUser, { timeout: 10000 });
await page.locator("input.password[name='password']").first().fill(cfg.wenshuAccountPassword, { timeout: 10000 });
await page.waitForTimeout(1000);
const hits = await page.evaluate(() => {
  const out = [];
  for (const el of document.querySelectorAll("*")) {
    const own = [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join("").trim();
    if (/^登\s*录$/.test(own)) {
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), id: el.id, visible: st.display !== "none" && r.width > 0, rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } });
    }
  }
  // also any element whose class mentions submit/login-btn
  for (const el of document.querySelectorAll("[class]")) {
    const c = String(el.className);
    if (/submit|login-btn|loginbtn|btn-login/i.test(c)) {
      const r = el.getBoundingClientRect();
      out.push({ tag: el.tagName, cls: c.slice(0, 60), id: el.id, from: "class", visible: r.width > 0 });
    }
  }
  return out;
});
console.log("submit:", JSON.stringify(hits, null, 1));
// click it and dump whatever captcha appears
await page.locator("span.button.button-primary").first().click();
await page.waitForTimeout(4000);
const cap = await page.evaluate(() => {
  const out = { dialogs: [], sliderBits: [] };
  for (const el of document.querySelectorAll("[class]")) {
    const c = String(el.className);
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (/captcha|slider|verify|nc_/i.test(c) && st.display !== "none" && r.width > 0) {
      out.sliderBits.push({ tag: el.tagName, cls: c.slice(0, 70), w: Math.round(r.width), h: Math.round(r.height), text: (el.textContent||"").replace(/\s+/g," ").slice(0,30) });
    }
  }
  out.bodyHead = (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 200);
  return out;
});
console.log("captcha DOM:", JSON.stringify(cap, null, 1));
await browser.close();
