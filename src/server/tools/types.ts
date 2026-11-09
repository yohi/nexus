import type { MetricsHooks } from '../../observability/types.js';
import type { EventQueue } from '../../indexer/event-queue.js';
import type { LspNavigationService } from '../../lsp/navigation-service.js';
import type { PluginRegistry } from '../../plugins/registry.js';
import type { SearchOrchestrator } from '../../search/orchestrator.js';
import type { IContentStore } from '../../storage/interfaces/content-store.js';
import type { ISemanticSearch } from '../../search/semantic.js';
import type { SymbolRetrievalService } from '../../structured/retrieval-service.js';
import type {
  IIndexPipeline,
  IMetadataStore,
  IVectorStore,
  IGrepEngine,
  IndexEvent,
  ReindexOptions,
} from '../../types/index.js';
import type { PathSanitizer } from '../path-sanitizer.js';

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
  contentStore?: IContentStore;
  metricsHooks?: MetricsHooks;
  packageMode?: boolean;
  eventQueue?: EventQueue;
  symbolRetrievalService?: SymbolRetrievalService;
  /** Internal assembly seam: runtime-local LSP navigation (absent => unavailable/LSP_NOT_CONFIGURED). */
  lspNavigationService?: LspNavigationService;
}

export interface NexusToolCallResult {
  readonly [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

export interface ToolHandlerExtras {
  readonly signal?: AbortSignal | undefined;
}

export type ToolHandler = (
  args: unknown,
  extra?: ToolHandlerExtras,
) => Promise<NexusToolCallResult>;
