#!/usr/bin/env node
process.argv.splice(2, 0, "dashboard");
await import("./nexus.js");
