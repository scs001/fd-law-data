#!/usr/bin/env node
import { main } from "./legal-source-load.mjs";

await main({ source: "gov-rules-library", argv: process.argv.slice(2) });
