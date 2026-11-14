import pLimit from 'p-limit';
import type { IndexEvent, IMetadataStore, IVectorStore } from '../types/index.js';
import { supportsStructuredCatalog } from '../storage/interfaces/metadata-store.js';
import { runIntegrityPreflight } from './integrity-preflight.js';
import { collectExpectedDirectoryPaths } from './integrity-preflight-merkle.js';
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
  readonly getSignal: () => AbortSignal;
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
    const signal = this.options.getSignal();
    const limit = pLimit(this.options.concurrency);
    let files: IntegrityPreparedFile[];
    try {
      files = await Promise.all(events.map((event) =>
        limit(async () => await this.options.prepareFile(event, loadContent))));
    } catch {
      return { kind: 'INTEGRITY_UNKNOWN', reason: 'audit_incomplete' };
    }
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
      signal,
      catalogEnabled: this.options.catalogEnabled,
    });
  }

  async completeScanEvents(events: readonly IndexEvent[]): Promise<IndexEvent[] | undefined> {
    try {
      const signal = this.options.getSignal();
      if (events.some((event) => event.type !== 'added')
        || new Set(events.map((event) => event.filePath)).size !== events.length) return undefined;
      this.options.assertWriterLease();
      const merkleNodes = await this.options.metadataStore.getAllNodes();
      const expectedDirectories = collectExpectedDirectoryPaths(events.map((event) => event.filePath));
      const orphanedDirectoryPaths = merkleNodes
        .filter((node) => node.isDirectory && !expectedDirectories.has(node.path))
        .map((node) => node.path);
      const orphanedDirectoryRoots = orphanedDirectoryPaths.filter((directoryPath) =>
        !orphanedDirectoryPaths.some((candidate) =>
          directoryPath !== candidate && directoryPath.startsWith(`${candidate}/`)));
      const knownPaths = new Set(merkleNodes.filter((node) => !node.isDirectory).map((node) => node.path));
      for (const directoryPath of orphanedDirectoryRoots) knownPaths.add(directoryPath);
      const metadataStore = this.options.metadataStore;
      if (supportsStructuredCatalog(metadataStore)) {
        const state = await metadataStore.getStructuredIndexState();
        for (const filePath of state.activeGenerations.keys()) knownPaths.add(filePath);
      }
      const physicalRows = this.options.vectorStore.iteratePhysicalRows({
        pageSize: 256, signal,
      });
      for await (const row of physicalRows) knownPaths.add(row.filePath);
      const scannedPaths = new Set(events.map((event) => event.filePath));
      const detectedAt = events[0]?.detectedAt ?? new Date().toISOString();
      const deletedEvents = [...knownPaths]
        .filter((filePath) => !scannedPaths.has(filePath)
          && !orphanedDirectoryRoots.some((directoryPath) =>
            filePath !== directoryPath && filePath.startsWith(`${directoryPath}/`)))
        .sort((left, right) => left.localeCompare(right))
        .map((filePath): IndexEvent => ({ type: 'deleted', filePath, detectedAt }));
      this.options.assertWriterLease();
      return [...events, ...deletedEvents];
    } catch {
      return undefined;
    }
  }
}
