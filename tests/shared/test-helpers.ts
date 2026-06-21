import { Chunker } from '../../src/indexer/chunker.js';
import { PluginRegistry } from '../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../src/plugins/languages/typescript.js';
import type { LanguagePlugin } from '../../src/types/index.js';
import { InMemoryMetadataStore } from '../unit/storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../unit/storage/in-memory-vector-store.js';
import { vi } from 'vitest';
import type { NexusRuntimeOptions } from '../../src/server/index.js';
import path from 'node:path';

export interface CreatePipelineOptions {
  dimensions?: number;
  plugins?: LanguagePlugin[];
  registry?: PluginRegistry;
}

export const createPipeline = async (options: CreatePipelineOptions = {}) => {
  const { dimensions = 64, plugins, registry: providedRegistry } = options;
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions });
  const registry = providedRegistry || new PluginRegistry();

  if (!providedRegistry) {
    if (plugins && plugins.length > 0) {
      for (const plugin of plugins) {
        registry.registerLanguage(plugin);
      }
    } else {
      registry.registerLanguage(new TypeScriptLanguagePlugin());
    }
  }

  await metadataStore.initialize();
  await vectorStore.initialize();

  return {
    metadataStore,
    vectorStore,
    chunker: new Chunker(registry),
    registry,
  };
};

export const createMockNexusRuntimeOptions = (overrides: Partial<NexusRuntimeOptions> = {}): NexusRuntimeOptions => {
  return {
    metadataStore: { initialize: vi.fn().mockResolvedValue(undefined) },
    vectorStore: { initialize: vi.fn().mockResolvedValue(undefined) },
    pipeline: {
      reconcileOnStartup: vi.fn().mockResolvedValue({}),
      start: vi.fn(),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    watcher: {
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
    },
    projectRoot: path.join(process.cwd(), 'test-project'),
    sanitizer: {},
    semanticSearch: {},
    grepEngine: {},
    orchestrator: {},
    pluginRegistry: {},
    runReindex: vi.fn(),
    loadFileContent: vi.fn(),
    ...overrides,
  } as unknown as NexusRuntimeOptions;
};

import type { MetricsHooks } from '../../src/observability/types.js';
import type { Registry } from 'prom-client';

export const createMockMetricsHooks = (): MetricsHooks => ({
  onQueueSnapshot: vi.fn(),
  onChunksIndexed: vi.fn(),
  onReindexComplete: vi.fn(),
  onDlqSnapshot: vi.fn(),
  onRecoverySweepComplete: vi.fn(),
  onIndexingProgress: vi.fn(),
  onToolCall: vi.fn(),
  onSearchResults: vi.fn(),
  onContextLinesFetched: vi.fn(),
  onEmbeddingRequest: vi.fn(),
});

export const createMockRegistry = (): Registry =>
  ({ metrics: vi.fn().mockResolvedValue(''), getMetricsAsJSON: vi.fn().mockResolvedValue([]) } as unknown as Registry);

