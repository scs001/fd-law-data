#!/usr/bin/env node
import { main } from "./legal-source-crawl.mjs";

await main({ source: "mfa-treaty-library", argv: process.argv.slice(2) });
