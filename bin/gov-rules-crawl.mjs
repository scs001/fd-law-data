#!/usr/bin/env node
import { main } from "./legal-source-crawl.mjs";

await main({ source: "gov-rules-library", argv: process.argv.slice(2) });
