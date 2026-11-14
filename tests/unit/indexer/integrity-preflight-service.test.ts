import { describe, expect, it, vi } from 'vitest';
import { IntegrityPreflightService } from '../../../src/indexer/integrity-preflight-service.js';
import { createPipeline } from '../../shared/test-helpers.js';

describe('IntegrityPreflightService', () => {
  it('returns audit_incomplete when preparing a scanned file fails', async () => {
    const { metadataStore, vectorStore } = await createPipeline();
    const service = new IntegrityPreflightService({
      metadataStore,
      vectorStore,
      dimensions: 64,
      concurrency: 1,
      embeddingKeyFor: undefined,
      l1Embeddings: new Map(),
      loadEmbeddingSource: async () => new Map(),
      prepareFile: async () => { throw new Error('scanned file became unreadable'); },
      readSourceHash: async () => 'source-hash',
      assertWriterLease: () => undefined,
      queueIsQuiet: () => true,
      getSignal: () => new AbortController().signal,
      catalogEnabled: false,
    });
    const events = [{ type: 'added' as const, filePath: 'src/raced.ts', detectedAt: new Date().toISOString() }];

    await expect(service.assess(events, async () => events, async () => '', 'integrity-recovery'))
      .resolves.toMatchObject({ kind: 'INTEGRITY_UNKNOWN', reason: 'audit_incomplete' });
  });

  it('keeps an orphaned directory child deletion when the scanned file has the same path', async () => {
    const { metadataStore, vectorStore } = await createPipeline();
    vi.spyOn(metadataStore, 'getAllNodes').mockResolvedValue([
      { path: 'src', hash: 'src-hash', parentPath: null, isDirectory: true },
      { path: 'src/orphan', hash: 'directory-hash', parentPath: 'src', isDirectory: true },
      { path: 'src/orphan/old.ts', hash: 'old-hash', parentPath: 'src/orphan', isDirectory: false },
    ]);
    const service = new IntegrityPreflightService({
      metadataStore,
      vectorStore,
      dimensions: 64,
      concurrency: 1,
      embeddingKeyFor: undefined,
      l1Embeddings: new Map(),
      loadEmbeddingSource: async () => new Map(),
      prepareFile: async () => ({
        event: { type: 'added', filePath: 'src/orphan', detectedAt: 'now' },
        sourceHash: 'source-hash', merkleHash: 'merkle-hash', chunks: [], structured: undefined,
        structuredRetirement: false, structuredParseFailed: false, skipped: false,
      }),
      readSourceHash: async () => 'source-hash',
      assertWriterLease: () => undefined,
      queueIsQuiet: () => true,
      getSignal: () => new AbortController().signal,
      catalogEnabled: false,
    });
    vi.spyOn(vectorStore, 'iteratePhysicalRows').mockImplementation(async function* () {});
    const events = [{ type: 'added' as const, filePath: 'src/orphan', detectedAt: 'now' }];

    const completed = await service.completeScanEvents(events);

    expect(completed).toEqual([
      ...events,
      { type: 'deleted', filePath: 'src/orphan/old.ts', detectedAt: 'now' },
    ]);
  });
});
