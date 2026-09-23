// Shared error taxonomy for legal-source adapters and the runtime.
// The runtime treats these names as control flow, not as ordinary item failures.
export class StructureDriftError extends Error {
  constructor(message, detail = {}) {
    super(`structure drift: ${message}`);
    this.name = "StructureDriftError";
    this.detail = detail;
  }
}

export class SessionProxyError extends Error {
  constructor(message, detail = {}) {
    super(`session/proxy failure: ${message}`);
    this.name = "SessionProxyError";
    this.code = detail.code ?? "SESSION_OR_PROXY";
    this.detail = detail;
  }
}

export class MissingTextError extends Error {
  constructor(message = "source exposes no body text", detail = {}) {
    super(message);
    this.name = "MissingTextError";
    this.detail = detail;
  }
}

export function isStructureDrift(err) {
  return err?.name === "StructureDriftError";
}

export function isSessionProxyFailure(err) {
  return err?.name === "SessionProxyError" || err?.name === "SessionError" || err?.name === "AccountBannedError";
}
