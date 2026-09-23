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

    const separator = output.indexOf("\r\n\r\n");
    const headerText = separator >= 0 ? output.slice(0, separator) : output;
    const text = separator >= 0 ? output.slice(separator + 4) : "";
    const statusLine = headerText.split(/\r?\n/).find((line) => /^HTTP\//i.test(line)) ?? "";
    const status = Number(statusLine.match(/HTTP\/[\d.]+\s+(\d{3})/)?.[1] ?? 0);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
}
