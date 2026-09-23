// Minimal internal HTTP API for the Auth Broker. The service never returns
// plaintext sessions and never logs auth material; crawler callers must present
// the broker token plus the lease token issued by acquire.
import { randomUUID } from "node:crypto";
import {
  acquireIdentityLease,
  browserProfileRef,
  ensureLegalIdentitySchema,
  recordIdentityFailure,
  releaseIdentityLease,
  upsertIdentity,
} from "./identity.js";
import { redactSessionJar, safeEquals, SessionJarError, validateSessionJar } from "./session-jar.js";

export function createPgIdentityOperations(client) {
  return {
    ensureSchema: () => ensureLegalIdentitySchema(client),
    upsertIdentity: (input, options) => upsertIdentity(client, input, options),
    acquireLease: (input) => acquireIdentityLease(client, input),
    releaseLease: (input) => releaseIdentityLease(client, input),
    recordFailure: (input) => recordIdentityFailure(client, input),
    getIdentity: async ({ source, accountId }) => {
      const result = await client.query(
        "SELECT * FROM legal_source_identity WHERE source=$1 AND account_id=$2",
        [source, accountId],
      );
      return result.rows[0] ?? null;
    },
  };
}

export function createMemorySessionStore() {
  const sessions = new Map();
  return {
    sessions,
    async put(session) {
      const key = `${session.source}\u0000${session.account_id}`;
      sessions.set(key, session);
      return session;
    },
    async get({ source, accountId }) {
      return sessions.get(`${source}\u0000${sessionAccountId(accountId)}`) ?? null;
    },
  };
}

function sessionAccountId(accountId) {
  return accountId;
}

async function readJsonBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) {
      const err = new Error("request body too large");
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const err = new Error("invalid JSON body");
    err.statusCode = 400;
    throw err;
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 1);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

function pathAfter(req, prefix) {
  const url = new URL(req.url, "http://internal");
  if (!url.pathname.startsWith(prefix)) return null;
  return url.pathname.slice(prefix.length).split("/").filter(Boolean);
}

function bearerToken(req) {
  const header = req.headers.authorization ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1] ?? null;
}

function requireBrokerToken(req, expectedToken) {
  if (!expectedToken) {
    return { ok: false, statusCode: 503, error: "AUTH_BROKER_TOKEN is not configured" };
  }
  const presented = bearerToken(req);
  if (!presented || !safeEquals(presented, expectedToken)) {
    return { ok: false, statusCode: 401, error: "invalid Auth Broker token" };
  }
  return { ok: true };
}

function identityPath(req) {
  const segments = pathAfter(req, "/identities");
  if (!segments || segments.length !== 2) return null;
  return { source: decodeURIComponent(segments[0]), accountId: decodeURIComponent(segments[1]) };
}

/**
 * Request handler is isolated from Node's HTTP server so it can be tested
 * without opening a socket.
 */
export function createAuthBrokerHandler({
  operations,
  sessionStore = null,
  brokerToken = process.env.LEGAL_AUTH_BROKER_TOKEN,
  log = () => {},
} = {}) {
  if (!operations?.acquireLease || !operations?.releaseLease || !operations?.getIdentity) {
    throw new Error("Auth Broker operations are incomplete");
  }
  return async function handleAuthBrokerRequest(req, res) {
    const startedAt = Date.now();
    const route = `${req.method} ${new URL(req.url, "http://internal").pathname}`;
    let statusCode = 500;
    let payload = { error: "internal error" };
    try {
      if (req.method === "GET" && route === "GET /health") {
        statusCode = 200;
        payload = { ok: true, service: "legal-auth-broker", time: new Date().toISOString() };
      } else {
        const auth = requireBrokerToken(req, brokerToken);
        if (!auth.ok) {
          statusCode = auth.statusCode;
          payload = { error: auth.error };
        } else if (req.method === "GET" && route === "GET /identities") {
          statusCode = 501;
          payload = { error: "identity listing is intentionally unimplemented; query by source/account" };
        } else if (req.method === "GET" && identityPath(req)) {
          const id = identityPath(req);
          const identity = await operations.getIdentity(id);
          if (!identity) {
            statusCode = 404;
            payload = { error: "identity not found" };
          } else {
            statusCode = 200;
            payload = {
              identity: redactSessionJar(identity),
              lease: identity.lease_token
                ? { owned: true, owner: identity.lease_owner, expires_at: identity.lease_expires_at }
                : { owned: false },
            };
          }
        } else if (req.method === "PUT" && identityPath(req)) {
          const id = identityPath(req);
          const input = await readJsonBody(req);
          const result = await operations.upsertIdentity({
            source: id.source,
            account_id: id.accountId,
            ...input,
          }, { actor: bearerTokenActor(req) });
          statusCode = 200;
          payload = {
            created: result.created,
            crossProxyAllowed: result.crossProxyAllowed,
            identity: redactSessionJar(result.identity),
          };
        } else if (req.method === "POST" && route === "POST /lease/acquire") {
          const input = await readJsonBody(req);
          const acquired = await operations.acquireLease({
            source: input.source,
            accountId: input.account_id,
            owner: input.owner ?? bearerTokenActor(req),
            ttlMs: Number(input.ttl_ms ?? 30 * 60 * 1000),
          });
          let sessionEnvelope = null;
          if (input.include_session && sessionStore) {
            const session = await sessionStore.get({ source: input.source, accountId: input.account_id });
            if (session) {
              // The store keeps ciphertext; acquire only hands it to a caller
              // that already proved broker identity and owns the fresh lease.
              sessionEnvelope = session.envelope ?? session;
            }
          }
          statusCode = 200;
          payload = { lease: acquired.lease, identity: redactSessionJar(acquired.identity), session_jar: sessionEnvelope };
        } else if (req.method === "POST" && route === "POST /lease/release") {
          const input = await readJsonBody(req);
          const identity = await operations.releaseLease({
            source: input.source,
            accountId: input.account_id,
            token: input.lease_token,
            outcome: input.outcome ?? "ok",
            reason: input.reason ?? null,
            failure: Boolean(input.failure),
          });
          statusCode = 200;
          payload = { released: true, identity: redactSessionJar(identity) };
        } else if (req.method === "POST" && route === "POST /session") {
          const input = await readJsonBody(req);
          if (!sessionStore) throw new SessionJarError("NO_STORE", "session store is not configured");
          const jar = validateSessionJar(input.session_jar);
          if (input.source && jar.source !== input.source) throw new SessionJarError("SOURCE_MISMATCH", "session source does not match route");
          if (input.account_id && jar.account_id !== input.account_id) throw new SessionJarError("ACCOUNT_MISMATCH", "session account does not match route");
          await sessionStore.put(jar);
          statusCode = 201;
          payload = { stored: true, fingerprint: input.fingerprint ?? null };
        } else if (req.method === "POST" && route === "POST /failure") {
          const input = await readJsonBody(req);
          const identity = await operations.recordFailure({
            source: input.source,
            accountId: input.account_id,
            reason: input.reason ?? "unspecified",
            status: input.status ?? "cooldown",
          });
          if (!identity) {
            statusCode = 404;
            payload = { error: "identity not found" };
          } else {
            statusCode = 200;
            payload = { marked: true, identity: redactSessionJar(identity) };
          }
        } else {
          statusCode = 404;
          payload = { error: "route not found" };
        }
      }
    } catch (err) {
      const mapped = mapBrokerError(err);
      statusCode = mapped.statusCode;
      payload = { error: mapped.error, code: err.code ?? null, status: err.status ?? null };
    }
    sendJson(res, statusCode, payload);
    log({
      route,
      status: statusCode,
      duration_ms: Date.now() - startedAt,
      // Never log request bodies, headers, tokens or cookies here.
    });
  };
}

function bearerTokenActor(req) {
  // Token material itself is never logged or persisted.
  return "broker-client";
}

function mapBrokerError(err) {
  switch (err?.code) {
    case "IDENTITY_NOT_FOUND":
      return { statusCode: 404, error: err.message };
    case "IDENTITY_LEASED":
      return { statusCode: 409, error: err.message };
    case "IDENTITY_NOT_ELIGIBLE":
      return { statusCode: 409, error: err.message };
    case "LEASE_MISMATCH":
      return { statusCode: 409, error: err.message };
    case "NO_KEY":
    case "NO_STORE":
      return { statusCode: 503, error: err.message };
    case "BAD_JAR":
    case "BAD_ENVELOPE":
      return { statusCode: 400, error: err.message };
    default:
      if (err?.statusCode) return { statusCode: err.statusCode, error: err.message };
      return { statusCode: 500, error: "internal Auth Broker error" };
  }
}

export async function startAuthBrokerServer(options, { host = "127.0.0.1", port = 8787 } = {}) {
  const { default: http } = await import("node:http");
  const handler = createAuthBrokerHandler(options);
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(port, host, resolve));
  return server;
}
