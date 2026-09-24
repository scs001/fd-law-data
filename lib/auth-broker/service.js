// Minimal internal HTTP API for the Auth Broker. The service never returns
// plaintext sessions and never logs auth material; crawler callers must present
// the broker token plus the lease token issued by acquire.
import { randomUUID } from "node:crypto";
import {
  acquireIdentityLease,
  browserProfileRef,
  ensureLegalIdentitySchema,
  recordIdentityFailure,
  recordModeSelection,
  releaseIdentityLease,
  SESSION_MODES,
  upsertIdentity,
} from "./identity.js";
import {
  authHeadersFromSessionJar,
  decryptSessionJar,
  redactSessionJar,
  safeEquals,
  SessionJarError,
  validateSessionJar,
} from "./session-jar.js";

export function createPgIdentityOperations(client) {
  return {
    ensureSchema: () => ensureLegalIdentitySchema(client),
    upsertIdentity: (input, options) => upsertIdentity(client, input, options),
    acquireLease: (input) => acquireIdentityLease(client, input),
    releaseLease: (input) => releaseIdentityLease(client, input),
    recordFailure: (input) => recordIdentityFailure(client, input),
    recordModeSelection: (input) => recordModeSelection(client, input),
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

// Relay requests may not aim at the broker's own network neighborhood; the
// relay exists to reach the governed source site over the login egress.
const HOP_BY_HOP_HEADERS = new Set([
  "host", "content-length", "connection", "keep-alive", "transfer-encoding",
  "upgrade", "proxy-authorization", "proxy-authenticate", "te", "trailer",
]);

const MAX_RELAY_RESPONSE_BYTES = 10 * 1024 * 1024;

function httpError(statusCode, code, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.code = code;
  return err;
}

function requireActiveLease(identity, leaseToken) {
  if (!identity) throw httpError(404, "IDENTITY_NOT_FOUND", "identity not found");
  const expired = identity.lease_expires_at && new Date(identity.lease_expires_at) <= new Date();
  if (!identity.lease_token || identity.lease_token !== leaseToken || expired) {
    throw httpError(409, "LEASE_MISMATCH", "request requires the identity's active lease token");
  }
}

function assertRelayUrlAllowed(rawUrl) {
  let url;
  try {
    url = new URL(String(rawUrl));
  } catch {
    throw httpError(400, "RELAY_URL_INVALID", "relay url must be an absolute https url");
  }
  const host = url.hostname.toLowerCase();
  const privateHost = host === "localhost" || host === "::1" || host.endsWith(".internal")
    || host.endsWith(".svc") || host.endsWith(".cluster.local")
    || /^127\.|^10\.|^192\.168\.|^169\.254\.|^172\.(1[6-9]|2\d|3[01])\.|^0\./.test(host);
  if (url.protocol !== "https:" || privateHost || url.username || url.password) {
    throw httpError(400, "RELAY_URL_INVALID", `relay target not allowed: ${url.protocol}//${host}`);
  }
  return url.toString();
}

function relayRequestHeaders(callerHeaders = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(callerHeaders)) {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase()) && name.toLowerCase() !== "cookie" && name.toLowerCase() !== "authorization") {
      headers[name.toLowerCase()] = String(value);
    }
  }
  return headers;
}

function modeArtifacts(mode, { hostAdapter = null, identity = null } = {}) {
  return {
    relay: mode === "proxy_bound_relay" ? { path: "/relay" } : null,
    host: mode === "browser_session_host" && hostAdapter ? hostAdapter.endpoint({ identity }) : null,
  };
}

/**
 * Request handler is isolated from Node's HTTP server so it can be tested
 * without opening a socket.
 */
export function createAuthBrokerHandler({
  operations,
  sessionStore = null,
  brokerToken = process.env.LEGAL_AUTH_BROKER_TOKEN,
  jarKey = process.env.LEGAL_AUTH_JAR_KEY,
  relayFetch = null,
  hostAdapter = null,
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
          // The jar is only issued for session_jar identities; relay/host
          // consumers authenticate through the broker instead of holding
          // session material.
          if (input.include_session !== false && acquired.identity.mode === "session_jar" && sessionStore) {
            const session = await sessionStore.get({ source: input.source, accountId: input.account_id });
            if (session) {
              // The store keeps ciphertext; acquire only hands it to a caller
              // that already proved broker identity and owns the fresh lease.
              sessionEnvelope = session.envelope ?? session;
            }
          }
          statusCode = 200;
          payload = {
            lease: acquired.lease,
            identity: redactSessionJar(acquired.identity),
            mode: acquired.identity.mode,
            session_jar: sessionEnvelope,
            ...modeArtifacts(acquired.identity.mode, { hostAdapter, identity: acquired.identity }),
          };
        } else if (req.method === "POST" && route === "POST /mode") {
          const input = await readJsonBody(req);
          if (!SESSION_MODES.has(input.mode)) {
            throw httpError(400, "MODE_INVALID", `unknown session mode: ${input.mode}`);
          }
          const identity = await operations.getIdentity({ source: input.source, accountId: input.account_id });
          requireActiveLease(identity, input.lease_token);
          const updated = await operations.recordModeSelection({
            source: input.source,
            accountId: input.account_id,
            mode: input.mode,
            reason: input.reason ?? null,
            probes: input.probes ?? null,
            leaseToken: input.lease_token,
            actor: bearerTokenActor(req),
          });
          statusCode = 200;
          payload = {
            mode: updated.mode,
            previous_mode: identity.mode,
            switched: identity.mode !== updated.mode,
            ...modeArtifacts(updated.mode, { hostAdapter, identity: updated }),
          };
        } else if (req.method === "POST" && route === "POST /relay") {
          const input = await readJsonBody(req);
          if (!relayFetch) throw httpError(503, "RELAY_NOT_CONFIGURED", "relay egress is not configured on this broker");
          if (!sessionStore) throw new SessionJarError("NO_STORE", "session store is not configured");
          const identity = await operations.getIdentity({ source: input.source, accountId: input.account_id });
          requireActiveLease(identity, input.lease_token);
          const stored = await sessionStore.get({ source: input.source, accountId: input.account_id });
          if (!stored) throw httpError(409, "SESSION_NOT_ISSUED", "no session is stored for this identity");
          const jar = decryptSessionJar(stored.envelope ?? stored, jarKey);
          const url = assertRelayUrlAllowed(input.url);
          const headers = {
            ...relayRequestHeaders(input.headers),
            ...authHeadersFromSessionJar(jar),
          };
          let body;
          if (input.body_base64) body = Buffer.from(input.body_base64, "base64");
          else if (input.body !== undefined) body = Buffer.from(String(input.body));
          const response = await relayFetch({ url, method: input.method ?? "GET", headers, body });
          const responseBody = Buffer.from(response.body ?? Buffer.alloc(0));
          if (responseBody.length > MAX_RELAY_RESPONSE_BYTES) {
            throw httpError(502, "RELAY_RESPONSE_TOO_LARGE", "relay response exceeds the size limit");
          }
          const contentType = response.headers?.["content-type"] ?? response.headers?.["Content-Type"] ?? null;
          const payloadHeaders = {};
          for (const [name, value] of Object.entries(response.headers ?? {})) {
            if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) payloadHeaders[name.toLowerCase()] = value;
          }
          statusCode = 200;
          payload = {
            status: response.status,
            headers: payloadHeaders,
            body_base64: responseBody.toString("base64"),
            ...(contentType && /^(text\/|application\/(json|xml|javascript))/.test(String(contentType)) && responseBody.length <= 1024 * 1024
              ? { body_text: responseBody.toString("utf8") }
              : {}),
          };
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
