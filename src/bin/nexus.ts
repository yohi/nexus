#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { loadConfig } from "../config/index.js";
import { NexusServerFactory } from "../server/factory.js";
import type { NexusRuntime } from "../server/index.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string" },
    },
    strict: false,
  });

  const rawProjectRoot = (
    (values["project-root"] as string) ??
    process.env.NEXUS_PROJECT_ROOT ??
    ""
  ).trim();
  const root = rawProjectRoot ? path.resolve(rawProjectRoot) : process.cwd();

  const config = await loadConfig({ projectRoot: root });
  const runtime = await NexusServerFactory.createRuntime(config);

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);

  console.error(`🔗 Nexus MCP server running on stdio (root: ${root})`);

  setupSignalHandlers(runtime);
}

function setupSignalHandlers(runtime: NexusRuntime): void {
  let isShuttingDown = false;

  const handleShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    runtime
      .close()
      .then(() => {
        process.exit(0);
      })
      .catch((error) => {
        console.error("Error during shutdown:", error);
        process.exit(1);
      });
  };

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

if (process.argv[2] === "dashboard") {
  // Remove "dashboard" from argv so the sub-command's parseArgs doesn't complain.
  process.argv.splice(2, 1);

  // Start the TUI dashboard (the MCP server will not be started)
  try {
    await import("@yohi/nexus-dashboard/cli");
  } catch (error) {
    console.error("Failed to start dashboard:", error);
    process.exit(1);
  }
} else {
  main().catch((error) => {
    console.error("Fatal error starting Nexus:", error);
    process.exit(1);
  });
}
