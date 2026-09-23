#!/usr/bin/env node
import { main } from "./legal-source-crawl.mjs";

await main({ source: "ccdi-supervisory-regulations", argv: process.argv.slice(2) });
