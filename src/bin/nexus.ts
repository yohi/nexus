#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { unlinkSync, appendFileSync } from "node:fs";

import { loadConfig } from "../config/index.js";
import { handleFatalError } from "./fatal-error.js";
import { NexusServerFactory } from "../server/factory.js";
import type { NexusRuntime } from "../server/index.js";
import {
  createStreamableHttpHandler,
  type StreamableHttpHandler,
} from "../server/transport.js";
import { createRestApiHandler } from "../server/rest-api.js";
import { acquireProcessLock, releaseProcessLock, LOCK_FILENAME } from "../server/process-lock.js";
import type { ManagedHttpServer } from "../server/managed-http-server.js";
import type { Config } from "../types/index.js";

interface CliCommand {
  readonly name: string;
  readonly summary: string;
  readonly run: (args: string[]) => Promise<void>;
}

interface CommandModule {
  readonly main?: (args: string[]) => Promise<void>;
}

const commands: readonly CliCommand[] = [
  {
    name: "dashboard",
    summary: "Launch the TUI dashboard",
    run: async (args) => {
      const module = (await import(new URL("../dashboard/cli.js", import.meta.url).href)) as CommandModule;
      if (typeof module.main !== "function") {
        throw new TypeError("Dashboard module did not export a main() function");
      }
      await module.main(args);
    },
  },
  {
    name: "aggregator",
    summary: "Run the standalone metrics aggregator",
    run: (args) => import("./aggregator-command.js").then((module) => module.main(args)),
  },
  {
    name: "http-bridge",
    summary: "Bridge stdio MCP clients to an auto-managed HTTP server",
    run: async (args) => {
      const module = (await import(new URL("./http-bridge.js", import.meta.url).href)) as CommandModule;
      if (typeof module.main !== "function") {
        throw new TypeError("HTTP bridge module did not export a main() function");
      }
      await module.main(args);
    },
  },
];

const argv = process.argv.slice(2);

async function main(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      "project-root": { type: "string" },
      "port": { type: "string" },
      "managed": { type: "boolean" },
      "idle-shutdown-ms": { type: "string" },
      "reindex": { type: "boolean" },
      "full": { type: "boolean" },
      "startup-stdout-log": { type: "string" },
      "startup-stderr-log": { type: "string" },
      "help": { type: "boolean", short: "h" },
    },
    strict: false,
  });

  if (values["help"]) {
    const commandHelp = commands
      .map((command) => `  ${command.name.padEnd(14)} ${command.summary}`)
      .join("\n");
    console.log(
      `Nexus - AI-native codebase indexing and search MCP server\n\n` +
      `Usage:\n` +
      `  nexus [options]\n` +
      `  nexus dashboard\n` +
      `  nexus aggregator\n` +
      `  nexus http-bridge [options]\n\n` +
      `Commands:\n` +
      `${commandHelp}\n\n` +
      `Run \`nexus <command> --help\` for command-specific options.\n\n` +
      `Server options (no subcommand):\n` +
      `  --project-root <path>  Path to the project root directory\n` +
      `  --port <number>        Start HTTP server (with MCP + REST API) on the given port\n` +
      `  --managed              Run as a managed HTTP server (requires --port; use --port 0 for an ephemeral port)\n` +
      `  --idle-shutdown-ms <ms> Idle timeout in milliseconds before a --managed server auto-shuts down when idle (env: NEXUS_IDLE_SHUTDOWN_MS, default: 0)\n` +
      `  --startup-stdout-log <path> Redirect managed child stdout to a file (env: NEXUS_STARTUP_STDOUT_LOG)\n` +
      `  --startup-stderr-log <path> Redirect managed child stderr to a file (env: NEXUS_STARTUP_STDERR_LOG)\n` +
      `  --reindex              Run indexing and exit\n` +
      `  --full                 Run a full clean reindexing (can be used with --reindex)\n` +
      `  -h, --help             Show help`
    );
    return;
  }

  if (values["full"] && !values["reindex"]) {
    console.warn(`\u26a0\ufe0f  Warning: --full has no effect without --reindex.`);
  }

  if (values["managed"] && !values["port"]) {
    console.error(`\u274c --managed requires --port (use --port 0 for an ephemeral port)`);
    process.exit(1);
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
    await startReindexMode({ config, exitCleanup, full: !!values["full"] });
    return;
  }

  const runtime = await NexusServerFactory.createRuntime(config);

  if (values["port"]) {
    const port = Number(values["port"]);
    const isManaged = values["managed"] === true;
    if (Number.isNaN(port) || port < 0 || port > 65535 || (port === 0 && !isManaged)) {
      console.error(`\u274c Invalid port: ${values["port"]}`);
      process.exit(1);
    }

    if (isManaged) {
      await startManagedMode({
        config,
        exitCleanup,
        idleShutdownMsRaw:
          values["idle-shutdown-ms"] ?? process.env.NEXUS_IDLE_SHUTDOWN_MS ?? "0",
        port,
        root,
        runtime,
        startupStdoutLog: values["startup-stdout-log"] as string | undefined,
        startupStderrLog: values["startup-stderr-log"] as string | undefined,
      });

      return;
    }

    startHttpMode({ config, exitCleanup, port, root, runtime });
    return;
  }

  await startStdioMode({ config, exitCleanup, root, runtime });
}

interface ReindexModeOptions {
  readonly config: Config;
  readonly exitCleanup: () => void;
  readonly full: boolean;
}

interface RuntimeModeOptions {
  readonly config: Config;
  readonly exitCleanup: () => void;
  readonly root: string;
  readonly runtime: NexusRuntime;
}

interface ManagedModeOptions extends RuntimeModeOptions {
  readonly idleShutdownMsRaw: string | boolean;
  readonly port: number;
  readonly startupStdoutLog: string | undefined;
  readonly startupStderrLog: string | undefined;
}

interface HttpModeOptions extends RuntimeModeOptions {
  readonly port: number;
}

async function startReindexMode({
  config,
  exitCleanup,
  full,
}: ReindexModeOptions): Promise<void> {
  const runtime = await NexusServerFactory.createRuntime(config);
  let exitCode = 0;
  try {
    console.log(`Starting indexing...`);
    await runtime.reindex(full);
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

async function startManagedMode({
  config,
  exitCleanup,
  idleShutdownMsRaw,
  port,
  root,
  runtime,
  startupStdoutLog,
  startupStderrLog,
}: ManagedModeOptions): Promise<void> {
  const stdoutLogPath = startupStdoutLog ?? process.env.NEXUS_STARTUP_STDOUT_LOG;
  const stderrLogPath = startupStderrLog ?? process.env.NEXUS_STARTUP_STDERR_LOG;
  if (stdoutLogPath !== undefined) {
    redirectStream(process.stdout, stdoutLogPath);
  }
  if (stderrLogPath !== undefined) {
    redirectStream(process.stderr, stderrLogPath);
  }

  const idleShutdownMs = Number(idleShutdownMsRaw);

  if (!Number.isFinite(idleShutdownMs) || idleShutdownMs < 0) {
    console.error(`\u274c Invalid idle-shutdown-ms: ${idleShutdownMsRaw}`);
    process.exit(1);
  }

  const { startManagedHttpServer } = await import("../server/managed-http-server.js");
  const managed = await startManagedHttpServer({
    instanceId: randomUUID(),
    projectRoot: root,
    storageDir: config.storage.rootDir,
    runtime,
    port,
    idleShutdownMs,
    startupGraceMs: 30_000,
    exitOnShutdown: true,
  });

  console.error(
    `\ud83d\ude80 Nexus managed HTTP server running on ${managed.url.toString()} (root: ${root})`
  );
  console.error(`   MCP:    POST / (Streamable HTTP)`);

  setupSignalHandlers(runtime, config.storage.rootDir, exitCleanup, undefined, undefined, managed);

  runtime.initialize().catch((error) => {
    handleFatalError("Nexus background initialization failed", error);
  });
}
function redirectStream(source: NodeJS.WriteStream, logPath: string): void {
  const originalWrite = source.write.bind(source);
  source.write = (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | ((error: Error | null | undefined) => void),
    callback?: (error: Error | null | undefined) => void,
  ): boolean => {
    const resolvedEncoding = typeof encodingOrCallback === "string" ? encodingOrCallback : "utf8";
    const resolvedCallback = typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    // Write synchronously so diagnostics survive an immediate process.exit()
    // call (e.g. after a fatal console.error). An async WriteStream's queued
    // write would otherwise be dropped when the process exits before it flushes.
    try {
      appendFileSync(logPath, chunk as string | Uint8Array, typeof chunk === "string" ? resolvedEncoding : undefined);
    } catch {
      // Best-effort diagnostics only; never let a logging failure crash startup.
    }
    return originalWrite(chunk as string | Buffer, resolvedEncoding, resolvedCallback);
  };
}

function startHttpMode({
  config,
  exitCleanup,
  port,
  root,
  runtime,
}: HttpModeOptions): void {
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

  setupSignalHandlers(
    runtime,
    config.storage.rootDir,
    exitCleanup,
    server,
    undefined,
    undefined,
    mcpHandler,
  );

  runtime.initialize().catch((error) => {
    handleFatalError("Nexus background initialization failed", error);
  });
}

async function startStdioMode({
  config,
  exitCleanup,
  root,
  runtime,
}: RuntimeModeOptions): Promise<void> {
  // Default: stdio MCP transport
  const transport = new StdioServerTransport();
  const stdioServer = runtime.createServer();
  await stdioServer.connect(transport);

  console.error(`\u{1F517} Nexus MCP server running on stdio (root: ${root})`);

  setupSignalHandlers(runtime, config.storage.rootDir, exitCleanup, undefined, stdioServer);

  // Heavy initialization (SQLite/LanceDB open, file watcher full scan,
  // metrics server bind) runs after the MCP transport is connected to avoid
  // exceeding the client's initialize timeout (`MCP error -32000`).
  runtime.initialize().catch((error) => {
    handleFatalError("Nexus background initialization failed", error);
  });
}

function setupSignalHandlers(
  runtime: NexusRuntime,
  storageDir: string,
  exitCleanup: () => void,
  httpServer?: Server,
  mcpServer?: McpServer,
  managedServer?: ManagedHttpServer,
  mcpHandler?: StreamableHttpHandler,
): void {
  let isShuttingDown = false;

  const handleShutdown = () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    const cleanup = async () => {
      if (mcpServer) {
        await mcpServer.close();
      }
      if (managedServer) {
        // managedServer.close() releases the process lock (nexus.pid) via
        // releaseProcessLock() and then calls process.exit(0) synchronously
        // when exitOnShutdown is set, firing Node's synchronous "exit" event.
        // Remove exitCleanup first so the still-registered listener does not
        // attempt a redundant (no-op) unlink of the already-released PID lock file.
        process.removeListener("exit", exitCleanup);
        await managedServer.close();
        return;
      }
      if (httpServer) {
        await new Promise<void>((resolve) => {
          httpServer.close(() => resolve());
        });
        await mcpHandler?.dispose();
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

async function dispatch(args: string[]): Promise<void> {
  const commandName = args[0];
  const command = commands.find((candidate) => candidate.name === commandName);

  if (command !== undefined) {
    try {
      await command.run(args.slice(1));
    } catch (error) {
      handleFatalError(`Failed to start ${command.name}`, error);
    }
    return;
  }

  if (commandName !== undefined && !commandName.startsWith("-")) {
    console.error(
      `Unknown command: ${commandName}\nValid commands: ${commands.map((candidate) => candidate.name).join(", ")}`,
    );
    process.exit(1);
    return;
  }

  await main(args);
}

dispatch(argv).catch((error) => {
  handleFatalError("Fatal error starting Nexus", error);
});
