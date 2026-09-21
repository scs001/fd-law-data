// Does the persistent PROFILE (not just cookies) still hold the session?
import { chromium } from "playwright";
import { homedir } from "node:os";
import { join } from "node:path";
const PROFILE = join(homedir(), ".cache", "fd-law-data", "wenshu-login-profile");
const browser = await chromium.launchPersistentContext(PROFILE, { headless: true });
const page = browser.pages()[0] ?? (await browser.newPage());
try {
  await page.goto("https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);
  const res = await page.evaluate(async () => ({
    stats: (document.querySelector(".statistics_list")?.textContent || "").replace(/\s+/g, " ").trim().slice(0, 180),
    hasLogout: [...document.querySelectorAll("a,span")].some((e) => /退出/.test(e.textContent || "")),
    sessionStorageKeys: Object.keys(sessionStorage || {}),
    idbNames: (() => { try { return "unchecked"; } catch { return "n/a"; } })(),
    localStorageKeys: Object.keys(localStorage || {}).slice(0, 12),
  }));
  console.log(JSON.stringify(res, null, 1));
} catch (e) {
  console.error("profile test error:", String(e).slice(0, 200));
} finally {
  await browser.close();
}
