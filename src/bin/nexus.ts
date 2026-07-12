#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
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
      `  nexus dashboard\n` +
      `  nexus aggregator\n` +
      `  nexus http-bridge [--url <url>]\n\n` +
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
      createServer: () => runtime.createServer(),
    });

    const restHandler = createRestApiHandler({
      orchestrator: runtime.orchestrator,
      sanitizer: runtime.sanitizer,
      projectRoot: config.projectRoot,
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const pathname = url.pathname;

      // REST API endpoints
      if (req.method === "POST" && pathname === "/api/search") {
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

    server.listen(port, "127.0.0.1", () => {
      console.error(
        `\ud83d\ude80 Nexus HTTP server running on http://127.0.0.1:${port} (root: ${root})`
      );
      console.error(`   MCP:    POST / (Streamable HTTP)`);
      console.error(`   Search: POST /api/search`);
    });

    setupSignalHandlers(runtime, config.storage.rootDir, exitCleanup, server);

    runtime.initialize().catch((error) => {
      handleFatalError("Nexus background initialization failed", error);
    });

    return;
  }

  // Default: stdio MCP transport
  const transport = new StdioServerTransport();
  const stdioServer = runtime.createServer();
  await stdioServer.connect(transport);

  setupSignalHandlers(runtime, config.storage.rootDir, exitCleanup, undefined, stdioServer);

  // Heavy initialization (SQLite/LanceDB open, file watcher full scan,
  // metrics server bind) runs after the MCP transport is connected to avoid
  // exceeding the client's initialize timeout (`MCP error -32000`).
  runtime.initialize().catch((error) => {
    handleFatalError("Nexus background initialization failed", error);
  });
}

function handleFatalError(message: string, error: unknown): never {
  console.error(`\n\u274c ${message}:`);
  console.error(error);

  console.error("\n\ud83d\udd0d Troubleshooting Info:");
  console.error(`   Node.js:  ${process.version}`);
  console.error(`   Platform: ${process.platform} (${process.arch})`);

  if (typeof error === "object" && error !== null) {
    const err = error as Record<string, unknown> & { code?: string; path?: string; message?: string; stack?: string };

    if (err.code === "ENOENT") {
      console.error(`   Diagnosis: A required file or directory was not found: ${err.path ?? "unknown path"}`);
      console.error("   Action:    Ensure the path is correct and accessible. Check if --project-root is set correctly.");
    } else if (err.code === "EACCES" || err.code === "EPERM") {
      console.error(`   Diagnosis: Permission denied at ${err.path ?? "unknown path"}`);
      console.error("   Action:    Check filesystem permissions for the storage and project directories.");
    } else if (err.message?.includes("rg") || err.message?.includes("ripgrep")) {
      console.error("   Diagnosis: ripgrep (rg) might be missing or not in PATH.");
      console.error("   Action:    Install ripgrep: https://github.com/BurntSushi/ripgrep#installation");
    } else if (err.message?.includes("better-sqlite3") || err.stack?.includes("better-sqlite3")) {
      console.error("   Diagnosis: better-sqlite3 failed to load. This usually means a native module mismatch.");
      console.error("   Action:    Try 'npm rebuild better-sqlite3' or ensure you are using a supported Node.js version.");
    } else if (err.message?.includes("lancedb") || err.stack?.includes("lancedb")) {
      console.error("   Diagnosis: @lancedb/lancedb failed to load. Native components might be missing.");
      console.error("   Action:    Ensure your platform is supported and you have the necessary build tools.");
    }
  }

  console.error("\n   For more details, check the indexer log in your storage directory (default: .nexus/indexer.log).\n");
  process.exit(1);
}
function setupSignalHandlers(
  runtime: NexusRuntime,
  storageDir: string,
  exitCleanup: () => void,
  httpServer?: Server,
  mcpServer?: McpServer,
): void {
  let isShuttingDown = false;

  const handleShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    const cleanup = async () => {
      if (mcpServer) {
        await mcpServer.close();
      }
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
      }
      await runtime.close();
      await releaseProcessLock(storageDir);
    };
    cleanup()
      .then(() => {
        // Deregister the exit handler before process.exit(0) so the PID file
        // already removed by releaseProcessLock is not touched again (and a
        // concurrently started process's file is not mistakenly deleted).
        process.removeListener("exit", exitCleanup);
        process.exit(0);
      })
      .catch((error) => {
        handleFatalError("Error during shutdown", error);
      });
  };

  process.once("SIGINT", handleShutdown);
  process.once("SIGTERM", handleShutdown);
}

if (process.argv[2] === "http-bridge") {
  // Remove "http-bridge" from argv so the bridge's parseArgs doesn't complain.
  process.argv.splice(2, 1);

  try {
    interface HttpBridgeModule {
      main?: () => Promise<void>;
    }
    const module = (await import(new URL("./http-bridge.js", import.meta.url).href)) as HttpBridgeModule;
    if (typeof module.main !== "function") {
      throw new TypeError("HTTP bridge module did not export a main() function");
    }
    await module.main();
  } catch (error) {
    handleFatalError("Failed to start HTTP bridge", error);
  }
} else if (process.argv[2] === "aggregator") {
  // Remove "aggregator" from argv so parseArgs doesn't complain.
  process.argv.splice(2, 1);

  try {
    interface DashboardCliModule {
      AggregatorServer?: new () => {
        start: (port: number) => Promise<void>;
        stop: () => Promise<void>;
      };
    }
    const module = (await import(new URL("../dashboard/cli.js", import.meta.url).href)) as DashboardCliModule;
    if (!module.AggregatorServer) {
      throw new Error("Dashboard module did not export AggregatorServer");
    }

    const { values } = parseArgs({
      options: {
        port: { type: "string" },
        "project-root": { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
    });

    if (values.help) {
      console.log(
        `Nexus Metrics Aggregator - Standalone Prometheus metrics aggregator\n\n` +
        `Usage:\n` +
        `  nexus-aggregator [options]\n\n` +
        `Options:\n` +
        `  --port <number>        Port for the metrics aggregator server (default: 9470)\n` +
        `  --project-root <path>  Path to the project root directory\n` +
        `  -h, --help             Show help`
      );
      process.exit(0);
    }

    const rawProjectRoot = (
      (values["project-root"] as string) ??
      process.env.NEXUS_PROJECT_ROOT ??
      ""
    ).trim();
    const root = rawProjectRoot ? path.resolve(rawProjectRoot) : process.cwd();
    const config = await loadConfig({ projectRoot: root });

    const aggregatorPort = (() => {
      if (values.port !== undefined) {
        if (!/^\d+$/.test(values.port)) {
          throw new Error(`Invalid port value: ${values.port}`);
        }
        return Number.parseInt(values.port, 10);
      }
      if (config.aggregatorPort !== undefined) {
        return config.aggregatorPort;
      }
      if (process.env.NEXUS_AGGREGATOR_PORT) {
        const rawEnvPort = process.env.NEXUS_AGGREGATOR_PORT.trim();
        if (!/^\d+$/.test(rawEnvPort)) {
          throw new Error(`Invalid NEXUS_AGGREGATOR_PORT environment variable: ${rawEnvPort}`);
        }
        return Number.parseInt(rawEnvPort, 10);
      }
      return 9470;
    })();

    if (Number.isNaN(aggregatorPort) || aggregatorPort < 1 || aggregatorPort > 65535) {
      throw new Error(`Invalid port: ${aggregatorPort}`);
    }

    const aggregator = new module.AggregatorServer();
    await aggregator.start(aggregatorPort);
    console.error(`🚀 Nexus Metrics Aggregator running on http://127.0.0.1:${aggregatorPort}`);

    const handleShutdown = () => {
      aggregator.stop()
        .then(() => {
          process.exit(0);
        })
        .catch((err: unknown) => {
          handleFatalError("Failed to stop aggregator", err);
        });
    };
    process.once("SIGINT", handleShutdown);
    process.once("SIGTERM", handleShutdown);
  } catch (error) {
    handleFatalError("Failed to start aggregator", error);
  }
} else if (process.argv[2] === "dashboard") {
  // Remove "dashboard" from argv so the sub-command's parseArgs doesn't complain.
  process.argv.splice(2, 1);

  // Start the TUI dashboard (the MCP server will not be started)
  try {
    interface DashboardCliModule {
      main?: () => Promise<void>;
    }
    const module = (await import(new URL("../dashboard/cli.js", import.meta.url).href)) as DashboardCliModule;
    if (typeof module.main !== "function") {
      throw new Error("Dashboard module did not export a main() function");
    }
    await module.main();
  } catch (error) {
    handleFatalError("Failed to start dashboard", error);
  }
} else {
  main().catch((error) => {
    handleFatalError("Fatal error starting Nexus", error);
  });
}

