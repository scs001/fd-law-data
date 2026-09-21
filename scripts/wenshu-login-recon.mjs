#!/usr/bin/env node
// Recon pass 4: dump the account.court.gov.cn login page DOM — input fields,
// tabs (password vs SMS vs QR), submit button, slider container classes — so
// the auto-login can target real selectors. Read-only: no typing, no clicks.
import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  // Direct to the account SSO login route.
  await page.goto("https://account.court.gov.cn/app#/login", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(10000);
  const target = page;
  console.log("NAV url:", target.url());
  const accFrame = target.frames().find((f) => f.url().includes("account.court.gov.cn"));
  console.log("account frame url:", accFrame?.url() || "(not found)");
  if (accFrame) {
    await accFrame.waitForTimeout(5000);
    const fdump = await accFrame.evaluate(() => {
      const out = { inputs: [], buttons: [], tabs: [], slider: [], qr: [] };
      for (const i of document.querySelectorAll("input")) out.inputs.push({ type: i.type, cls: String(i.className).slice(0, 40), id: i.id, ph: i.placeholder, name: i.name });
      for (const b of document.querySelectorAll("button,[role=button],a.btn")) {
        const t = (b.textContent || "").replace(/\s+/g, " ").trim();
        if (t && t.length <= 14) out.buttons.push({ tag: b.tagName, cls: String(b.className).slice(0, 40), text: t });
      }
      for (const el of document.querySelectorAll("[class]")) {
        const c = String(el.className);
        const t = (el.textContent || "").replace(/\s+/g, " ").trim();
        if (/tab/i.test(c) && t.length <= 12 && out.tabs.length < 6) out.tabs.push({ cls: c.slice(0, 40), text: t });
        if (/slider|nc_|captcha|verify|drag|slide/i.test(c) && out.slider.length < 8) out.slider.push({ tag: el.tagName, cls: c.slice(0, 60), id: el.id, text: t.slice(0, 24) });
        if (/qr|code|scan/i.test(c) && el.children.length === 0 && out.qr.length < 4) out.qr.push({ cls: c.slice(0, 50) });
      }
      out.bodyHead = (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 220);
      return out;
    });
    console.log("ACCOUNT FRAME DUMP:", JSON.stringify(fdump, null, 1));
  }
  const dump = await target.evaluate(() => {
    const out = { inputs: [], buttons: [], tabs: [], slider: [], forms: [], iframes: [] };
    for (const f of document.querySelectorAll("iframe")) out.iframes.push(f.src.slice(0, 130));
    for (const i of document.querySelectorAll("input")) out.inputs.push({ type: i.type, cls: String(i.className).slice(0, 50), id: i.id, ph: i.placeholder, name: i.name });
    for (const b of document.querySelectorAll("button, a[class], [role=button]")) {
      const t = (b.textContent || "").replace(/\s+/g, " ").trim();
      if (t && t.length <= 12) out.buttons.push({ tag: b.tagName, cls: String(b.className).slice(0, 50), id: b.id, text: t });
    }
    for (const el of document.querySelectorAll("[class]")) {
      const c = String(el.className);
      const t = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (/tab|switch|sms|短信|扫码|密码登录/i.test(c + t) && t.length <= 16 && out.tabs.length < 8) out.tabs.push({ cls: c.slice(0, 50), text: t });
      if (/slider|nc_|captcha|verify|drag|slide/i.test(c) && out.slider.length < 8) out.slider.push({ tag: el.tagName, cls: c.slice(0, 70), id: el.id, text: t.slice(0, 30) });
    }
    for (const f of document.querySelectorAll("form")) out.forms.push({ action: (f.action || "").slice(0, 100), cls: String(f.className).slice(0, 50) });
    out.bodyHead = (document.body.textContent || "").replace(/\s+/g, " ").slice(0, 250);
    return out;
  });
  console.log(JSON.stringify(dump, null, 1));
} catch (err) {
  console.error("login recon error:", String(err).slice(0, 300));
} finally {
  await browser.close();
}
