// State-machine unit tests for lib/wenshu/session.js: fakes only — no
// playwright, no network (spec: fail-loud session handling, never crawl
// logged-out, credentials never logged).
import test from "node:test";
import assert from "node:assert/strict";
import {
  SESSION_KEY,
  SessionError,
  uploadSession,
  downloadSession,
  cookieLifetimeSignals,
  ensureSession,
} from "../lib/wenshu/session.js";

const BUCKET = "wenshu";

// minimal fake of the lib/s3.js surface session.js relies on
function fakeS3() {
  const store = new Map();
  const puts = [];
  return {
    store,
    puts,
    async getObject(bucket, key) {
      return store.get(`${bucket}/${key}`) ?? null;
    },
    async putObject(bucket, key, body) {
      puts.push(key);
      store.set(`${bucket}/${key}`, Buffer.from(body));
      return { etag: '"fake"' };
    },
    async headObject(bucket, key) {
      const b = store.get(`${bucket}/${key}`);
      return b ? { contentLength: b.length } : null;
    },
  };
}

// cookie value length varies so re-login jars differ in size from seeds
// (putIfChanged skips uploads on equal content-length)
const storageState = (n = 1) => ({
  cookies: [{ name: "CFGG", value: "v".repeat(n), domain: ".court.gov.cn", expires: -1 }],
  origins: [],
});

const account = { user: "u1", pass: "p1" };
const isSessionError = (code, extra = /bin\/wenshu-login\.mjs/) => (err) =>
  err instanceof SessionError && err.code === code && extra.test(err.message);

test("uploadSession -> downloadSession roundtrip via fake s3", async () => {
  const s3 = fakeS3();
  const up = await uploadSession({ s3, bucket: BUCKET, storageState: storageState(), account: "op" });
  assert.equal(up.version, 1);
  assert.match(up.savedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
  const down = await downloadSession({ s3, bucket: BUCKET });
  assert.equal(down.account, "op");
  assert.deepEqual(down.storageState, storageState());
  assert.deepEqual(s3.puts, [SESSION_KEY]);
  assert.equal(await downloadSession({ s3, bucket: "other" }), null); // missing key -> null
});

test("cookieLifetimeSignals reports names/domains and ISO expiry only", () => {
  const wrapper = {
    storageState: {
      cookies: [
        { name: "CFGG", domain: ".court.gov.cn", expires: 1800000000 },
        { name: "some-session", domain: ".court.gov.cn", expires: -1 },
      ],
      origins: [],
    },
  };
  assert.deepEqual(cookieLifetimeSignals(wrapper), [
    { name: "CFGG", domain: ".court.gov.cn", expiresIso: new Date(1800000000 * 1000).toISOString() },
    { name: "some-session", domain: ".court.gov.cn", expiresIso: null },
  ]);
  assert.deepEqual(cookieLifetimeSignals(null), []);
});

test("(a) valid jar on first try: applied, probed, returned — no relogin, no upload", async () => {
  const s3 = fakeS3();
  const seeded = await uploadSession({ s3, bucket: BUCKET, storageState: storageState(2) });
  const applied = [];
  let relogins = 0;
  const res = await ensureSession({
    s3,
    bucket: BUCKET,
    account: null,
    applyJar: async (st) => applied.push(st),
    probe: async () => ({ valid: true }),
    attemptRelogin: async () => {
      relogins += 1;
      return storageState(9);
    },
  });
  assert.deepEqual(res, seeded);
  assert.deepEqual(applied, [seeded.storageState]);
  assert.equal(relogins, 0);
  assert.equal(s3.puts.length, 1); // only the seed
});

test("(b) no jar and no account: SessionError NO_JAR with operator pointer", async () => {
  const s3 = fakeS3();
  await assert.rejects(
    ensureSession({
      s3,
      bucket: BUCKET,
      account: null,
      applyJar: async () => {},
      probe: async () => ({ valid: true }),
      attemptRelogin: async () => storageState(9),
    }),
    isSessionError("NO_JAR"),
  );
});

test("(c) no jar with account: relogin, upload, apply, return fresh wrapper", async () => {
  const s3 = fakeS3();
  const applied = [];
  const fresh = storageState(7);
  let seenAccount = null;
  const res = await ensureSession({
    s3,
    bucket: BUCKET,
    account,
    applyJar: async (st) => applied.push(st),
    probe: async () => ({ valid: true }),
    attemptRelogin: async ({ account: acc, onSlider }) => {
      seenAccount = acc;
      assert.equal(typeof onSlider, "function");
      return fresh;
    },
  });
  assert.deepEqual(seenAccount, account);
  assert.deepEqual(applied, [fresh]);
  assert.equal(res.account, "u1");
  assert.deepEqual(res.storageState, fresh);
  const stored = await downloadSession({ s3, bucket: BUCKET });
  assert.equal(stored.account, "u1");
  assert.deepEqual(stored.storageState, fresh);
});

test("(d) stale jar without account: SessionError EXPIRED naming the refresh procedure", async () => {
  const s3 = fakeS3();
  await uploadSession({ s3, bucket: BUCKET, storageState: storageState(2) });
  await assert.rejects(
    ensureSession({
      s3,
      bucket: BUCKET,
      account: null,
      applyJar: async () => {},
      probe: async () => ({ valid: false, reason: "no CFGG cookie" }),
      attemptRelogin: async () => storageState(9),
    }),
    isSessionError("EXPIRED"),
  );
});

test("(e) stale jar + relogin hits slider (throws): SLIDER propagates, nothing uploaded", async () => {
  const s3 = fakeS3();
  await uploadSession({ s3, bucket: BUCKET, storageState: storageState(2) });
  const applied = [];
  await assert.rejects(
    ensureSession({
      s3,
      bucket: BUCKET,
      account,
      applyJar: async (st) => applied.push(st),
      probe: async () => ({ valid: false, reason: "no CFGG cookie" }),
      attemptRelogin: async ({ onSlider }) => {
        onSlider();
        throw new SessionError("SLIDER", "slider frame detected");
      },
    }),
    isSessionError("SLIDER"),
  );
  assert.equal(s3.puts.length, 1); // only the seed — the fail-loud path never uploads
  assert.equal(applied.length, 1); // stale jar applied once, then bail
});

test("relogin reporting a slider via onSlider (no throw) also fails loud as SLIDER", async () => {
  const s3 = fakeS3();
  await uploadSession({ s3, bucket: BUCKET, storageState: storageState(2) });
  await assert.rejects(
    ensureSession({
      s3,
      bucket: BUCKET,
      account,
      applyJar: async () => {},
      probe: async () => ({ valid: false }),
      attemptRelogin: async ({ onSlider }) => {
        onSlider();
        return storageState(9); // "succeeds" despite the slider — still fatal
      },
    }),
    isSessionError("SLIDER"),
  );
  assert.equal(s3.puts.length, 1);
});

test("(f) relogin succeeds but probe stays invalid: RELOGIN_FAILED, fresh jar applied+uploaded", async () => {
  const s3 = fakeS3();
  await uploadSession({ s3, bucket: BUCKET, storageState: storageState(2) });
  const applied = [];
  const reasons = ["no CFGG cookie", "no CFGG cookie"];
  await assert.rejects(
    ensureSession({
      s3,
      bucket: BUCKET,
      account,
      applyJar: async (st) => applied.push(st),
      probe: async () => ({ valid: false, reason: reasons.shift() }),
      attemptRelogin: async () => storageState(9),
    }),
    isSessionError("RELOGIN_FAILED"),
  );
  assert.equal(applied.length, 2); // stale jar, then the relogged jar
  assert.equal(s3.puts.length, 2); // seed + fresh jar
});

test("(f') probe reporting expiry after relogin maps to EXPIRED", async () => {
  const s3 = fakeS3();
  await uploadSession({ s3, bucket: BUCKET, storageState: storageState(2) });
  const reasons = ["stale", "session expired again"];
  await assert.rejects(
    ensureSession({
      s3,
      bucket: BUCKET,
      account,
      applyJar: async () => {},
      probe: async () => ({ valid: false, reason: reasons.shift() }),
      attemptRelogin: async () => storageState(9),
    }),
    isSessionError("EXPIRED"),
  );
});

test("(g) corrupt jar JSON: downloadSession returns null (treated as missing)", async () => {
  const s3 = fakeS3();
  s3.store.set(`${BUCKET}/${SESSION_KEY}`, Buffer.from("{not json"));
  assert.equal(await downloadSession({ s3, bucket: BUCKET }), null);
});
