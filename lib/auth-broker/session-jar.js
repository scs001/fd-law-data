// Encrypted session jar and audit-safe rendering for Auth Broker sessions.
// The plaintext shape is held only in memory; object storage receives the
// AES-256-GCM envelope. Log/audit paths must use redactSessionJar().
import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";

const MAGIC = "FDLEGALAUTHJAR1";
const SENSITIVE_KEYS = new Set([
  "password", "passwd", "pass", "token", "usertoken", "accesstoken",
  "refreshtoken", "cookie", "cookies", "authorization", "proxyauthorization",
  "storagestate", "origins", "realname", "real_name", "idcard", "id_card",
  "mobilenumber", "mobile_number", "phone", "session_ref", "leasetoken",
]);

export class SessionJarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SessionJarError";
    this.code = code;
  }
}

function normalizeKeyMaterial(keyMaterial) {
  if (!keyMaterial) {
    throw new SessionJarError("NO_KEY", "LEGAL_AUTH_JAR_KEY is required (32-byte base64, 64-char hex, or passphrase)");
  }
  if (keyMaterial instanceof Buffer || Buffer.isBuffer(keyMaterial)) {
    if (keyMaterial.length !== 32) throw new SessionJarError("BAD_KEY", "session key Buffer must be 32 bytes");
    return keyMaterial;
  }
  const text = String(keyMaterial);
  if (/^[A-Fa-f0-9]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(text)) {
    const decoded = Buffer.from(text, "base64");
    if (decoded.length === 32) return decoded;
  }
  // Passphrases are supported for operator bootstrap, but a random 32-byte
  // base64 key is the production shape.
  return createHash("sha256").update(text, "utf8").digest();
}

export function encryptSessionJar(sessionJar, keyMaterial) {
  const key = normalizeKeyMaterial(keyMaterial);
  const plaintext = Buffer.from(JSON.stringify(sessionJar), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    magic: MAGIC,
    version: 1,
    alg: "A256GCM",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    created_at: new Date().toISOString(),
  };
}

export function decryptSessionJar(envelope, keyMaterial) {
  if (!envelope || envelope.magic !== MAGIC || envelope.alg !== "A256GCM") {
    throw new SessionJarError("BAD_ENVELOPE", "unrecognized legal auth session envelope");
  }
  try {
    const key = normalizeKeyMaterial(keyMaterial);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8"));
  } catch (err) {
    throw new SessionJarError("DECRYPT_FAILED", "session envelope failed authentication or decryption");
  }
}

export function validateSessionJar(jar) {
  const where = (field) => `session jar missing ${field}`;
  if (!jar?.version) throw new SessionJarError("BAD_JAR", where("version"));
  if (!jar.source) throw new SessionJarError("BAD_JAR", where("source"));
  if (!jar.account_id) throw new SessionJarError("BAD_JAR", where("account_id"));
  if (!jar.mode) throw new SessionJarError("BAD_JAR", where("mode"));
  if (jar.mode !== "session_jar" && jar.mode !== "browser_session_host" && jar.mode !== "proxy_bound_relay") {
    throw new SessionJarError("BAD_JAR", `invalid session mode: ${jar.mode}`);
  }
  if (!jar.proxy?.login_proxy_id || !jar.proxy?.crawl_proxy_id) {
    throw new SessionJarError("BAD_JAR", where("proxy identity"));
  }
  if (!jar.browser?.userAgent) throw new SessionJarError("BAD_JAR", where("browser.userAgent"));
  if (!Array.isArray(jar.storageState?.cookies)) throw new SessionJarError("BAD_JAR", where("storageState.cookies"));
  if (jar.mode === "session_jar") {
    if (!jar.auth?.headerName) throw new SessionJarError("BAD_JAR", where("auth.headerName"));
    if (!jar.auth?.userToken) throw new SessionJarError("BAD_JAR", where("auth.userToken"));
  }
  return jar;
}

// Recursively replaces sensitive values with stable type markers so audit
// output can still show shape without carrying credentials.
export function redactSessionJar(value, key = "") {
  const normalizedKey = String(key).replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (SENSITIVE_KEYS.has(normalizedKey)) {
    return Array.isArray(value)
      ? value.map(() => "[REDACTED]")
      : "[REDACTED]";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSessionJar(item, `${key}[]`));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([childKey, childValue]) => [childKey, redactSessionJar(childValue, childKey)]),
    );
  }
  return value;
}

export function sessionJarFingerprint(jar) {
  const material = JSON.stringify({
    source: jar?.source,
    account_id: jar?.account_id,
    proxy: jar?.proxy,
    browser: jar?.browser,
    auth: { headerName: jar?.auth?.headerName },
  });
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export function cookieHeaderFromSessionJar(jar) {
  const cookies = jar?.storageState?.cookies ?? [];
  const relevant = cookies.filter((cookie) => {
    if (!cookie?.name) return false;
    if (jar?.source?.startsWith("rmfyalk")) {
      return /(^|\.)court\.gov\.cn$/i.test(cookie.domain ?? "");
    }
    return true;
  });
  return relevant.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

export function authHeadersFromSessionJar(jar) {
  const headers = {};
  const cookie = cookieHeaderFromSessionJar(jar);
  if (cookie) headers.cookie = cookie;
  if (jar?.browser?.userAgent) headers["user-agent"] = jar.browser.userAgent;
  if (jar?.mode === "session_jar") {
    if (!jar.auth?.headerName || !jar.auth?.userToken) {
      throw new SessionJarError("BAD_JAR", "session_jar mode requires auth header and token");
    }
    headers[jar.auth.headerName] = jar.auth.userToken;
  }
  return headers;
}

export function safeEquals(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
