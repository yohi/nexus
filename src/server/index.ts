import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { IIndexPipeline } from '../indexer/pipeline.js';
import type { PluginRegistry } from '../plugins/registry.js';
import type { SearchOrchestrator } from '../search/orchestrator.js';
import type { ISemanticSearch } from '../search/semantic.js';
import type { IMetadataStore, IVectorStore, IGrepEngine, IndexEvent, IFileWatcher, ReindexOptions } from '../types/index.js';
import type { PathSanitizer } from './path-sanitizer.js';
import { executeGetContext } from './tools/get-context.js';
import { executeGrepSearch } from './tools/grep-search.js';
import { executeHybridSearch } from './tools/hybrid-search.js';
import { executeIndexStatus } from './tools/index-status.js';
import { executeReindex } from './tools/reindex.js';
import { executeSemanticSearch } from './tools/semantic-search.js';

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
}

export interface NexusRuntime {
  server: McpServer;
  close(): Promise<void>;
}

export const createNexusServer = (options: NexusServerOptions): McpServer => {
  const server = new McpServer(
    {
      name: 'nexus',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: { listChanged: true },
      },
      instructions: 'Nexus MCP server for local code search and indexing.',
    },
  );

  server.registerTool(
    'semantic_search',
    {
      description: 'Vector similarity search only',
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        language: z.string().optional(),
      },
    },
    async (args) => toolResult(await executeSemanticSearch(options.semanticSearch, args)),
  );

  server.registerTool(
    'grep_search',
    {
      description: 'ripgrep-based text search',
      inputSchema: {
        pattern: z.string(),
        filePattern: z.string().optional(),
        caseSensitive: z.boolean().optional(),
        maxResults: z.number().int().positive().optional(),
      },
    },
    async (args) => toolResult(await executeGrepSearch(options.grepEngine, options.projectRoot, args)),
  );

  server.registerTool(
    'hybrid_search',
    {
      description: 'Combined semantic and grep search',
      inputSchema: {
        query: z.string(),
        topK: z.number().int().positive().optional(),
        filePattern: z.string().optional(),
        language: z.string().optional(),
        grepPattern: z.string().optional(),
      },
    },
    async (args) => toolResult(await executeHybridSearch(options.orchestrator, args)),
  );

  server.registerTool(
    'get_context',
    {
      description: 'Retrieve file context',
      inputSchema: {
        filePath: z.string(),
        symbolName: z.string().optional(),
        startLine: z.number().int().positive().optional(),
        endLine: z.number().int().positive().optional(),
      },
    },
    async (args) => toolResult(await executeGetContext(options.loadFileContent, options.sanitizer, args)),
  );

  server.registerTool(
    'index_status',
    {
      description: 'Return index state and statistics',
      inputSchema: {},
    },
    async () =>
      toolResult(
        await executeIndexStatus(
          options.metadataStore,
          options.vectorStore,
          options.pipeline,
          options.pluginRegistry,
        ),
      ),
  );

  server.registerTool(
    'reindex',
    {
      description: 'Manually trigger reindexing',
      inputSchema: {
        fullRebuild: z.boolean().optional(),
      },
    },
    async (args) =>
      toolResult(await executeReindex(options.pipeline, options.runReindex, options.loadFileContent, args)),
  );

  return server;
};

export const initializeNexusRuntime = async (options: NexusRuntimeOptions): Promise<NexusRuntime> => {
  await options.metadataStore.initialize();
  await options.vectorStore.initialize();
  await options.pipeline.reconcileOnStartup();
  await options.watcher.start();

  const server = createNexusServer(options);

  return {
    server,
    close: async () => {
      await options.watcher.stop();
      await server.close();
    },
  };
};

const toolResult = <T extends object>(structuredContent: T) => {
  try {
    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(structuredContent, null, 2),
        },
      ],
      structuredContent: structuredContent as Record<string, unknown>,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: 'text' as const,
          text: `Failed to serialize structuredContent: ${errorMessage}`,
        },
      ],
      structuredContent: { error: true, message: errorMessage, originalType: typeof structuredContent },
    };
  }
};
