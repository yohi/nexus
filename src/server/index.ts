import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { SearchOrchestrator } from "../search/orchestrator.js";
import type { ISemanticSearch } from "../search/semantic.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type {
  IMetadataStore,
  IVectorStore,
  IGrepEngine,
  IndexEvent,
  IFileWatcher,
  ReindexOptions,
  IIndexPipeline,
} from "../types/index.js";
import { type PathSanitizer } from "./path-sanitizer.js";
import { sanitizeErrorMessage } from "../utils/error-utils.js";
import { executeGetContext } from "./tools/get-context.js";
import { executeGrepSearch, type GrepSearchToolArgs } from "./tools/grep-search.js";
import { executeHybridSearch, type HybridSearchToolArgs } from "./tools/hybrid-search.js";
import { executeIndexStatus } from "./tools/index-status.js";
import { executeReindex } from "./tools/reindex.js";
import { executeSemanticSearch, type SemanticSearchToolArgs } from "./tools/semantic-search.js";
import { MetricsHttpServer } from "../observability/metrics-server.js";
import type { Registry } from "prom-client";

export interface NexusServerOptions {
  projectRoot: string;
  sanitizer: PathSanitizer;
  semanticSearch: ISemanticSearch;
  grepEngine: IGrepEngine;
  orchestrator: SearchOrchestrator;
  vectorStore: IVectorStore;
  metadataStore: IMetadataStore;
  pipeline: IIndexPipeline;
  pluginRegistry: PluginRegistry;
  runReindex: (options?: ReindexOptions) => Promise<IndexEvent[]>;
  loadFileContent: (filePath: string) => Promise<string>;
}

export interface NexusRuntimeOptions extends NexusServerOptions {
  watcher: IFileWatcher;
  onClose?: () => Promise<void>;
  metricsCollectorRegistry?: Registry;
}

export interface NexusRuntime {
  server: McpServer;
  orchestrator: SearchOrchestrator;
  sanitizer: PathSanitizer;
  initialize(): Promise<void>;
  close(): Promise<void>;
  reindex(fullRebuild?: boolean): Promise<void>;
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

  server.registerTool(
    "semantic_search",
    {
      description: "Search the codebase using natural language (embeddings)",
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        language: z.string().optional(),
      },
    },
    async (args, extra) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeSemanticSearch(
            options.semanticSearch,
            options.sanitizer,
            args as SemanticSearchToolArgs & { filePattern?: string },
            extra?.signal,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "grep_search",
    {
      description: "ripgrep-based text search",
      inputSchema: {
        pattern: z.string(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    async (args, extra) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeGrepSearch(
            options.grepEngine,
            options.projectRoot,
            options.sanitizer,
            args as GrepSearchToolArgs,
            extra?.signal,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "hybrid_search",
    {
      description: "Combined semantic and grep search",
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        filePatterns: z.array(z.string()).optional(),
        language: z.string().optional(),
        grepPattern: z.string().optional(),
      },
    },
    async (args, extra) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeHybridSearch(
            options.orchestrator,
            options.sanitizer,
            args as HybridSearchToolArgs & { filePattern?: string },
            extra?.signal,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "get_context",
    {
      description: "Retrieve file context",
      inputSchema: {
        filePath: z.string(),
        symbolName: z.string().optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
    },
    async (args) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeGetContext(
            options.loadFileContent,
            options.sanitizer,
            args,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "index_status",
    {
      description: "Return index state and statistics",
      inputSchema: {},
    },
    async () => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeIndexStatus(
            options.metadataStore,
            options.vectorStore,
            options.pluginRegistry,
            options.pipeline,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  server.registerTool(
    "reindex",
    {
      description: "Manually trigger reindexing",
      inputSchema: {
        fullRebuild: z.boolean().optional(),
      },
    },
    async (args) => {
      if (awaitInitialize) await awaitInitialize();
      try {
        return toolResult(
          await executeReindex(
            options.pipeline,
            options.runReindex,
            options.loadFileContent,
            args,
          ),
        );
      } catch (error) {
        return errorResult(error);
      }
    },
  );

  return server;
};

export const buildNexusRuntime = (
  options: NexusRuntimeOptions,
): NexusRuntime => {
  const server = createNexusServer(options, () => initialize());
  let metricsServer: MetricsHttpServer | null = null;
  let initPromise: Promise<void> | null = null;

  const initialize = (): Promise<void> => {
    if (initPromise) {
      return initPromise;
    }
  initPromise = (async () => {
      await options.metadataStore.initialize();
      await options.vectorStore.initialize();
      await options.pipeline.reconcileOnStartup();

      try {
        options.pipeline.start();
        await options.watcher.start().catch((error) => {
          const code =
            error !== null &&
            typeof error === "object" &&
            "code" in error &&
            (error as Record<string, unknown>).code;
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

        const envPort = process.env.NEXUS_METRICS_PORT;
        const port = envPort ? Number(envPort) : 9464;
        const metricsPort =
          Number.isInteger(port) && port > 0 && port <= 65535 ? port : 9464;
        metricsServer = options.metricsCollectorRegistry
          ? new MetricsHttpServer(options.metricsCollectorRegistry)
          : null;
        if (metricsServer) {
          await metricsServer.start(metricsPort).catch((err) => {
            console.warn("[Nexus] Failed to start metrics HTTP server:", err);
          });
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
        throw error;
      }
    })().catch((err) => {
      // Reset initPromise on failure so initialize() can be retried later
      initPromise = null;
      throw err;
    });
    return initPromise;
  };
  const close = async () => {
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

    if (metricsServer) {
      try {
        await metricsServer.stop();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }

    if (options.onClose) {
      try {
        await options.onClose();
      } catch (error) {
        shutdownErrors.push(error);
      }
    }

    try {
      await options.watcher.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    try {
      await options.pipeline.stop();
    } catch (error) {
      shutdownErrors.push(error);
    }

    try {
      await server.close();
    } catch (error) {
      shutdownErrors.push(error);
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
    await options.runReindex({ fullScan: fullRebuild });
  };

  return { server, orchestrator: options.orchestrator, sanitizer: options.sanitizer, initialize, close, reindex };
};

export const initializeNexusRuntime = async (
  options: NexusRuntimeOptions,
): Promise<NexusRuntime> => {
  const runtime = buildNexusRuntime(options);
  await runtime.initialize();
  return runtime;
};

export const errorResult = (error: unknown) => {
  const errorMessage = sanitizeErrorMessage(error);
  // Log the original error for server-side debugging
  console.error("[Nexus Server Error]", error);

  return {
    content: [
      {
        type: "text" as const,
        text: `Error: ${errorMessage}`,
      },
    ],
    isError: true,
    structuredContent: { error: true, message: errorMessage },
  };
};

export const toolResult = <T extends object>(structuredContent: T) => {
  try {
    // Produce a JSON-safe copy by converting BigInt values to strings
    const normalized: unknown = JSON.parse(
      JSON.stringify(structuredContent, (_key: string, value: unknown): unknown =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(normalized, null, 2),
        },
      ],
      structuredContent: normalized as Record<string, unknown>,
    };
  } catch (error) {
    const errorMessage = sanitizeErrorMessage(error);
    // Log the original error for server-side debugging
    console.error("[Nexus Serialization Error]", error);

    return {
      content: [
        {
          type: "text" as const,
          text: `Failed to serialize structuredContent: ${errorMessage}`,
        },
      ],
      isError: true,
      structuredContent: {
        error: true,
        message: errorMessage,
        originalType: typeof structuredContent,
      },
    };
  }
};
