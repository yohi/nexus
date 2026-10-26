import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { StructuredIndexCoordinator } from '../../../src/indexer/structured-index-coordinator.js';
import { ProjectWriteCoordinator } from '../../../src/indexer/project-write-coordinator.js';
import { MetricsCollector } from '../../../src/observability/metrics-collector.js';
import type { RuntimeEvent } from '../../../src/observability/runtime-observer.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { SqliteMetadataStore } from '../../../src/storage/metadata-store.js';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import type { EmbeddingProvider } from '../../../src/types/index.js';
import { createSyntheticProvider, syntheticEmbeddingConfig } from '../../benchmarks/performance/synthetic-provider.js';

class CountingProvider implements EmbeddingProvider {
  readonly dimensions = 128;
  calls = 0;
  readonly batchSizes: number[] = [];
  readonly inputDigests: string[][] = [];
  private readonly provider = createSyntheticProvider();
  embed(texts: string[], signal?: AbortSignal): Promise<number[][]> {
    this.calls += 1;
    this.batchSizes.push(texts.length);
    this.inputDigests.push(texts.map((text) => createHash('sha256').update(text).digest('hex')));
    return this.provider.embed(texts, signal);
  }
  healthCheck(): Promise<boolean> { return this.provider.healthCheck(); }
}

export async function createCacheRuntime(root: string, model: string) {
  const metadataStore = new SqliteMetadataStore({ databasePath: join(root, 'cache.db') });
  const vectorStore = new LanceVectorStore({ dbPath: join(root, `vectors-${model}`), dimensions: 128 });
  try {
    await metadataStore.initialize();
    await vectorStore.initialize();
    const provider = new CountingProvider();
    const registry = new PluginRegistry();
    registry.registerLanguage(new TypeScriptLanguagePlugin());
    registry.registerEmbeddingProvider('test', provider);
    registry.setActiveEmbeddingProvider('test');
    const chunker = new Chunker(registry, { maxChunkChars: 4096 });
    const events: RuntimeEvent[] = [];
    const metrics = new MetricsCollector({ projectName: 'cache-test' });
    const pipeline = new IndexPipeline({
      metadataStore, vectorStore, chunker, embeddingProvider: provider,
      embeddingConfig: { ...syntheticEmbeddingConfig, model }, pluginRegistry: registry,
      metricsHooks: metrics, observer: { onEvent: (event) => { events.push(event); } },
      structuredIndexCoordinator: new StructuredIndexCoordinator({ metadataStore, vectorStore, chunker,
        projectWriteCoordinator: new ProjectWriteCoordinator(), config: { embedding: { dimensions: 128 } } }),
    });
    return { pipeline, provider, metadataStore, vectorStore, metrics, events,
      close: async () => { try { await pipeline.stop(); } finally { await metadataStore.close(); } } };
  } catch (error) {
    await vectorStore.close();
    await metadataStore.close();
    throw error;
  }
}
