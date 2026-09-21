#!/usr/bin/env node
// Session-jar refresh from the OPERATOR'S OWN logged-in Chrome (the reliable
// path discovered 2026-09-19; see design.md "Live-site spike findings").
// Recipe: snapshot Chrome's cookie DB → promote SESSION/HOLDONKEY to
// persistent (Chrome drops session-scoped cookies on normal startup) →
// launch the REAL Chrome on the snapshot with CDP → extract cookies + wenshu
// localStorage via raw CDP (Playwright 1.63 cannot attach to Chrome 153) →
// upload the full jar to <wenshuBucket>/sessions/session.json.
// The session is activity-bound (idle sessions die in minutes): refresh
// immediately before a crawl run.
import { execSync } from "node:child_process";
import { rmSync, mkdirSync, cpSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../lib/config.js";
import { createS3 } from "../lib/s3.js";
import { uploadSession } from "../lib/wenshu/session.js";

const CHROME_DIR = join(homedir(), "Library/Application Support/Google/Chrome");
const PROFILE_SRC = process.env.WENSHU_CHROME_PROFILE || join(CHROME_DIR, "Profile 3");
const SCRATCH = "/tmp/wenshu-jar-refresh-profile";
const CDP_PORT = Number(process.env.WENSHU_JAR_CDP_PORT || 9341);

const sh = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

// 1) snapshot + promote session cookies to persistent
rmSync(SCRATCH, { recursive: true, force: true });
mkdirSync(join(SCRATCH, "Default"), { recursive: true });
sh(`sqlite3 "${join(PROFILE_SRC, "Cookies")}" ".backup '${join(SCRATCH, "Default/Cookies")}'"`);
const future = Math.floor((Date.now() / 1000 + 7 * 86400 + 11644473600) * 1e6);
sh(`sqlite3 "${join(SCRATCH, "Default/Cookies")}" "UPDATE cookies SET is_persistent=1, has_expires=1, expires_utc=${future} WHERE name IN ('SESSION','HOLDONKEY');"`);
cpSync(join(CHROME_DIR, "Local State"), join(SCRATCH, "Local State"));
for (const d of ["Local Storage", "Session Storage"]) {
  try { cpSync(join(PROFILE_SRC, d), join(SCRATCH, "Default", d), { recursive: true }); } catch { /* optional */ }
}

// 2) launch the real Chrome on the snapshot with a wenshu tab open
execSync(
  `open -na "Google Chrome" --args --user-data-dir=${SCRATCH} --remote-debugging-port=${CDP_PORT} --no-first-run --profile-directory=Default "https://wenshu.court.gov.cn/website/wenshu/181029CR4M5A62CH/index.html"`,
);
await new Promise((r) => setTimeout(r, 12000));

// 3) raw-CDP extraction (cookies + wenshu localStorage)
const list = await (await fetch(`http://localhost:${CDP_PORT}/json/list`)).json();
const target = list.find((t) => t.url.includes("wenshu.court.gov.cn") && t.type === "page");
if (!target) throw new Error(`no wenshu tab in the CDP browser (tabs: ${list.map((t) => t.url.slice(0, 40)).join(", ")})`);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
let seq = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, resolve);
  setTimeout(() => { pending.delete(id); reject(new Error("timeout " + method)); }, 25000);
  ws.send(JSON.stringify({ id, method, params }));
});

const { cookies } = await call("Network.getAllCookies");
const lsEval = await call("Runtime.evaluate", { expression: "JSON.stringify(localStorage)", returnByValue: true });
const ls = JSON.parse(lsEval.result.value || "{}");
ws.close();
execSync(`pkill -f "user-data-dir=${SCRATCH}"`); // close the scratch Chrome

const court = cookies.filter((c) => c.domain.includes("court.gov.cn"));
console.error(`[jar-refresh] court cookies: ${court.map((c) => c.name).join(", ") || "(none)"}; localStorage keys: ${Object.keys(ls).join(", ") || "(none)"}`);
if (!court.some((c) => c.name === "SESSION")) throw new Error("no SESSION cookie — is the operator Chrome logged in to wenshu?");
if (!Object.keys(ls).length) throw new Error("wenshu localStorage empty — the tab did not hydrate; retry");

// 4) upload the full jar (Playwright storageState format: localStorage = ARRAY)
const sameSite = (v) => (v === "Strict" || v === "Lax" || v === "None" ? v : "Lax");
const storageState = {
  cookies: cookies.map((c) => ({
    name: c.name, value: c.value, domain: c.domain, path: c.path,
    expires: c.expires && c.expires > 0 ? c.expires : -1,
    httpOnly: !!c.httpOnly, secure: !!c.secure, sameSite: sameSite(c.sameSite),
  })),
  origins: [{ origin: "https://wenshu.court.gov.cn", localStorage: Object.entries(ls).map(([name, value]) => ({ name, value: String(value) })) }],
};
const cfg = loadConfig();
const s3 = createS3({ endpoint: cfg.s3Endpoint, accessKey: cfg.s3AccessKey, secretKey: cfg.s3SecretKey, region: cfg.s3Region });
const wrapper = await uploadSession({ s3, bucket: cfg.wenshuBucket, storageState, account: cfg.wenshuAccountUser || null });
console.log(JSON.stringify({ uploaded: wrapper.savedAt, key: `sessions/session.json`, courtCookies: court.map((c) => c.name), localStorageKeys: Object.keys(ls) }, null, 1));
