#!/usr/bin/env node
// wenshu nightly supervisor — the Mac-side driver for the daily incremental
// crawl (change wenshu-incremental-crawl, archived 2026-09-20). A wenshu session
// lives in one browser and dies server-side when idle (~20 min) or when the site
// kills it after a burst of searches (found live 2026-09-20), so the jobs that
// cannot be separated all run in this one long-lived process:
//
//   keepalive  the standing Chrome (CDP 9223) is reloaded to home every 5 min;
//   watch      when the session is logged out the standing window is pointed at
//              the login form and probed every 30 s — the moment a login lands,
//              a crawl cycle starts by itself (no schedule wait, no human timing);
//   crawl      bin/wenshu-crawl.mjs --cdp-raw on the window below;
//   load       a clean crawl is followed by bin/wenshu-load.mjs with
//              PG_DATABASE=wenshu_db (the .env default is law_db), so the S3
//              JSONL reaches Postgres and touched months' blocks rebuild in the
//              same cycle.
//
// The window comes from the DATA: while wenshu_db's newest 判决时间 lags behind
// yesterday, the gap is walked one day at a time NEWEST-FIRST (the cursor only
// advances on a clean, fully-loaded day). Once the backlog is drained the steady
// state is a 7-day window each night — late uploads arrive days after their
// 裁判日期, and the crawl's seen-set makes the overlap cheap.
//
// Both halves are idempotent: seen.json dedupes documents across runs, the
// loader skips files that already carry a processed marker. A failed night
// therefore costs a retry, nothing else.
//
// Usage:
//   nohup node scripts/wenshu-nightly.mjs > /tmp/wenshu-nightly.log 2>&1 &
//   nohup node scripts/wenshu-nightly.mjs --run-now > … &     # crawl immediately
//   nohup node scripts/wenshu-nightly.mjs --idle --hold 60 > … &  # keepalive only
//   touch /tmp/wenshu-crawl-now                               # crawl as soon as possible
import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../lib/config.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, ".."); // fd-law-data
const CDP = process.env.WENSHU_CDP_URL ?? "http://localhost:9223";
const HOME = "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html";
const LOGIN = "https://wenshu.court.gov.cn/website/wenshu/181010CARHS5BS3C/index.html";
// 民事 list page: a session that can search is a session that can crawl.
const PROBE_URL = "https://wenshu.court.gov.cn/website/wenshu/181217BMTKHNT2W0/index.html?pageId=fde099276267316234622fb6d3f9557d&s8=03";
const STATE_PATH = "/tmp/wenshu-nightly-state.json";
const TRIGGER = "/tmp/wenshu-crawl-now";
const RETRY_MS = 30 * 60 * 1000; // session-invalid retry (human action needed)
const OVERLAP_DAYS = 2; // late-upload overlap in front of the PG high-water mark
const STEADY_WINDOW_DAYS = 3;
// How many times one worker repeats a day whose documents partly failed to render
// before the day is retired onto the mop-up list, and how many extra passes the
// mop-up itself gets before a day is left for a human.
const MAX_DAY_ATTEMPTS = 2;
const MOPUP_MAX_ATTEMPTS = 5;

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}

const idle = !!arg("idle"); // keepalive only: never crawl (maintenance window)
const clearBan = !!arg("clear-ban"); // human says the ban is resolved; start probing again
// Catalogue-only crawl: rows carry 标题/法院/案号/裁判日期/案件类型 + the document URL,
// never the full text. One request per five documents instead of one per document —
// the traffic profile this account can sustain.
const metaOnly = !!arg("meta-only");
// Crawl only inside this local window ("22:00-09:00", wrapping midnight). The
// account is the thing that gets banned, so the footprint is bounded by hours of
// activity per day, not by throughput. Off by default (24/7 backlog runs).
const windowArg = arg("window");
function parseWindow(v) {
  if (!v || v === true) return null;
  const m = String(v).match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
  if (!m) throw new Error(`--window expects HH:MM-HH:MM, got "${v}"`);
  return { start: Number(m[1]) * 60 + Number(m[2]), end: Number(m[3]) * 60 + Number(m[4]) };
}
const crawlWindow = parseWindow(windowArg);
const inCrawlWindow = (date = new Date()) => {
  if (!crawlWindow) return true;
  const min = date.getHours() * 60 + date.getMinutes();
  return crawlWindow.start <= crawlWindow.end
    ? min >= crawlWindow.start && min < crawlWindow.end
    : min >= crawlWindow.start || min < crawlWindow.end;
};
const nextWindowStart = (from = new Date()) => {
  if (!crawlWindow) return from.getTime();
  const t = new Date(from);
  t.setSeconds(0, 0);
  const cur = t.getHours() * 60 + t.getMinutes();
  t.setMinutes(t.getMinutes() + (((crawlWindow.start - cur + 1440) % 1440) || 1440));
  return t.getTime();
};
const at = String(arg("at", process.env.WENSHU_NIGHTLY_AT ?? "03:00"));
const lookback = Number(arg("lookback", 0)); // 0 = derive the window from PG
const rateMs = Number(arg("rate-ms", 1200));
const maxPages = Number(arg("max-pages", 400));
const workers = Math.max(1, Number(arg("workers", 1))); // parallel tabs in the standing Chrome
const budgetMs = Number(arg("budget-ms", 15 * 3600 * 1000));
const resultCap = Number(arg("result-cap", 200));
const caseTypes = String(arg("case-types", "民事,刑事,行政,执行,赔偿"));
const keepaliveMs = Number(arg("keepalive-ms", 5 * 60 * 1000));
const holdMs = Number(arg("hold", 0)) * 60 * 1000; // keepalive grace after start
const autoRelaunch = !arg("no-relaunch");
const fixedSince = arg("since") === true ? null : arg("since");
const fixedUntil = arg("until") === true ? null : arg("until");
let runNow = !!arg("run-now");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`[nightly ${new Date().toISOString()}] ${m}`);

// Restore the previous run's walk position: a restart (every code change, or a
// crash) must not send the backlog back to yesterday — the floor and the day
// cursor are the whole point of the state file.
function loadPrev() {
  try {
    const prev = JSON.parse(readFileSync(STATE_PATH, "utf8"));
    return prev && typeof prev === "object" ? prev : null;
  } catch {
    return null;
  }
}
const prevState = loadPrev();
const state = {
  ...(prevState ?? {}),
  startedAt: new Date().toISOString(),
  mode: idle ? "idle" : "scheduled",
  at,
  keepalives: prevState?.keepalives ?? 0,
  lastKeepaliveAt: prevState?.lastKeepaliveAt ?? null,
  dayCursor: prevState?.dayCursor ?? null, // backlog walk position, advanced only on clean days
  floor: prevState?.floor ?? null, // first backlog day, fixed once from the corpus end
  sessionInvalid: false,
  accountBannedAt: clearBan ? null : (prevState?.accountBannedAt ?? null), // set when the site bans the account
  banBackoffMs: clearBan ? 0 : (prevState?.banBackoffMs ?? 0),
  runs: Array.isArray(prevState?.runs) ? prevState.runs.slice(-19) : [],
  lastRun: prevState?.lastRun ?? null,
};
const persist = () => writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
persist();

// ---------------------------------------------------------------- PG high-water
// The newest 判决时间 already in wenshu_db is what the crawl window starts from.
async function pgHighWater() {
  const cfg = loadConfig();
  const { default: pg } = await import("pg");
  // The wenshu tables live in wenshu_db, while loadConfig() pulls PG_DATABASE
  // from .env (law_db) — so the database is named outright here. process.env is
  // no help: config.js has already loaded .env into it.
  const client = new pg.Client({ ...cfg.pg, port: Number(cfg.pg.port), database: "wenshu_db" });
  await client.connect();
  try {
    // Only the HISTORICAL corpus counts for the floor: rows loaded from our own
    // crawl files (path 'raw/%') must not move it, or yesterday's handful of docs
    // would make the older gap look already covered — which is exactly what
    // happened on the first run.
    const r = await client.query(
      `SELECT max(j.判决时间)::text AS m
         FROM judgments j
         JOIN src_files s ON s.src_id = j.src_id
        WHERE s.path NOT LIKE 'raw/%'`,
    );
    return r.rows[0]?.m ?? null;
  } finally {
    await client.end().catch(() => {});
  }
}

const addDays = (ymd, days) => {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const todayCst = () =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());

// ------------------------------------------------------------------- CDP glue
async function wenshuTabs() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  return list.filter((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
}

function evalIn(tab, expression, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) done(m.result?.result?.value); };
    ws.onerror = () => done(undefined);
    setTimeout(() => done(undefined), timeoutMs);
  });
}

function navigateIn(tab, url, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const ws = new WebSocket(tab.webSocketDebuggerUrl);
    const done = (v) => { try { ws.close(); } catch {} resolve(v); };
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: "Page.navigate", params: { url } }));
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id === 1) done(true); };
    ws.onerror = () => done(false);
    setTimeout(() => done(false), timeoutMs);
  });
}

async function chromeAlive() {
  try {
    await (await fetch(`${CDP}/json/version`)).json();
    return true;
  } catch {
    return false;
  }
}

// The session is bound to the standing browser; if it is gone (reboot, Cmd+Q)
// the only recovery is relaunching the profile — the login survives in it as
// long as it was promoted to a persistent cookie.
async function ensureChrome() {
  if (await chromeAlive()) return true;
  if (!autoRelaunch) {
    log(`standing Chrome is gone (CDP ${CDP}) and --no-relaunch is set`);
    return false;
  }
  log(`standing Chrome is gone — relaunching via scripts/wenshu-standalone.sh`);
  spawn("bash", [resolve(HERE, "wenshu-standalone.sh")], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 20; i++) {
    await sleep(3000);
    if (await chromeAlive()) {
      await sleep(4000); // let the profile open its first tab
      return true;
    }
  }
  return false;
}

// Point the standing window at the login form (once per logout episode) so a
// human only has to complete the captcha. The court SSO opens its own tab
// (account.court.gov.cn); only touch a wenshu tab that is NOT already in the
// login flow.
async function showLoginForm() {
  const tabs = await wenshuTabs().catch(() => []);
  const tab = tabs.find((t) => !/181010CARHS5BS3C/.test(t.url)) ?? tabs[0];
  if (!tab) return;
  const href = (await evalIn(tab, "location.href")) ?? "";
  if (!/181010CARHS5BS3C/.test(href)) await navigateIn(tab, LOGIN);
}

async function keepalive() {
  const tabs = await wenshuTabs().catch(() => []);
  const own = state.tabs ?? [];
  const tab =
    tabs.find((t) => !/181010CARHS5BS3C/.test(t.url) && !own.includes(t.id)) ??
    tabs.find((t) => !/181010CARHS5BS3C/.test(t.url)) ??
    tabs[0];
  if (!tab) return null;
  state.keepalives += 1;
  state.lastKeepaliveAt = new Date().toISOString();
  persist();
  await navigateIn(tab, HOME);
  return tab;
}

// Session ground truth is access, never page text. The logged-out home page also
// contains "欢迎您", which is how the supervisor spent a whole night telling
// itself a dead session was fine: 500+ cycles of four workers, every one of them
// refused with exit 42. Navigate the probe tab to the list page and read what it
// renders — result rows mean a session that may search, the login wall means
// signed out, and the site's own ban notice ("已对您的账号进行封禁") means the
// account is blocked: not a session problem at all, and retrying against it only
// adds traffic from a flagged account.
async function probeTab(tab) {
  if (!tab) return "unknown";
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt === 1) {
      // A long-lived tab can stop painting the result list entirely (the adapter
      // resets its tab for the same reason). Before declaring the session dead,
      // ask a brand-new background tab — the session lives in the profile, not in
      // the tab.
      const freshId = await createBrowserTab(PROBE_URL).catch(() => null);
      if (freshId) {
        await sleep(2500);
        const t = (await wenshuTabs().catch(() => [])).find((x) => x.id === freshId);
        if (t) tab = t;
      }
    }
    await navigateIn(tab, PROBE_URL);
    for (let i = 0; i < 10; i++) {
      await sleep(2000);
      const raw = await evalIn(
        tab,
        `JSON.stringify({
           wall: /181010CARHS5BS3C/.test(location.href),
           rows: document.querySelectorAll('.LM_list').length,
           banned: /已对您的账号进行封禁|账号存在违规行为/.test(document.body?.innerText || ''),
         })`,
      );
      try {
        const s = JSON.parse(raw);
        if (s.rows > 0) return "valid";
        if (s.banned) return "banned";
        if (s.wall) return "wall";
      } catch { /* page mid-navigation: poll again */ }
    }
  }
  return "unknown";
}

// --------------------------------------------------------------- child process
function runChild(args, extraEnv = {}, timeoutMs = 0) {
  return new Promise((resolve) => {
    const child = spawn("node", args, { cwd: ROOT, env: { ...process.env, ...extraEnv } });
    let out = "";
    let err = "";
    let killed = null;
    // A child that stops making progress must not freeze the night: after the
    // budget, SIGTERM then SIGKILL. Its uploaded day file still counts (the
    // caller classifies on the manifest, not on the exit code).
    const watchdog = timeoutMs > 0
      ? setTimeout(() => {
          killed = "watchdog";
          child.kill("SIGTERM");
          setTimeout(() => child.kill("SIGKILL"), 30000).unref();
        }, timeoutMs)
      : null;
    child.stdout.on("data", (d) => { out += d; process.stdout.write(d); });
    child.stderr.on("data", (d) => { err += d; process.stderr.write(d); });
    child.on("close", (code) => { if (watchdog) clearTimeout(watchdog); resolve({ code, out, err, killed }); });
  });
}

// The crawler ends its stdout with JSON.stringify({mode, manifest}, null, 1), i.e.
// `{\n "mode": "crawl", …` — not a `\n{\n` block, which is why the first runs
// logged "emitted null".
function lastJsonBlock(text) {
  let i = text.lastIndexOf('{\n "mode"');
  if (i < 0) i = text.lastIndexOf('{"mode"');
  if (i < 0) return null;
  try { return JSON.parse(text.slice(i).trim()); } catch { return null; }
}

function lastJsonLine(text) {
  const lines = text.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking up */ }
  }
  return null;
}

// ----------------------------------------------------------------- worker tabs
// Each worker drives its own BACKGROUND tab: one tab per process is mandatory
// (two crawlers sharing a tab would fight over its navigation), several tabs in
// one Chrome share the profile's login for free, and background creation never
// steals the operator's focus.
async function createBrowserTab(url) {
  const ver = await (await fetch(`${CDP}/json/version`)).json();
  const bws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r, j) => { bws.onopen = r; bws.onerror = j; });
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("Target.createTarget timeout")), 20000);
      bws.addEventListener("message", (ev) => {
        const m = JSON.parse(ev.data);
        if (m.id === 1) { clearTimeout(t); m.error ? reject(new Error(m.error.message)) : resolve(m.result.targetId); }
      });
      bws.send(JSON.stringify({ id: 1, method: "Target.createTarget", params: { url, background: true } }));
    });
  } finally {
    try { bws.close(); } catch {}
  }
}

async function ensureWorkerTabs(n) {
  if (n <= 1) return [];
  const live = new Set((await wenshuTabs().catch(() => [])).map((t) => t.id));
  const tabs = (state.tabs ?? []).filter((id) => live.has(id));
  while (tabs.length < n) {
    tabs.push(await createBrowserTab(HOME));
    await sleep(1500);
  }
  state.tabs = tabs;
  persist();
  return tabs;
}

// --------------------------------------------------------------------- cycle
// The site banned the account (its list page says so outright). Nothing about
// this is a session problem: a re-login, a refresh or another worker changes
// nothing, and every request from a flagged account is more evidence against it.
// So the crawl stops, the ban state persists, and only a human clears it.
function markBanned(detail) {
  if (!state.accountBannedAt) {
    state.accountBannedAt = new Date().toISOString();
    log(
      `ACCOUNT BANNED by the site (${detail}) — all crawling stopped. The site's notice: ` +
      `"由于检测到您的账号存在违规行为，已对您的账号进行封禁。如有疑问，请发邮件至 cpwsw@court.gov.cn 进行申诉". ` +
      `Appeal there, or switch to another account in the standing Chrome window; then clear the flag ` +
      `(state file ${STATE_PATH}: set accountBannedAt to null, or restart with --clear-ban) and the crawl resumes.`,
    );
  } else {
    log(`still banned (${detail})`);
  }
  state.sessionInvalid = true;
  state.banBackoffMs = Math.min((state.banBackoffMs ?? 6 * 3600 * 1000) * 2, 24 * 3600 * 1000);
  // One probe every 6-24 h: enough to notice an appealed or switched account,
  // far too sparse to matter to a site that has already flagged the account.
  state.banProbeAt = Date.now() + state.banBackoffMs;
  persist();
}

// Returns true when the cycle's window came back clean.
async function runCycle(whyRaw) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  if (!(await ensureChrome())) return false;

  const gateTab = await keepalive(); // fresh load: the DOM is only trustworthy after one
  await sleep(4000);
  const gate = await probeTab(gateTab);
  if (gate !== "valid") {
    state.lastRun = { startedAt, why: whyRaw, outcome: gate === "banned" ? "account-banned" : "session-invalid", durationMs: Date.now() - t0 };
    state.runs = [...state.runs.slice(-19), state.lastRun];
    if (gate === "banned") { markBanned("the list page answered with the site's ban notice"); return false; }
    state.sessionInvalid = true;
    persist();
    log("SESSION INVALID — no crawl. Complete the login in the standing Chrome window; the crawl starts itself once you are in.");
    return false;
  }
  state.sessionInvalid = false;
  state.accountBannedAt = null;
  state.banBackoffMs = 0;

  const until = fixedUntil ?? addDays(todayCst(), -1);
  if (!state.floor) {
    const high = await pgHighWater().catch((e) => { log(`corpus high-water query failed: ${e.message}`); return null; });
    state.floor = high ? addDays(high, 1) : addDays(until, -(STEADY_WINDOW_DAYS - 1));
    persist();
    log(`backlog floor set to ${state.floor} (corpus ends ${high ?? "unknown"})`);
  }

  const tabs = await ensureWorkerTabs(workers);
  const specs = [];
  if (fixedSince) {
    specs.push({ workerId: "w1", tabId: tabs[0], since: fixedSince, until: fixedUntil ?? until });
  } else if (lookback > 0) {
    specs.push({ workerId: "w1", tabId: tabs[0], since: addDays(until, -(lookback - 1)), until });
  } else {
    state.cursors = state.cursors ?? {};
    // Backlog first: each worker owns one residue class mod `workers` and walks
    // down to the floor, so every day of the gap is covered exactly once. Once
    // all workers are past the floor, the last STEADY_WINDOW_DAYS days are
    // re-scanned — day by day, newest first, not as one 7-day window, so every
    // day keeps its own file (and its own month's data blocks).
    for (let i = 0; i < workers; i++) {
      const wid = `w${i + 1}`;
      const day = state.cursors[wid] ?? addDays(until, -i);
      if (day >= state.floor) specs.push({ workerId: wid, tabId: tabs[i], since: day, until: day, day });
    }
    if (!specs.length) {
      // Mop-up before steady: days retired with missing documents get another
      // pass (a second listing retries only what never made it into the file).
      const pending = (state.incompleteDays ?? []).filter((d) => d >= state.floor);
      if (pending.length) {
        for (let i = 0; i < Math.min(workers, pending.length); i++) {
          specs.push({ workerId: `w${i + 1}`, tabId: tabs[i], since: pending[i], until: pending[i], day: pending[i], mopUp: true });
        }
      } else {
        state.steady = true;
        for (let i = 0; i < workers; i++) {
          const day = addDays(until, -(i % STEADY_WINDOW_DAYS));
          specs.push({ workerId: `w${i + 1}`, tabId: tabs[i], since: day, until: day, day, steady: true });
        }
      }
    }
  }
  state.lastWindow = { workers, specs: specs.map((x) => ({ w: x.workerId, since: x.since, until: x.until })) };
  persist();

  const runs = await Promise.all(
    specs.map(async (spec, i) => {
      const t0 = Date.now();
      const startedAt = new Date().toISOString();
      const label = spec.since === spec.until ? "(backlog day)" : "";
      // Stagger the starts: four workers opening search pages in the same second
      // is the shape of traffic a risk-control rule looks for.
      if (i > 0) await sleep(i * 8000);
      log(`crawl start (${whyRaw}) [${spec.workerId}] — window ${spec.since}..${spec.until} ${label}`.trim());
      const args = [
        "bin/wenshu-crawl.mjs", "--cdp-raw", CDP,
        "--since", spec.since, "--until", spec.until,
        "--no-regions", "--result-cap", String(resultCap), "--case-types", caseTypes,
        "--rate-ms", String(rateMs), "--max-pages", String(maxPages), "--budget-ms", String(budgetMs),
        "--worker-id", spec.workerId,
      ];
      if (metaOnly) args.push("--no-details");
      if (spec.tabId) args.push("--cdp-tab", spec.tabId);
      const c = await runChild(args, {}, budgetMs + 20 * 60 * 1000);
      const manifest = lastJsonBlock(c.out)?.manifest ?? null;
      // A manifest on stdout means crawl() returned and the day file is uploaded.
      // The exit code is then only diagnostics: a hung CDP detach (or the watchdog
      // killing such a process) must not throw away a day that is already in S3.
      const outcome = manifest ? "crawled"
        : c.code === 44 ? "account-banned"
        : c.code === 42 ? "session-invalid"
        : "crawl-failed";
      const run = {
        startedAt, why: whyRaw, worker: spec.workerId, window: { since: spec.since, until: spec.until },
        crawlExit: c.code, killed: c.killed ?? null, durationMs: Date.now() - t0,
        candidates: manifest?.candidates ?? null, emitted: manifest?.emitted ?? null,
        skippedSeen: manifest?.skippedSeen ?? null, errors: manifest?.counts?.errors ?? null,
        truncated: !!manifest?.truncated,
        outcome,
      };
      if (outcome === "crawled") {
        const anomaly = c.code === 0 ? "" : ` [child ${c.killed ? "killed by watchdog" : `exit ${c.code}`} after upload]`;
        log(`crawl done [${spec.workerId}] — emitted ${run.emitted} doc(s) of ${run.candidates} candidate(s)${run.truncated ? " (TRUNCATED by budget)" : ""}${anomaly}`);
      } else if (outcome === "account-banned") { log(`crawl refused [${spec.workerId}]: ACCOUNT BANNED (exit 44)`); markBanned(`worker ${spec.workerId} was refused`); }
      else if (outcome === "session-invalid") { log(`crawl refused [${spec.workerId}]: session invalid (exit 42)`); state.sessionInvalid = true; }
      else log(`crawl FAILED [${spec.workerId}] (exit ${c.code})`);
      return run;
    }),
  );

  // Loaders run one after another: each rebuilds the month's blocks, and two
  // rebuilds of the same month at once would race (same policy as before).
  for (let i = 0; i < specs.length; i++) {
    const run = runs[i];
    if (run.outcome !== "crawled") continue;
    log(`load start [${specs[i].workerId}] — wenshu-load.mjs (PG_DATABASE=wenshu_db)`);
    const l = await runChild(["bin/wenshu-load.mjs"], { PG_DATABASE: "wenshu_db" });
    run.loadExit = l.code;
    run.loadSummary = lastJsonLine(l.out) ?? null;
    log(l.code === 0 ? `load done [${specs[i].workerId}] — ${JSON.stringify(run.loadSummary)}` : `load FAILED [${specs[i].workerId}] (exit ${l.code})`);
    if (l.code !== 0) run.outcome = "load-failed";
  }

  for (const run of runs) {
    run.finishedAt = new Date().toISOString();
    state.lastRun = run;
    state.runs = [...state.runs.slice(-19), run];
  }
  // Advancement is per worker. A day whose per-doc fetches partly failed is
  // repeated by that worker only — the retry re-lists the day and re-fetches just
  // the docs that never made it into the file — while the other workers move on.
  // After MAX_DAY_ATTEMPTS the day is retired anyway and recorded: one document
  // that will not render must not pin a worker for the rest of the backfill.
  state.attempts = state.attempts ?? {};
  state.incompleteDays = state.incompleteDays ?? [];
  const oldest = addDays(until, -(STEADY_WINDOW_DAYS - 1));
  for (let i = 0; i < specs.length; i++) {
    const spec = specs[i];
    const run = runs[i];
    if (!spec.day || !run) continue;
    const loaded = run.outcome === "crawled" && !run.truncated && run.loadExit === 0;
    const errors = run.errors ?? 0;
    if (spec.mopUp) {
      // A mop-up day leaves the list only when it comes back complete, or after a
      // few more tries — a document that never renders must not be chased forever.
      if (loaded && errors === 0) {
        state.incompleteDays = state.incompleteDays.filter((d) => d !== spec.day);
        delete state.attempts[spec.day];
        log(`mop-up done: ${spec.day} is complete`);
      } else {
        state.attempts[spec.day] = (state.attempts[spec.day] ?? 0) + 1;
        if (state.attempts[spec.day] >= MOPUP_MAX_ATTEMPTS) {
          state.incompleteDays = state.incompleteDays.filter((d) => d !== spec.day);
          log(`mop-up gave up on ${spec.day} after ${state.attempts[spec.day]} attempts (${errors} doc(s) missing) — needs a manual look`);
          delete state.attempts[spec.day];
        }
      }
      continue;
    }
    if (loaded && errors > 0) {
      state.attempts[spec.day] = (state.attempts[spec.day] ?? 0) + 1;
      if (state.attempts[spec.day] < MAX_DAY_ATTEMPTS) {
        log(`day ${spec.day} kept for [${spec.workerId}] — ${errors} doc(s) missing, attempt ${state.attempts[spec.day]}/${MAX_DAY_ATTEMPTS}`);
        continue;
      }
      if (!state.incompleteDays.includes(spec.day)) state.incompleteDays.push(spec.day);
      log(`day ${spec.day} retired after ${state.attempts[spec.day]} attempts with ${errors} doc(s) missing — on the mop-up list`);
    }
    if (!loaded) continue;
    delete state.attempts[spec.day];
    const next = addDays(spec.day, -workers); // days are disjoint across workers
    if (!spec.steady) { state.cursors[spec.workerId] = next; continue; }
    // re-scan window: walk down through it, then wrap back to this worker's
    // newest day so the workers keep covering disjoint days
    state.cursors[spec.workerId] = next < oldest ? addDays(until, -(i % STEADY_WINDOW_DAYS)) : next;
  }
  persist();
  // "clean" for the scheduler: keep going right away unless a run was refused or
  // failed to load (session deaths are retried on RETRY_MS, not immediately).
  return runs.every((r) => r.outcome === "crawled" && r.loadExit === 0);
}

// ---------------------------------------------------------------------- main
function nextAt(from = new Date()) {
  const [hh, mm] = at.split(":").map(Number);
  const t = new Date(from);
  t.setHours(hh, mm, 0, 0);
  if (t.getTime() <= from.getTime()) t.setDate(t.getDate() + 1);
  return t.getTime();
}

log(
  idle
    ? `idle mode — keepalive every ${keepaliveMs / 60000} min, no crawl${holdMs ? `, hold ${holdMs / 60000} min` : ""} (CDP ${CDP})`
    : `watching — crawl at ${at} local (or the moment a login lands), keepalive every ${keepaliveMs / 60000} min (CDP ${CDP})`,
);
let nextAtMs = idle ? Number.POSITIVE_INFINITY : runNow ? Date.now() : nextAt();
runNow = false;
let holdUntil = Date.now() + holdMs;
let lastProbeAt = 0;

while (true) {
  const now = Date.now();
  try {
    if (existsSync(TRIGGER) && !idle) {
      rmSync(TRIGGER, { force: true });
      log("trigger file found — crawling now");
      nextAtMs = inCrawlWindow() ? now : (log("outside the crawl window — the trigger waits for it"), nextWindowStart());
    }
    if (now >= nextAtMs) {
      const clean = await runCycle(state.lastRun ? "retry" : "startup");
      // Mid-backlog (a day cursor is set) the next day starts right away; only the
      // steady state — where the cursor was retired — waits for the nightly slot.
      const backlogLeft = Object.values(state.cursors ?? {}).some((d) => d >= (state.floor ?? "9999-99-99"));
      nextAtMs = clean
        ? backlogLeft
          ? inCrawlWindow()
            ? now + 10 * 1000
            : (log(`outside the crawl window${windowArg && windowArg !== true ? ` ${windowArg}` : ""} — pausing`), nextWindowStart())
          : nextAt()
        : state.accountBannedAt
          ? Math.max(now + 60 * 1000, state.banProbeAt ?? 0)
          : state.sessionInvalid
            ? now + RETRY_MS
            : now + 60 * 1000;
      continue;
    }
    if (now >= holdUntil) {
      // Date.parse(null) is NaN — a fresh process would then never probe at all
      // (found live: the supervisor sat silent through a login it should have seen).
      const lastAct = state.lastKeepaliveAt ? Date.parse(state.lastKeepaliveAt) : 0;
      // While logged out, re-probe on a ramping interval: often enough to catch a
      // human finishing the login, far apart enough not to hammer the site from a
      // dead session (the old fixed 30 s cadence ran for eight hours). While the
      // account is banned, probes are hours apart on purpose: the ban notice is
      // the site's answer, and repeating the question does not help.
      const banned = !!state.accountBannedAt;
      const probeEvery = banned
        ? 0
        : state.sessionInvalid
          ? Math.min(state.probeBackoffMs ?? 60 * 1000, 10 * 60 * 1000)
          : keepaliveMs;
      const due = banned
        ? now >= (state.banProbeAt ?? 0)
        : state.sessionInvalid ? now - lastProbeAt >= probeEvery : now - lastAct >= keepaliveMs;
      if (due) {
        lastProbeAt = now;
        if (!(await ensureChrome())) {
          holdUntil = now + 5 * 60 * 1000;
        } else {
          // The probe navigates a tab to the list page and reads what renders:
          // rows mean a usable session, the login wall means signed out, and the
          // ban notice means the account itself is blocked. While signed out the
          // same navigation doubles as the login watcher: finish the login and the
          // next probe starts the crawl itself.
          const refreshed = await keepalive();
          const probeState = await probeTab(refreshed);
          if (probeState === "banned") {
            markBanned("probe landed on the site's ban notice");
            nextAtMs = Math.max(nextAtMs, state.banProbeAt ?? now);
          } else if (probeState !== "valid") {
            state.probeBackoffMs = Math.min((state.probeBackoffMs ?? 60 * 1000) * 2, 10 * 60 * 1000);
            if (!state.sessionInvalid) {
              state.sessionInvalid = true;
              persist();
              log("SESSION LOGGED OUT — the standing window now shows the login form; finish the login and the crawl starts by itself.");
              await showLoginForm();
            } else {
              persist();
            }
          } else if (state.sessionInvalid || state.probeBackoffMs || state.accountBannedAt) {
            state.sessionInvalid = false;
            state.probeBackoffMs = 0;
            if (state.accountBannedAt) {
              state.accountBannedAt = null;
              state.banBackoffMs = 0;
              state.banProbeAt = 0;
              log("the account works again (a probe rendered results) — ban flag cleared");
            }
            persist();
            if (idle) continue;
            if (!inCrawlWindow()) {
              log("LOGIN DETECTED — outside the crawl window, the crawl starts when it opens");
              nextAtMs = nextWindowStart();
              continue;
            }
            log("LOGIN DETECTED — starting a crawl cycle now");
            nextAtMs = now;
            continue;
          }
        }
      }
    }
  } catch (err) {
    log(`loop error: ${String(err?.message ?? err).slice(0, 300)}`);
  }
  await sleep(20000);
}
