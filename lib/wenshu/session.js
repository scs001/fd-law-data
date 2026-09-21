// Session jar handling + the fail-loud session state machine (spec: managed
// login session; a stale session NEVER crawls logged-out). The s3 client is
// injected by the caller — this module never builds one, and account
// credentials are never logged or persisted beyond the wrapper's username.
import { putIfChanged } from "../s3.js";

export const SESSION_KEY = "sessions/session.json";

export class SessionError extends Error {
  // codes: NO_JAR | EXPIRED | SLIDER | RELOGIN_FAILED
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = "SessionError";
  }
}

// Operator escape hatch named in every error message: the slider needs a
// human, so each failure must point at the exact command to run.
const REFRESH_CMD = "node bin/wenshu-login.mjs";
const SLIDER_MSG =
  `wenshu slider captcha blocked automatic re-login — a human must refresh the session: ` +
  `run \`${REFRESH_CMD}\` and pass the slider once`;

// wrapper persisted to S3: { version, savedAt, account, storageState } where
// storageState is the Playwright storageState ({cookies, origins}).
export async function uploadSession({ s3, bucket, storageState, account = null }) {
  const wrapper = { version: 1, savedAt: new Date().toISOString(), account: account ?? null, storageState };
  // putIfChanged skips on equal content-length; the fresh savedAt keeps the
  // jar moving in practice, and a skipped upload only costs one extra
  // re-login on the next run (still fail-loud, never logged-out crawling).
  await putIfChanged(s3, bucket, SESSION_KEY, JSON.stringify(wrapper, null, 1), { contentType: "application/json" });
  return wrapper;
}

export async function downloadSession({ s3, bucket }) {
  const buf = await s3.getObject(bucket, SESSION_KEY);
  if (!buf) return null;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch (err) {
    // corrupt jar behaves like a missing one: force re-login, never crawl
    console.error(`wenshu session: corrupt jar at ${bucket}/${SESSION_KEY} (${err.message}); treating as missing`);
    return null;
  }
}

// Session-lifetime recon for the spike task/runbook: cookie names, domains
// and expiry only — values are never exposed.
export function cookieLifetimeSignals(wrapper) {
  const cookies = wrapper?.storageState?.cookies ?? [];
  return cookies.map((c) => ({
    name: c.name,
    domain: c.domain,
    // Playwright uses unix seconds; -1/undefined means a session cookie
    expiresIso: typeof c.expires === "number" && c.expires > 0 ? new Date(c.expires * 1000).toISOString() : null,
  }));
}

// Automatic re-login wrapper: a slider is reported either via the onSlider
// callback or by throwing SessionError("SLIDER") — both become a loud,
// operator-actionable SLIDER failure. No slider is ever solved here.
async function relogin({ account, attemptRelogin }) {
  let slider = false;
  const onSlider = () => {
    slider = true;
  };
  let storageState;
  try {
    storageState = await attemptRelogin({ account, onSlider });
  } catch (err) {
    if (slider || err?.code === "SLIDER" || err?.slider) throw new SessionError("SLIDER", SLIDER_MSG);
    if (err instanceof SessionError) throw err;
    throw new SessionError(
      "RELOGIN_FAILED",
      `automatic re-login failed (${err?.message ?? err}) — refresh the session: run \`${REFRESH_CMD}\` (add --logout-first for a clean login)`,
    );
  }
  if (slider) throw new SessionError("SLIDER", SLIDER_MSG);
  return storageState;
}

// account: {user, pass} | null (env/Secret only).
// applyJar: async (storageState) => void — browser-context glue from caller.
// probe: async () => ({valid, reason?}) — cheap logged-in check.
// attemptRelogin: async ({account, onSlider}) => storageState — form login
// without solving sliders; MUST call onSlider() when a slider appears.
// -> the validated wrapper; throws SessionError otherwise (fail loud).
export async function ensureSession({ s3, bucket, account, applyJar, probe, attemptRelogin }) {
  const jar = await downloadSession({ s3, bucket });

  if (!jar) {
    if (!account) {
      throw new SessionError(
        "NO_JAR",
        `no wenshu session jar at ${bucket}/${SESSION_KEY} and no account configured — ` +
          `run \`${REFRESH_CMD}\` on the operator machine (headed browser; a human passes the slider once)`,
      );
    }
    const storageState = await relogin({ account, attemptRelogin });
    const wrapper = await uploadSession({ s3, bucket, storageState, account: account.user });
    await applyJar(storageState);
    return wrapper;
  }

  await applyJar(jar.storageState);
  const p = await probe();
  if (p.valid) return jar;

  if (!account) {
    throw new SessionError(
      "EXPIRED",
      `wenshu session jar at ${bucket}/${SESSION_KEY} is stale (${p.reason ?? "probe invalid"}) and no account ` +
        `is configured for automatic re-login — refresh it: run \`${REFRESH_CMD}\` (add --logout-first if the old login sticks)`,
    );
  }

  const storageState = await relogin({ account, attemptRelogin });
  const wrapper = await uploadSession({ s3, bucket, storageState, account: account.user });
  await applyJar(storageState);
  const p2 = await probe();
  if (p2.valid) return wrapper;
  const code = /expir/i.test(p2.reason ?? "") ? "EXPIRED" : "RELOGIN_FAILED";
  throw new SessionError(
    code,
    `automatic re-login finished but the session still fails validation (${p2.reason ?? "probe invalid"}) — ` +
      `refresh it manually: run \`${REFRESH_CMD}\` (add --logout-first for a clean login)`,
  );
}
