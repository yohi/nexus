#!/usr/bin/env node
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

  const projectRoot =
    values["project-root"] ?? process.env.NEXUS_PROJECT_ROOT ?? process.cwd();
  const root = typeof projectRoot === "string" ? projectRoot : process.cwd();

  const config = await loadConfig({ projectRoot: root });
  const runtime = await NexusServerFactory.createRuntime(config);

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);

  console.error(`Nexus MCP server running on stdio (root: ${root})`);

  setupSignalHandlers(runtime);
}

function setupSignalHandlers(runtime: NexusRuntime): void {
  const handleShutdown = () => {
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

  process.on("SIGINT", handleShutdown);
  process.on("SIGTERM", handleShutdown);
}

main().catch((error) => {
  console.error("Fatal error starting Nexus:", error);
  process.exit(1);
});
