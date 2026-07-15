#!/usr/bin/env node
const { main } = await import("./aggregator-command.js");
await main(process.argv.slice(2));
