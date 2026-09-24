// Proxy-aware fetch adapter built on curl. Node's global fetch still does not
// honor proxy URLs portably, while the Auth Broker image and operator machines
// both ship curl; this keeps session probes on the identity-bound egress.
import { execFile } from "node:child_process";

export function createProxyFetch(proxyUrl, { timeoutMs = 30000, curlPath = "curl" } = {}) {
  if (!proxyUrl) return globalThis.fetch;
  return async function proxyFetch(url, options = {}) {
    const headers = options.headers ?? {};
    const args = [
      "--silent",
      "--show-error",
      "--compressed",
      "--include",
      "--max-time", String(Math.ceil(timeoutMs / 1000)),
      "--proxy", proxyUrl,
      "--url", String(url),
    ];
    if (options.method && options.method.toUpperCase() !== "GET") args.push("--request", options.method);
    for (const [name, value] of Object.entries(headers)) args.push("--header", `${name}: ${value}`);
    if (options.body != null) args.push("--data-binary", typeof options.body === "string" ? options.body : Buffer.from(options.body).toString("utf8"));

    const output = await new Promise((resolve, reject) => {
      execFile(curlPath, args, { timeout: timeoutMs + 2000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          err.message = `${err.message}${stderr ? `: ${stderr.trim()}` : ""}`;
          reject(err);
        } else resolve(stdout);
      });
    });

    // curl --include can emit an informational 1xx block before the final
    // response headers. Body starts after the LAST header terminator.
    const matches = [...output.matchAll(/\r\n\r\n/g)];
    const last = matches.at(-1);
    const separator = last ? last.index : -1;
    const headerText = separator >= 0 ? output.slice(0, separator) : output;
    const text = separator >= 0 ? output.slice(separator + 4) : "";
    const statusLine = [...headerText.matchAll(/^HTTP\/[\d.]+\s+\d{3}.*$/gim)].at(-1)?.[0] ?? "";
    const status = Number(statusLine.match(/HTTP\/[\d.]+\s+(\d{3})/)?.[1] ?? 0);
    const responseHeaders = {};
    for (const line of headerText.split(/\r?\n/)) {
      const idx = line.indexOf(":");
      if (idx > 0 && /^[A-Za-z0-9-]+$/.test(line.slice(0, idx))) {
        responseHeaders[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
    }
    return { ok: status >= 200 && status < 300, status, headers: responseHeaders, text: async () => text };
  };
}
