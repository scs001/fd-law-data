#!/usr/bin/env node
import { main } from "./legal-source-load.mjs";

await main({ source: "ccdi-supervisory-regulations", argv: process.argv.slice(2) });
