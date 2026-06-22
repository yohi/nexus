#!/usr/bin/env node
process.argv.splice(2, 0, "aggregator");
await import("./nexus.js");
