#!/usr/bin/env node
// Dual session source via the shared crawl entry: a platform-dispatched run
// injects FD_SESSION_JAR / FD_SESSION_JAR_PATH (+ standard proxy env) and is
// consumed by lib/legal-sources/platform-session.js; without that injection
// the existing legal-auth-broker lease path applies unchanged.
import { main } from "./legal-source-crawl.mjs";

await main({ source: "rmfyalk-case-library", argv: process.argv.slice(2) });
