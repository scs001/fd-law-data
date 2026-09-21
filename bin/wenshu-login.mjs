#!/usr/bin/env node
// wenshu human-assisted login helper (spec: managed login session).
// Opens a HEADED browser on the operator machine; the human logs in (account
// password + slider) once; the Playwright storageState is uploaded to
// <wenshuBucket>/sessions/session.json for the cluster crawler. Credentials
// come from env/.env only, are prefilled best-effort, and are never printed.
//
// Logged-in detection (verified against the live site 2026-09-18): the list
// page redirects anonymous visitors to the login wall — a probe page that
// loads the list URL WITHOUT being redirected is the authoritative signal.
// Cookie heuristics false-positive: anonymous visitors get a cookie literally
// named "SESSION".
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { SESSION_KEY, uploadSession, cookieLifetimeSignals } from "../lib/wenshu/session.js";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

// Every wenshu selector lives here: the login UI drifts, so drift fixes
// should only ever touch this const. Missing selector => loud non-zero exit.
const SELECTORS = {
  loginEntry: '.list_tool a:has-text("登录"), a:has-text("登录"), button:has-text("登录")',
  ssoLoginUrl: "https://account.court.gov.cn/app#/login",
  usernameInput: "input.phone-number-input[name='username']",
  passwordInput: "input.password[name='password']",
  submitButton: "span.button.button-primary, .button-primary:has-text('登录')",
  // tianai captcha widget: this deployment uses WORD-CLICK (请依次点击),
  // not a slider — the human does the final clicks by design (design.md D2).
  captchaWidget: ".tianai-captcha-popup, .tianai-captcha-mask",
  captchaPrompt: ".tianai-captcha-tips, .tianai-captcha-word-click",
  sliderHandle: ".slider-btn, .tianai-slider-btn, [class*='slider-btn']",
  sliderTrack: ".slider-move, .tianai-slider-move, [class*='slider-move']",
};

const HOME_URL = "https://wenshu.court.gov.cn/";
// Real list page (live-verified 2026-09-18): s8=03 is 民事案件.
const LIST_URL = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?s8=03";
// The login wall: anonymous list access redirects here (page id) or to the
// account SSO host. Error page ("出错啦") also means the probe failed.
const isWalled = (url) => /181010CARHS5BS3C|account\.court\.gov\.cn|login|signin|passport/i.test(url);
const isErrorPage = async (page) =>
  /出错啦|页面不存在/.test((await page.locator("body").innerText({ timeout: 5000 }).catch(() => "")) || "");

const WAIT_MS = 10 * 60 * 1000; // 10 min for the human to finish login + slider
const POLL_MS = 3000;
// persisted profile keeps the human logged in across helper runs
const PROFILE_DIR = join(homedir(), ".cache", "fd-law-data", "wenshu-login-profile");

// Authoritative check: load the list page in a quiet probe tab; logged in
// iff we stay on the list URL AND the page shows result CONTENT. Verified
// live 2026-09-18: anonymous revisits do NOT redirect (the wall is a one-time
// device/WAF dance) but render an empty shell — URL alone is not a signal.
async function isLoggedIn(context) {
  let probe;
  try {
    probe = await context.newPage();
    let apiHit = false;
    probe.on("request", (r) => {
      if (/\/(api|restful|portalapi)\//i.test(r.url())) apiHit = true;
    });
    await probe.goto(LIST_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
    await probe.waitForTimeout(6000); // SPA settle + WAF text-verify
    const url = probe.url();
    if (isWalled(url)) return { ok: false, why: `walled:${url.slice(0, 90)}` };
    if (await isErrorPage(probe)) return { ok: false, why: "error-page" };
    const body = await probe.locator("body").innerText({ timeout: 8000 }).catch(() => "");
    if (!/共\s*[\d,]+\s*条/.test(body) && !apiHit) return { ok: false, why: "empty-shell-no-results" };
    return { ok: true, url };
  } catch (err) {
    return { ok: false, why: `probe-error:${String(err).slice(0, 80)}` };
  } finally {
    await probe?.close().catch(() => {});
  }
}

// Human-ish drag attempt on the tianai slider: press the handle, ease to the
// target x with jitter, release. Full-width and near-full-width candidates —
// tianai puzzle configs validate a server-side distance; low-risk sessions
// sometimes accept any completed drag. Returns true when the handle vanished
// (slider considered passed by the page).
async function attemptSlider(page) {
  const handle = page.locator(SELECTORS.sliderHandle).first();
  if (!(await handle.isVisible().catch(() => false))) return false;
  const track = page.locator(SELECTORS.sliderTrack).first();
  const trackBox = (await track.boundingBox().catch(() => null)) ?? (await handle.boundingBox());
  const handleBox = await handle.boundingBox();
  if (!handleBox || !trackBox) return false;
  const maxDist = trackBox.width - handleBox.width - 4;
  for (const frac of [0.92, 0.85, 0.78, 0.7]) {
    const dist = Math.max(20, Math.floor(maxDist * frac));
    await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    const steps = 24 + Math.floor(Math.random() * 10);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // easeInOutQuad
      await page.mouse.move(
        handleBox.x + handleBox.width / 2 + dist * ease + (Math.random() - 0.5) * 2,
        handleBox.y + handleBox.height / 2 + (Math.random() - 0.5) * 3,
      );
      await page.waitForTimeout(16 + Math.random() * 22);
    }
    await page.mouse.up();
    await page.waitForTimeout(1500);
    if (!(await handle.isVisible().catch(() => false))) return true; // passed / widget closed
    // reset for the next candidate if the handle reappeared
    const again = await handle.boundingBox().catch(() => null);
    if (again) Object.assign(handleBox, again);
  }
  return false;
}

// Auto-login attempt on the account SSO page (account from env only).
// Fills the form, clicks submit, and tries a drag ONLY if the captcha turns
// out to be slider-type. This deployment's tianai captcha is WORD-CLICK
// (click characters in order — verified live 2026-09-18), which is human-only
// by design; when that's what appears we return 'word-click' so the caller
// falls back to the headed human flow with everything pre-filled.
async function attemptAutoLogin(context, account) {
  const page = await context.newPage();
  try {
    await page.goto(SELECTORS.ssoLoginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(6000);
    await page.locator(SELECTORS.usernameInput).first().fill(account.user, { timeout: 10000 });
    await page.locator(SELECTORS.passwordInput).first().fill(account.pass, { timeout: 10000 });
    await page.locator(SELECTORS.submitButton).first().click({ timeout: 10000 });
    await page.waitForTimeout(3500);
    if ((await isLoggedIn(context)).ok) return { ok: true, page };
    const widget = page.locator(SELECTORS.captchaWidget).first();
    if (await widget.isVisible().catch(() => false)) {
      const isWordClick = await page
        .locator(".tianai-captcha-word-click, .tianai-captcha-tips:has-text('点击')")
        .first()
        .isVisible()
        .catch(() => false);
      if (isWordClick) return { ok: false, why: "word-click", page };
      if (await attemptSlider(page)) return { ok: (await isLoggedIn(context)).ok, why: "slider", page };
    }
    // one more submit round in case the captcha re-arms
    await page.locator(SELECTORS.submitButton).first().click({ timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(2500);
    return { ok: (await isLoggedIn(context)).ok, why: "retry", page };
  } catch (err) {
    return { ok: false, why: `error:${String(err).slice(0, 120)}`, page };
  }
}

async function main() {
  const cfg = loadConfig();
  const proxyUrl = arg("proxy", cfg.wenshuProxyUrl); // design D6 sticky exit; default direct
  if (proxyUrl === true) throw new Error("--proxy requires a URL argument");
  const proxy = proxyUrl ? { server: proxyUrl } : undefined;
  const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });

  let chromium;
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    throw new Error("playwright not installed — run: npm install playwright && npx playwright install chromium");
  }

  if (arg("logout-first", false)) {
    rmSync(PROFILE_DIR, { recursive: true, force: true }); // fresh login: wipe the profile
    console.log("profile cleared (--logout-first)");
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(PROFILE_DIR, { headless: false, proxy });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);

    // already logged in via the persisted profile? probe first, then upload
    let probe = await isLoggedIn(context);
    let captchaPage = null; // SSO tab the human is solving the captcha in
    if (probe.ok) {
      console.log("already logged in via saved profile — re-uploading the jar");
    } else {
      console.log(`probe: not logged in yet (${probe.why})`);
      const account = { user: cfg.wenshuAccountUser, pass: cfg.wenshuAccountPassword };
      if (account.user && account.pass) {
        console.log("attempting automatic login (account from env)…");
        const res = await attemptAutoLogin(context, account);
        captchaPage = res.page ?? null;
        probe = res.ok ? { ok: true } : await isLoggedIn(context);
        if (!probe.ok) {
          console.log(`auto-login stopped at: ${res.why ?? "not logged in"} — handing the open browser to the human`);
          console.log(
            ">>> 请在弹出的浏览器窗口里完成验证：按提示【依次点击】文字验证码中的汉字（如「确」「定」），" +
              `可能有多轮；验证码消失后我会自动检测（期间不再弹任何标签页）。最多等 ${WAIT_MS / 60000} 分钟`,
          );
        }
      }
    }
    if (!probe.ok) {
      // no account in env (or auto path errored before opening SSO): open the
      // SSO login page for the human from scratch
      if (!cfg.wenshuAccountUser) {
        const loginPage = await context.newPage();
        await loginPage.goto(SELECTORS.ssoLoginUrl, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        console.log(`>>> 请在打开的浏览器窗口里完成登录（输账号密码 + 文字点选验证）`);
      }
      const deadline = Date.now() + WAIT_MS;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        // NEVER probe (open tabs) while a captcha dialog is on screen — focus
        // stealing mid-click made the human's login impossible (live fix
        // 2026-09-19). isVisible() queries the existing page: invisible.
        if (captchaPage) {
          const busy = await captchaPage
            .locator(SELECTORS.captchaWidget)
            .first()
            .isVisible()
            .catch(() => false);
          if (busy) continue;
        }
        probe = await isLoggedIn(context);
        if (probe.ok) break;
      }
      if (!probe.ok) {
        throw new Error(
          `not logged in after ${WAIT_MS / 60000} min (list page still not rendering: ${probe.why}) — re-run and complete the login; ` +
            `useful flags: --logout-first (fresh login), --proxy <url>`,
        );
      }
    }

    const state = await context.storageState();
    const wrapper = await uploadSession({ s3, bucket: cfg.wenshuBucket, storageState: state, account: cfg.wenshuAccountUser || null });
    // cookie names + expiry only — values and credentials never leave the machine
    console.log(JSON.stringify(
      { savedAt: wrapper.savedAt, key: `${cfg.wenshuBucket}/${SESSION_KEY}`, loginSignal: "list-probe:ok", probeUrl: probe.url, cookies: cookieLifetimeSignals(wrapper) },
      null,
      1,
    ));
  } finally {
    await context?.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(`wenshu-login: ${err.message}`);
  process.exitCode = 1;
}
