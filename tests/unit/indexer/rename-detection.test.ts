import { describe, expect, it, vi } from 'vitest';
import { Chunker } from '../../../src/indexer/chunker.js';
import { IndexPipeline } from '../../../src/indexer/pipeline.js';
import { PluginRegistry } from '../../../src/plugins/registry.js';
import { TypeScriptLanguagePlugin } from '../../../src/plugins/languages/typescript.js';
import { TestEmbeddingProvider } from '../plugins/embeddings/test-embedding-provider.js';
import { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';
import type { IndexEvent } from '../../../src/types/index.js';

const createPipeline = async () => {
  const metadataStore = new InMemoryMetadataStore();
  const vectorStore = new InMemoryVectorStore({ dimensions: 64 });
  const registry = new PluginRegistry();
  registry.registerLanguage(new TypeScriptLanguagePlugin());

  await metadataStore.initialize();
  await vectorStore.initialize();

  return {
    metadataStore,
    vectorStore,
    chunker: new Chunker(registry),
    registry,
  };
};

describe('IndexPipeline rename detection', () => {
  it('detects rename and reuses vector store entries', async () => {
    const { metadataStore, vectorStore, chunker, registry } = await createPipeline();
    const provider = new TestEmbeddingProvider();
    const embedSpy = vi.spyOn(provider, 'embed');
    const pipeline = new IndexPipeline({
      metadataStore,
      vectorStore,
      chunker,
      embeddingProvider: provider,
      pluginRegistry: registry,
    });

    const content = 'export const test = 1;';
    const hash = 'hash-xyz';
    const addedEvent: IndexEvent = { type: 'added', filePath: 'src/old.ts', contentHash: hash, detectedAt: '' };
    
    await pipeline.processEvents([addedEvent], async () => content);
    expect(embedSpy).toHaveBeenCalled();

    embedSpy.mockClear();

    const renameEvents: IndexEvent[] = [
      { type: 'deleted', filePath: 'src/old.ts', contentHash: hash, detectedAt: '' },
      { type: 'added', filePath: 'src/new.ts', contentHash: hash, detectedAt: '' }
    ];

    const renameSpy = vi.spyOn(vectorStore, 'renameFilePath');
    await pipeline.processEvents(renameEvents, async () => content);

    expect(renameSpy).toHaveBeenCalledWith('src/old.ts', 'src/new.ts');
    
    expect(embedSpy).not.toHaveBeenCalled();

    const results = await vectorStore.search(new Array(64).fill(0), 10);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]?.chunk.filePath).toBe('src/new.ts');
  });
});
