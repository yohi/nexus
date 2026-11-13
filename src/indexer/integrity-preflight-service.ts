import pLimit from 'p-limit';
import type { IndexEvent, IMetadataStore, IVectorStore } from '../types/index.js';
import { supportsStructuredCatalog } from '../storage/interfaces/metadata-store.js';
import { runIntegrityPreflight } from './integrity-preflight.js';
import type { IntegrityPreparedFile, IntegrityPreflightResult } from './integrity-preflight-types.js';

type ContentLoader = (filePath: string) => Promise<string>;

interface IntegrityPreflightServiceOptions {
  readonly metadataStore: IMetadataStore;
  readonly vectorStore: IVectorStore;
  readonly dimensions: number;
  readonly concurrency: number;
  readonly embeddingKeyFor: ((hash: string) => string) | undefined;
  readonly l1Embeddings: ReadonlyMap<string, readonly number[]>;
  readonly loadEmbeddingSource: (hashes: readonly string[]) => Promise<ReadonlyMap<string, number[]>>;
  readonly prepareFile: (event: IndexEvent, loadContent: ContentLoader) => Promise<IntegrityPreparedFile>;
  readonly readSourceHash: (filePath: string, loadContent: ContentLoader) => Promise<string>;
  readonly assertWriterLease: () => void;
  readonly queueIsQuiet: () => boolean;
  readonly signal: AbortSignal;
  readonly catalogEnabled: boolean;
}

export class IntegrityPreflightService {
  constructor(private readonly options: IntegrityPreflightServiceOptions) {}

  async assess(
    events: readonly IndexEvent[],
    run: (options?: { fullScan?: boolean; reason?: 'manual' | 'overflow-recovery' | 'startup-reconciliation' | 'integrity-recovery' }) => Promise<IndexEvent[]>,
    loadContent: ContentLoader,
    reason: 'manual' | 'overflow-recovery' | 'startup-reconciliation' | 'integrity-recovery' | undefined,
  ): Promise<IntegrityPreflightResult> {
    const limit = pLimit(this.options.concurrency);
    const files = await Promise.all(events.map((event) =>
      limit(async () => await this.options.prepareFile(event, loadContent))));
    return await runIntegrityPreflight({
      events, files,
      metadataStore: this.options.metadataStore,
      vectorStore: this.options.vectorStore,
      dimensions: this.options.dimensions,
      embeddingKeyFor: this.options.embeddingKeyFor,
      l1Embeddings: this.options.l1Embeddings,
      loadEmbeddingSource: this.options.loadEmbeddingSource,
      rescan: async () => await run({ fullScan: true, reason }),
      readSourceHash: async (filePath) => await this.options.readSourceHash(filePath, loadContent),
      assertWriterLease: this.options.assertWriterLease,
      queueIsQuiet: this.options.queueIsQuiet,
      signal: this.options.signal,
      catalogEnabled: this.options.catalogEnabled,
    });
  }

  async completeScanEvents(events: readonly IndexEvent[]): Promise<IndexEvent[] | undefined> {
    try {
      if (events.some((event) => event.type !== 'added')
        || new Set(events.map((event) => event.filePath)).size !== events.length) return undefined;
      this.options.assertWriterLease();
      const knownPaths = new Set((await this.options.metadataStore.getAllFileNodes()).map((node) => node.path));
      const metadataStore = this.options.metadataStore;
      if (supportsStructuredCatalog(metadataStore)) {
        const state = await metadataStore.getStructuredIndexState();
        for (const filePath of state.activeGenerations.keys()) knownPaths.add(filePath);
      }
      const physicalRows = this.options.vectorStore.iteratePhysicalRows({
        pageSize: 256, signal: this.options.signal,
      });
      for await (const row of physicalRows) knownPaths.add(row.filePath);
      const scannedPaths = new Set(events.map((event) => event.filePath));
      const detectedAt = events[0]?.detectedAt ?? new Date().toISOString();
      const deletedEvents = [...knownPaths]
        .filter((filePath) => !scannedPaths.has(filePath))
        .sort((left, right) => left.localeCompare(right))
        .map((filePath): IndexEvent => ({ type: 'deleted', filePath, detectedAt }));
      this.options.assertWriterLease();
      return [...events, ...deletedEvents];
    } catch {
      return undefined;
    }
  }
}
