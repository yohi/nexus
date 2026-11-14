import { describe, expect, it } from 'vitest';
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
});
