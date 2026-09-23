#!/usr/bin/env node
import { main } from "./legal-source-crawl.mjs";

await main({ source: "party-regulation-library", argv: process.argv.slice(2) });
