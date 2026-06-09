#!/usr/bin/env node
import { createServer } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { unlinkSync } from "node:fs";

import { loadConfig } from "../config/index.js";
import { NexusServerFactory } from "../server/factory.js";
import type { NexusRuntime } from "../server/index.js";
import { createStreamableHttpHandler } from "../server/transport.js";
import { createRestApiHandler } from "../server/rest-api.js";
import { acquireProcessLock, releaseProcessLock, LOCK_FILENAME } from "../server/process-lock.js";

async function main() {
  const { values } = parseArgs({
    options: {
      "project-root": { type: "string" },
      "port": { type: "string" },
      "reindex": { type: "boolean" },
      "full": { type: "boolean" },
      "help": { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values["help"]) {
    console.log(
      `Nexus - AI-native codebase indexing and search MCP server\n\n` +
      `Usage:\n` +
      `  nexus [options]\n` +
      `  nexus dashboard\n\n` +
      `Options:\n` +
      `  --project-root <path>  Path to the project root directory\n` +
      `  --port <number>        Start HTTP server (with MCP + REST API) on the given port\n` +
      `  --reindex              Run indexing and exit\n` +
      `  --full                 Run a full clean reindexing (can be used with --reindex)\n` +
      `  -h, --help             Show help`
    );
    return;
  }

  if (values["full"] && !values["reindex"]) {
    console.warn(`\u26a0\ufe0f  Warning: --full has no effect without --reindex.`);
  }

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

  if (values["reindex"]) {
    const runtime = await NexusServerFactory.createRuntime(config);
    let exitCode = 0;
    try {
      console.log(`Starting indexing...`);
      await runtime.reindex(!!values["full"]);
      console.log(`Indexing completed successfully.`);
    } catch (error) {
      console.error(`Indexing failed:`, error);
      exitCode = 1;
    } finally {
      await runtime.close();
      await releaseProcessLock(config.storage.rootDir);
      process.removeListener("exit", exitCleanup);
    }
    process.exit(exitCode);
  }

  const runtime = await NexusServerFactory.createRuntime(config);

  if (values["port"]) {
    const port = Number(values["port"]);
    if (Number.isNaN(port) || port <= 0 || port > 65535) {
      console.error(`\u274c Invalid port: ${values["port"]}`);
      process.exit(1);
    }

    const mcpHandler = createStreamableHttpHandler({
      createServer: () => runtime.server,
    });

    const restHandler = createRestApiHandler({
      orchestrator: runtime.orchestrator,
      sanitizer: runtime.sanitizer,
    });

    const server = createServer((req, res) => {
      // REST API endpoints
      if (req.method === "POST" && req.url === "/api/search") {
        restHandler(req, res).catch((error: unknown) => {
          console.error("[REST API Unhandled Error]", error);
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Internal server error" }));
          }
        });
        return;
      }

      // Everything else goes to MCP over HTTP
      mcpHandler(req, res).catch((error: unknown) => {
        console.error("[MCP Handler Unhandled Error]", error);
        if (!res.headersSent) {
          res.statusCode = 500;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });

    server.listen(port, () => {
      console.error(
        `\ud83d\ude80 Nexus HTTP server running on http://localhost:${port} (root: ${root})`
      );
      console.error(`   MCP:    POST / (Streamable HTTP)`);
      console.error(`   Search: POST /api/search`);
    });

    setupSignalHandlers(runtime, config.storage.rootDir, exitCleanup);

    runtime.initialize().catch((error) => {
      console.error("Nexus background initialization failed:", error);
      process.exit(1);
    });

    return;
  }

  // Default: stdio MCP transport
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
