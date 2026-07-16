#!/usr/bin/env node
import { handleFatalError } from "./fatal-error.js";

try {
  const { main } = await import("./aggregator-command.js");
  await main(process.argv.slice(2));
} catch (error) {
  handleFatalError("Failed to start aggregator", error);
}
