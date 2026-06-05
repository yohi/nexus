#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unlinkSync } from "node:fs";

import { loadConfig } from "../config/index.js";
import { NexusServerFactory } from "../server/factory.js";
import type { NexusRuntime } from "../server/index.js";
import { acquireProcessLock, releaseProcessLock, LOCK_FILENAME } from "../server/process-lock.js";

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

  // Acquire single-instance lock keyed on storage directory.
  // Prevents two nexus processes from corrupting the shared
  // SQLite/LanceDB stores or doubling the embedding load.
  const lockResult = await acquireProcessLock(config.storage.rootDir);
  if (!lockResult.acquired) {
    const pidStr = lockResult.existingPid ?? "unknown";
    console.error(
      `\u26a0\ufe0f  Another Nexus process (PID ${pidStr}) is already running for this project.\n` +
        `   Storage: ${config.storage.rootDir}\n` +
        `   To force start, remove: ${path.join(config.storage.rootDir, LOCK_FILENAME)}`,
    );
    process.exit(1);
  }

  // Register best-effort exit cleanup immediately after acquiring the lock so
  // it runs even if createRuntime/connect throws before setupSignalHandlers.
  // setupSignalHandlers will replace this with a named handler that removes
  // itself after a clean shutdown to prevent double-unlink.
  const exitCleanup = () => {
    try {
      unlinkSync(path.join(config.storage.rootDir, LOCK_FILENAME));
    } catch {
      // Ignore - stale lock will be detected by next startup.
    }
  };
  process.on("exit", exitCleanup);

  const runtime = await NexusServerFactory.createRuntime(config);

  const transport = new StdioServerTransport();
  await runtime.server.connect(transport);

  console.error(`\ud83d\udd17 Nexus MCP server running on stdio (root: ${root})`);

  setupSignalHandlers(runtime, config.storage.rootDir, exitCleanup);

  // Heavy initialization (SQLite/LanceDB open, file watcher full scan,
  // metrics server bind) runs after the MCP transport is connected to avoid
  // exceeding the client's initialize timeout (`MCP error -32000`).
  runtime.initialize().catch((error) => {
    console.error("Nexus background initialization failed:", error);
    process.exit(1);
  });
}

function setupSignalHandlers(runtime: NexusRuntime, storageDir: string, exitCleanup: () => void): void {
  let isShuttingDown = false;

  const handleShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    runtime
      .close()
      .then(() => releaseProcessLock(storageDir))
      .then(() => {
        // Deregister the exit handler before process.exit(0) so the PID file
        // already removed by releaseProcessLock is not touched again (and a
        // concurrently started process's file is not mistakenly deleted).
        process.removeListener("exit", exitCleanup);
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
