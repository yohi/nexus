import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { SearchOrchestrator } from "../search/orchestrator.js";
import type {
  IFileWatcher,
} from "../types/index.js";
import { type PathSanitizer } from "./path-sanitizer.js";
import { MetricsHttpServer } from "../observability/metrics-server.js";
import type { Registry } from "prom-client";
import { writeMetricsPort, removeMetricsPort } from "./metrics-port.js";
import { RegistrationClient } from "../observability/registration-client.js";
import { createDashboardStatusEndpoint } from "../observability/dashboard-status-endpoint.js";
import { buildDashboardIndexStatusSnapshot } from "./tools/build-dashboard-index-status-snapshot.js";
import { registerV1Tools } from './tools/registry/adapters/v1-adapter.js';
import { buildToolHandlers } from './tools/tool-support.js';
import type { NexusServerOptions } from './tools/types.js';

export { errorResult, toolResult } from './tools/tool-support.js';

export type { NexusServerOptions } from './tools/types.js';

export interface NexusRuntimeOptions extends NexusServerOptions {
  watcher: IFileWatcher;
  onClose?: () => Promise<void>;
  metricsCollectorRegistry?: Registry;
  metricsPort?: number;
  storageDir?: string;
  projectName?: string;
  aggregatorPort?: number;
}

export interface NexusRuntime {
  createServer(): McpServer;
  orchestrator: SearchOrchestrator;
  sanitizer: PathSanitizer;
  initialize(): Promise<void>;
  close(): Promise<void>;
  reindex(fullRebuild?: boolean): Promise<void>;
  registrationClient?: RegistrationClient | null;
}

type AutoReindexResult = Awaited<ReturnType<NexusServerOptions['pipeline']['reindex']>>;

function resolveProjectId(projectRoot: string, projectName?: string): string {
  return projectName ?? projectRoot.split(/[\\/]/).findLast(Boolean) ?? "unknown";
}

async function syncMetricsPortFile(storageDir: string | undefined, resolvedPort: number | undefined): Promise<void> {
  if (!storageDir) {
    return;
  }

  if (resolvedPort !== undefined) {
    await writeMetricsPort(storageDir, resolvedPort).catch((err) => {
      console.warn("[Nexus] Failed to write metrics port file:", err);
    });
    return;
  }

  await removeMetricsPort(storageDir).catch((err) => {
    console.warn("[Nexus] Failed to remove stale metrics port file:", err);
  });
}

function createRegistrationClient(
  aggregatorPort: number,
  resolvedPort: number | undefined,
  projectRoot: string,
  projectName?: string,
): RegistrationClient | null {
  if (resolvedPort === undefined) {
    return null;
  }

  const client = new RegistrationClient(
    {
      projectId: resolveProjectId(projectRoot, projectName),
      metricsPort: resolvedPort,
      pid: process.pid,
    },
    { aggregatorPort, heartbeatIntervalMs: 30000, requestTimeoutMs: 1000 },
  );
  client.start();
  return client;
}

export const createNexusServer = (
  options: NexusServerOptions,
  awaitInitialize?: () => Promise<void>,
): McpServer => {
  const server = new McpServer(
    {
      name: "nexus",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions: "Nexus MCP server for local code search and indexing.",
    },
  );

  registerV1Tools(server, buildToolHandlers(options, awaitInitialize));

  return server;
};

export const buildNexusRuntime = (
  options: NexusRuntimeOptions,
): NexusRuntime => {
  let metricsServer: MetricsHttpServer | null = null;
  let initPromise: Promise<void> | null = null;
  let registrationClient: RegistrationClient | null = null;
  let autoReindexPromise: Promise<AutoReindexResult | undefined> | null = null;
  let isShuttingDown = false;

  const initialize = (): Promise<void> => {
    if (initPromise) {
      return initPromise;
    }
  initPromise = (async () => {
      await options.metadataStore.initialize();
      await options.vectorStore.initialize();
      await options.pipeline.reconcileOnStartup();

      let needsPostScan = false;
      try {
        const stats = await options.metadataStore.getIndexStats();
        const isUnindexed =
          stats === null ||
          stats.lastIndexedAt === null ||
          stats.lastError !== null;
        if (isUnindexed && !isShuttingDown) {
          options.eventQueue?.enterPostScanMode();
          needsPostScan = true;
        }
      } catch (statsError) {
        console.error('[Nexus] Failed to check index status for auto Full Index:', statsError);
      }

      try {
        options.pipeline.start();
        await options.watcher.start().catch((error) => {
          const code =
            error !== null && typeof error === "object" && "code" in error
              ? (error as Record<string, unknown>).code
              : undefined;
          const isNonFatal = code === "EMFILE" || code === "ENOSPC";

          if (isNonFatal) {
            console.error(
              `[Nexus Server Warning] Failed to start FileWatcher (${code}):`,
              error,
            );
          } else {
            throw error;
          }
        });

        // Use port 0 for auto-assignment, unless explicitly overridden.
        const preferredPort = options.metricsPort ?? 0;
        const dashboardStatusEndpoint = createDashboardStatusEndpoint(() =>
          buildDashboardIndexStatusSnapshot(
            options.metadataStore,
            options.vectorStore,
            options.pluginRegistry,
            options.pipeline,
          ),
        );
        metricsServer = options.metricsCollectorRegistry
          ? new MetricsHttpServer(options.metricsCollectorRegistry, dashboardStatusEndpoint)
          : null;
        if (metricsServer) {
          await metricsServer.start(preferredPort).catch((err) => {
            console.warn("[Nexus] Failed to start metrics HTTP server:", err);
          });
          const resolvedPort = metricsServer.getPort();
          await syncMetricsPortFile(options.storageDir, resolvedPort);
          registrationClient = options.packageMode
            ? null
            : createRegistrationClient(
                options.aggregatorPort ?? 9470,
                resolvedPort,
                options.projectRoot,
                options.projectName,
              );
        }
      } catch (error) {
        await options.pipeline.stop().catch((stopError: unknown) => {
          console.error(
            "Failed to stop pipeline during initialization rollback:",
            stopError,
          );
        });
        await options.watcher.stop().catch((stopError: unknown) => {
          console.error(
            "Failed to stop watcher during initialization rollback:",
            stopError,
          );
        });
        if (needsPostScan) {
          options.eventQueue?.abortPostScanMode();
        }
        throw error;
      }

      if (needsPostScan) {
        const startupReindexPromise = options.pipeline
          .reindex(
            options.runReindex,
            options.loadFileContent,
            true,
            'startup-reconciliation',
          )
          .then(async (result) => {
            if ('status' in result && result.status === 'already_running') {
              await options.pipeline.waitForActiveReindex();
            }
            if (!isShuttingDown) {
              options.eventQueue?.drainPostScanQueue();
            }
            return result;
          })
          .catch((error: unknown) => {
            if (!isShuttingDown) {
              options.eventQueue?.drainPostScanQueue();
            }
            console.error('[Nexus] Startup auto Full Index failed:', error);
            return undefined;
          });
        autoReindexPromise = startupReindexPromise;
        void startupReindexPromise.finally(() => {
          if (autoReindexPromise === startupReindexPromise) {
            autoReindexPromise = null;
          }
        });
      }
    })().catch((err) => {
      // Reset initPromise on failure so initialize() can be retried later
      initPromise = null;
      throw err;
    });
    return initPromise;
  };
  const close = async () => {
    isShuttingDown = true;
    const shutdownErrors: unknown[] = [];

    // Wait for any ongoing initialization to complete or fail before
    // proceeding with shutdown. If initialization is in progress, calling
    // stop() while start() is running can leave watcher/pipeline in an
    // undefined state.
    if (initPromise) {
      try {
        await initPromise;
      } catch {
        // Initialization failed; rollback inside initialize() already
        // attempted cleanup. Proceed with the rest of shutdown.
      }
    }

    options.eventQueue?.abortPostScanMode();

    if (metricsServer) {
      try {
        await metricsServer.stop();
      } catch (error) {
        shutdownErrors.push(error);
      }
      if (options.storageDir) {
        await removeMetricsPort(options.storageDir).catch(() => {});
      }
    }
    if (registrationClient) {
      registrationClient.stop();
      registrationClient = null;
    }


    try {
      await options.watcher.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    if (autoReindexPromise) {
      try {
        await autoReindexPromise;
      } catch (error) {
        shutdownErrors.push(error);
      }
    }

    try {
      await options.pipeline.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    if (options.onClose) {
      try {
        await options.onClose();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }


    if (shutdownErrors.length === 1) {
      throw shutdownErrors[0];
    } else if (shutdownErrors.length > 1) {
      throw new AggregateError(
        shutdownErrors,
        "Multiple errors occurred during Nexus runtime shutdown",
      );
    }
  };

  const reindex = async (fullRebuild?: boolean) => {
    await initialize();
    const result = await options.pipeline.reindex(
      options.runReindex,
      options.loadFileContent,
      fullRebuild,
    );
    if ("status" in result) {
      if (result.status === 'already_running' && autoReindexPromise) {
        const startupResult = await autoReindexPromise;
        if (startupResult !== undefined && 'status' in startupResult && startupResult.status === 'incomplete') {
          throw new Error('Reindex incomplete: dead-letter queue entries remain');
        }
        const lastError = options.pipeline.getProgress().lastError;
        if (lastError !== undefined) {
          throw new Error(lastError);
        }
        return;
      }
      const message = result.status === 'already_running'
        ? `Reindex already running: ${result.status}`
        : 'Reindex incomplete: dead-letter queue entries remain';
      throw new Error(message);
    }
  };

  const createServer = (): McpServer => createNexusServer(options, () => initialize());

  return {
    createServer,
    orchestrator: options.orchestrator,
    sanitizer: options.sanitizer,
    initialize,
    close,
    reindex,
    get registrationClient() { return registrationClient; }
  };
};

export const initializeNexusRuntime = async (
  options: NexusRuntimeOptions,
): Promise<NexusRuntime> => {
  const runtime = buildNexusRuntime(options);
  await runtime.initialize();
  return runtime;
};
