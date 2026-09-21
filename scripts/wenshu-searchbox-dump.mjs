import { chromium } from "playwright";
const b = await chromium.launch({ channel: "chrome", headless: true, args: ["--no-first-run"] });
const p = await b.newPage();
await p.goto("https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html", { waitUntil: "domcontentloaded", timeout: 45000 });
await p.waitForTimeout(8000);
const box = await p.evaluate(() => {
  const w = document.querySelector(".search-wrapper");
  return w ? w.outerHTML.replace(/\s+/g, " ").slice(0, 1200) : "(no .search-wrapper)";
});
console.log(box);
await b.close();
