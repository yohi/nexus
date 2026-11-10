#!/usr/bin/env node
import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { parseArgs } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { loadConfig } from "../config/index.js";
import { handleFatalError } from "./fatal-error.js";
import { NexusServerFactory } from "../server/factory.js";
import type { NexusRuntime } from "../server/index.js";
import {
  createStreamableHttpHandler,
  type StreamableHttpHandler,
} from "../server/transport.js";
import { createRestApiHandler } from "../server/rest-api.js";
import {
  acquireProcessLock,
  releaseOwnedProcessLock,
  releaseOwnedProcessLockSync,
  LOCK_FILENAME,
} from "../server/process-lock.js";
import {
  admitStorageWriter,
  assertExpectedStorageTargetsFingerprint,
  INTERNAL_TARGETS_FINGERPRINT_ENV,
  isBridgeStartupLogPath,
  resolveStorageOwnershipTargets,
  storageTargetsFingerprint,
  type WriterAdmission,
} from "../server/storage-ownership/index.js";
import type { ManagedHttpServer } from "../server/managed-http-server.js";
import { setWriterLeaseLostHandler } from "../server/runtime/writer-lease-loss.js";
import type { Config } from "../types/index.js";
import { readIndexProgress } from "./index-progress.js";
import {
  openBridgeStartupLog,
  redirectStreamToFd,
  redirectStreamToPath,
  type StreamRedirection,
} from "./stream-redirect.js";

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
  {
    name: "serve",
    summary: "Start the local MCP v2 HTTP server (loopback only)",
    run: (args) => import("./commands/serve.js").then((module) => module.main(args)),
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

  const isManagedMode = values["managed"] === true;
  // Nexus #297: the Bridge hands its inspected target fingerprint to a managed child through an internal-only spawn
  // environment entry. Consume it so it never leaks into grandchildren; it is ignored outside managed mode.
  const expectedTargetsFingerprint = process.env[INTERNAL_TARGETS_FINGERPRINT_ENV];
  delete process.env[INTERNAL_TARGETS_FINGERPRINT_ENV];
  const redirectedStartupLogs = isManagedMode
    ? await redirectBridgeStartupLogs(
      (values["startup-stdout-log"] as string | undefined) ?? process.env.NEXUS_STARTUP_STDOUT_LOG,
      (values["startup-stderr-log"] as string | undefined) ?? process.env.NEXUS_STARTUP_STDERR_LOG,
    )
    : undefined;

  const config = await loadConfig({ projectRoot: root });

  // Nexus #297: storage writer admission precedes every PID/Endpoint mutation, project lock, storage directory
  // initialization, store open and runtime logging. A refusal leaves all storage and PID bytes untouched.
  // A managed child re-resolves its own effective targets; a mismatch with the Bridge preflight refuses early
  // (fail-fast only: a match authorizes nothing and admission still runs in full).
  let admission: WriterAdmission;
  let targetsFingerprint: string;
  try {
    const targets = await resolveStorageOwnershipTargets(config);
    targetsFingerprint = storageTargetsFingerprint(targets);
    if (isManagedMode) {
      assertExpectedStorageTargetsFingerprint(targetsFingerprint, expectedTargetsFingerprint);
    }
    admission = await admitStorageWriter(targets);
  } catch (error) {
    console.error(
      `\u274c Nexus refused to start: ${error instanceof Error ? error.message : String(error)}\n` +
        `   Storage: ${config.storage.rootDir}`,
    );
    process.exit(1);
    return;
  }

  // Acquire single-instance lock keyed on storage directory (under the live writer lease).
  const lockResult = await acquireProcessLock(config.storage.rootDir, { handle: admission, config });
  if (!lockResult.acquired) {
    await admission.release();
    const pidStr = lockResult.existingPid ?? "unknown";
    const progress = await readIndexProgress(config.storage.rootDir);
    const progressStatus = progress?.active ? "running" : "idle";
    const progressLine = progress === undefined
      ? ""
      : `\n   Progress: ${progress.processedFiles} / ${progress.totalFiles} files (${progressStatus})`;
    console.error(
      `\u26a0\ufe0f  Another Nexus process (PID ${pidStr}) is already running for this project.\n` +
        `   Storage: ${config.storage.rootDir}\n` +
        `   To force start, remove: ${path.join(config.storage.rootDir, LOCK_FILENAME)}` +
        progressLine,
    );
    process.exit(1);
    return;
  }

  // Best-effort exit cleanup that only ever removes the PID file this process wrote. Clean shutdown paths
  // deregister it after removing the owned PID themselves, before the runtime releases the writer lease.
  const exitCleanup = () => {
    releaseOwnedProcessLockSync(config.storage.rootDir);
  };
  process.on("exit", exitCleanup);

  // Transfer the issued admission to the guarded Factory. After a successful transfer only the runtime may release
  // the lease (runtime.close() releases it last); before transfer a failure releases only this unconsumed handle.
  // A lost writer lease terminates this process fail-fast (non-zero): no graceful close that could keep writing, no
  // zombie owner left serving. The owned-PID exit handler still runs; the kernel drops the remaining leases.
  setWriterLeaseLostHandler((error) => {
    console.error(`\u274c Nexus storage writer lease lost; exiting: ${error.message}`);
    process.exit(75);
  });
  let runtime: NexusRuntime;
  try {
    runtime = await NexusServerFactory.createRuntime(config, admission);
  } catch (error) {
    await releaseOwnedProcessLock(config.storage.rootDir).catch(() => {});
    process.removeListener("exit", exitCleanup);
    await admission.release();
    throw error;
  }

  if (values["reindex"]) {
    await startReindexMode({ config, exitCleanup, full: !!values["full"], runtime });
    return;
  }

  if (values["port"]) {
    const port = Number(values["port"]);
    const isManaged = isManagedMode;
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
        bridgeStartupLogs: redirectedStartupLogs,
        storageTargetsFingerprint: targetsFingerprint,
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
  readonly runtime: NexusRuntime;
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
  readonly bridgeStartupLogs: StreamRedirection | undefined;
  readonly storageTargetsFingerprint: string;
}

interface HttpModeOptions extends RuntimeModeOptions {
  readonly port: number;
}

async function startReindexMode({
  config,
  exitCleanup,
  full,
  runtime,
}: ReindexModeOptions): Promise<void> {
  let exitCode = 0;
  try {
    console.log(`Starting indexing...`);
    await runtime.reindex(full);
    console.log(`Indexing completed successfully.`);
  } catch (error) {
    console.error(`Indexing failed:`, error);
    exitCode = 1;
  } finally {
    // Owned PID first (under the live lease), then stores; runtime.close() releases the writer lease last.
    await releaseOwnedProcessLock(config.storage.rootDir).catch(() => {});
    process.removeListener("exit", exitCleanup);
    await runtime.close();
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
  bridgeStartupLogs,
  storageTargetsFingerprint: publishedTargetsFingerprint,
}: ManagedModeOptions): Promise<void> {
  if (bridgeStartupLogs === undefined) {
    // Arbitrary (non-Bridge) log paths are opened only now, after writer admission.
    const stdoutLogPath = startupStdoutLog ?? process.env.NEXUS_STARTUP_STDOUT_LOG;
    const stderrLogPath = startupStderrLog ?? process.env.NEXUS_STARTUP_STDERR_LOG;
    if (stdoutLogPath !== undefined) {
      redirectStreamToPath(process.stdout, stdoutLogPath);
    }
    if (stderrLogPath !== undefined) {
      redirectStreamToPath(process.stderr, stderrLogPath);
    }
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
    storageTargetsFingerprint: publishedTargetsFingerprint,
    runtime,
    port,
    idleShutdownMs,
    startupGraceMs: 30_000,
    exitOnShutdown: true,
  });
  // The healthy Endpoint is published: the Bridge attempt is over (it removes its token-owned logs), so stop writing
  // into them and close the descriptors instead of feeding a deleted file for the runtime's lifetime.
  bridgeStartupLogs?.detach();

  console.error(
    `\ud83d\ude80 Nexus managed HTTP server running on ${managed.url.toString()} (root: ${root})`
  );
  console.error(`   MCP:    POST / (Streamable HTTP)`);

  setupSignalHandlers(runtime, config.storage.rootDir, exitCleanup, undefined, undefined, managed);

  runtime.initialize().catch((error) => {
    handleFatalError("Nexus background initialization failed", error);
  });
}
/**
 * Nexus #297: Bridge attempt logs live in the coordination root (`startup-logs/`), never under Storage, so a managed
 * child may redirect into them before writer admission and pre-admission refusals reach the Bridge. Applies only when
 * BOTH supplied paths are Bridge attempt logs. Each log is opened ONCE without O_CREAT and with O_NOFOLLOW (the Bridge
 * created it 0600) and written through that descriptor, so a log the Bridge already removed is never re-created.
 * Returns undefined for non-Bridge paths (those are opened only after admission). If a Bridge log cannot be opened
 * safely, nothing is redirected at all (no fallback to path-based appends).
 */
async function redirectBridgeStartupLogs(
  stdoutLogPath: string | undefined,
  stderrLogPath: string | undefined,
): Promise<StreamRedirection | undefined> {
  if (stdoutLogPath === undefined || stderrLogPath === undefined) {
    return undefined;
  }
  if (!(await isBridgeStartupLogPath(stdoutLogPath)) || !(await isBridgeStartupLogPath(stderrLogPath))) {
    return undefined;
  }
  const redirections: StreamRedirection[] = [];
  try {
    redirections.push(redirectStreamToFd(process.stdout, openBridgeStartupLog(stdoutLogPath)));
    redirections.push(redirectStreamToFd(process.stderr, openBridgeStartupLog(stderrLogPath)));
  } catch {
    for (const redirection of redirections) redirection.detach();
    return { detach: () => {} };
  }
  return {
    detach: () => {
      for (const redirection of redirections.reverse()) redirection.detach();
    },
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
        // managedServer.close() removes the owned Endpoint and nexus.pid under
        // the live writer lease, then closes the runtime (releasing the lease
        // last) and calls process.exit(0) when exitOnShutdown is set. Remove
        // exitCleanup first so it never runs after the lease is released.
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
      // Work has stopped: remove the owned PID under the still-live writer lease, then close stores.
      // runtime.close() releases the writer lease as its final step.
      await releaseOwnedProcessLock(storageDir).catch(() => {});
      process.removeListener("exit", exitCleanup);
      await runtime.close();
    };
    cleanup()
      .then(() => {
        // Already deregistered before runtime.close(); kept for the managed path.
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
