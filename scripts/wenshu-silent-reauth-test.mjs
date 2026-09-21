// D2 hypothesis test: with an expired wenshu SESSION but a live SSO
// HOLDONKEY in the jar, does the login wall silently re-issue a session
// (no captcha)? Ground truth for the cluster crawler's session strategy.
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
const hops = [];
page.on("framenavigated", (f) => { if (f === page.mainFrame()) hops.push(f.url().replace("https://", "").slice(0, 110)); });

try {
  await page.goto("https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(15000);
  const state = await page.evaluate(() => {
    const body = (document.body.textContent || "").replace(/\s+/g, " ");
    const captcha = !!document.querySelector(".tianai-captcha-popup, .tianai-captcha-word-click");
    const inputs = [...document.querySelectorAll("input:not([type=hidden])")].map((i) => i.className || i.type);
    return { url: location.href.slice(0, 120), hasCaptcha: captcha, visibleInputs: inputs.slice(0, 4), bodyHead: body.slice(0, 140), bodyLen: body.length };
  });
  const cookiesNow = (await context.storageState()).cookies.map((c) => `${c.name}@${c.domain.split(".")[0]}`);
  console.log(JSON.stringify({ final: state, hops: hops.slice(0, 8), cookiesAfter: cookiesNow }, null, 1));
} catch (e) {
  console.error("reauth test error:", String(e).slice(0, 250));
} finally {
  await browser.close();
}
