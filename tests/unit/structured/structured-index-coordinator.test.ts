import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  createStructuredCoordinatorFixture,
  createStructuredStage,
  runStructuredFullRebuild,
  stageStructuredFile,
} from '../../shared/structured-test-helpers.js';
import type { StructuredIndexCoordinator } from '../../../src/indexer/structured-index-coordinator.js';
import type { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import type { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

describe('StructuredIndexCoordinator', () => {
  let metadataStore: InMemoryMetadataStore;
  let vectorStore: InMemoryVectorStore;
  let coordinator: StructuredIndexCoordinator;

  beforeEach(async () => {
    const fixture = await createStructuredCoordinatorFixture();
    metadataStore = fixture.metadataStore;
    vectorStore = fixture.vectorStore;
    coordinator = fixture.coordinator;
  });

  it.each([1, 2, 3])('checks the writer lease before initial rebuild write %i', async (leaseCheckToFail) => {
    const bootstrap = vi.spyOn(metadataStore, 'bootstrapStructuredSchema');
    const incrementEpoch = vi.spyOn(metadataStore, 'incrementRebuildEpoch');
    const setRebuildState = vi.spyOn(metadataStore, 'setStructuredRebuildState');
    let leaseChecks = 0;

    await expect(coordinator.runFullRebuild({
      files: [],
      merkleSnapshot: [],
      assertWriterLease: () => {
        leaseChecks += 1;
        if (leaseChecks === leaseCheckToFail) throw new Error('test writer lease lost');
      },
    })).rejects.toThrow('test writer lease lost');

    expect(bootstrap).toHaveBeenCalledTimes(Math.min(1, leaseCheckToFail - 1));
    expect(incrementEpoch).toHaveBeenCalledTimes(Math.max(0, leaseCheckToFail - 2));
    expect(setRebuildState).not.toHaveBeenCalled();
  });

  it('preserves the catalog rebuild epoch while staging a file', async () => {
    const stage = createStructuredStage('src/a.ts', 'export function a() { return 1; }', 'a');

    expect((await metadataStore.getStructuredIndexState()).rebuildEpoch).toBe(0);
    await stageStructuredFile(coordinator, stage);

    expect((await metadataStore.getStructuredIndexState()).rebuildEpoch).toBe(0);
  });

  it('does not retain diagnostic row counts during an unobserved stage', async () => {
    const stage = createStructuredStage('src/unobserved.ts', 'export function unobserved() { return 1; }', 'unobserved');

    await stageStructuredFile(coordinator, stage);

    expect(coordinator['stagedGenerationRowCounts'].size).toBe(0);
  });

  it('does not stage incremental generations while rollback recovery is pending', async () => {
    const stage = createStructuredStage('src/recovery-pending.ts', 'export function pending() { return 1; }', 'pending');
    const stageGeneration = vi.spyOn(metadataStore, 'stageGeneration');
    await metadataStore.setStructuredRebuildState({ rebuildState: 'catalog-activated' });

    await expect(stageStructuredFile(coordinator, stage)).rejects.toThrow('unresolved full-rebuild recovery');

    expect(stageGeneration).not.toHaveBeenCalled();
    await expect(metadataStore.resolveFile(stage.source.filePath)).resolves.toEqual({ kind: 'missing' });
  });

  it('runs orphan vector cleanup after a successful catalog rollback', async () => {
    const stage = createStructuredStage('src/rollback-cleanup.ts', 'export function cleanup() { return 1; }', 'cleanup');
    const order: string[] = [];
    const originalRollback = metadataStore.rollbackFullRebuild.bind(metadataStore);
    vi.spyOn(metadataStore, 'rollbackFullRebuild').mockImplementation(async (input) => {
      await originalRollback(input);
      order.push('catalog-rollback');
    });
    Object.defineProperty(vectorStore, 'cleanupOrphanedRebuildTables', {
      configurable: true,
      value: async () => { order.push('vector-cleanup'); },
    });

    await expect(coordinator.runFullRebuild({
      files: [{
        source: stage.source,
        generationId: stage.generationId,
        contentHash: stage.contentHash,
        fileCompleteness: 'complete',
        declarations: [stage.symbol],
        imports: [],
      }],
      merkleSnapshot: [],
      beforeCommit: async () => { throw new Error('injected pre-commit failure'); },
    })).rejects.toThrow('injected pre-commit failure');

    expect(order).toEqual(['catalog-rollback', 'vector-cleanup']);
  });

  it('preserves structured vectors when activating the same generation again', async () => {
    const stage = createStructuredStage('src/same.ts', 'export function same() { return 1; }', 'same');
    await stageStructuredFile(coordinator, stage);
    await coordinator.activateFile({ filePath: stage.source.filePath, generationId: stage.generationId });

    const query = new Array<number>(64).fill(0);
    expect(await vectorStore.search(query, 10)).toHaveLength(1);

    // C only prevents the destructive delete; this does not assert a full No-op.
    await stageStructuredFile(coordinator, stage);
    await coordinator.activateFile({ filePath: stage.source.filePath, generationId: stage.generationId });

    const results = await vectorStore.search(query, 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.symbolId).toBe(stage.symbolId);
    expect(results[0]?.generationId).toBe(stage.generationId);
    expect(await metadataStore.resolveFile(stage.source.filePath)).toEqual({
      kind: 'active',
      generationId: stage.generationId,
    });
  });

  it('removes the previous generation when activating a different generation', async () => {
    const first = createStructuredStage('src/change.ts', 'export function before() { return 1; }', 'before');
    await stageStructuredFile(coordinator, first);
    await coordinator.activateFile({ filePath: first.source.filePath, generationId: first.generationId });

    const second = createStructuredStage('src/change.ts', 'export function after() { return 2; }', 'after');
    expect(second.generationId).not.toBe(first.generationId);
    await stageStructuredFile(coordinator, second);
    await coordinator.activateFile({ filePath: second.source.filePath, generationId: second.generationId });

    const results = await vectorStore.search(new Array<number>(64).fill(0), 10);
    expect(results).toHaveLength(1);
    expect(results[0]?.chunk.symbolId).toBe(second.symbolId);
    expect(results[0]?.generationId).toBe(second.generationId);
    expect(await metadataStore.resolveFile(second.source.filePath)).toEqual({
      kind: 'active',
      generationId: second.generationId,
    });
  });

  it('does not leave a pending generation when embedding counts mismatch', async () => {
    const stage = createStructuredStage('src/mismatch.ts', 'export function mismatch() { return 1; }', 'mismatch');

    await expect(coordinator.stageFile({
      source: stage.source,
      generationId: stage.generationId,
      contentHash: stage.contentHash,
      fileCompleteness: 'complete',
      declarations: [stage.symbol],
      imports: [],
      chunks: [{
        id: 'mismatch-chunk',
        filePath: stage.source.filePath,
        content: stage.source.text,
        language: stage.source.language,
        symbolKind: 'function',
        startLine: 1,
        endLine: 1,
        hash: stage.contentHash,
        symbolId: stage.symbolId,
        generationId: stage.generationId,
      }],
      embeddings: [],
    })).rejects.toThrow('embeddings length mismatch');

    await expect(metadataStore.resolveFile(stage.source.filePath)).resolves.toEqual({ kind: 'missing' });
    expect(await metadataStore.getStructuredCounts()).toMatchObject({
      pendingFiles: 0,
      pendingSymbols: 0,
    });
  });

  it('keeps the active catalog and vectors visible when Lance staging fails mid-batch', async () => {
    const first = createStructuredStage('src/a.ts', 'export function a() { return 1; }', 'a');
    await stageStructuredFile(coordinator, first);
    await coordinator.activateFile({ filePath: 'src/a.ts', generationId: first.generationId });

    const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));
    const resultsBefore = await vectorStore.search(embedding, 10);
    expect(resultsBefore).toHaveLength(1);

    vectorStore.failOnBatch(2);
    const second = createStructuredStage('src/a.ts', 'export function replacement() { return 2; }', 'replacement');
    await expect(stageStructuredFile(coordinator, second)).rejects.toThrow();

    const resultsAfter = await vectorStore.search(embedding, 10);
    expect(resultsAfter).toHaveLength(1);
    expect(resultsAfter[0]?.chunk.symbolId).toBe(first.symbolId);
    expect(await metadataStore.getStructuredCounts()).toMatchObject({
      pendingFiles: 0,
      pendingSymbols: 0,
    });
    expect(await metadataStore.resolveFile('src/a.ts')).toEqual({
      kind: 'active',
      generationId: first.generationId,
    });
  });

  it('keeps omitted files and clears pending payloads when full rebuild staging fails', async () => {
    const existing = createStructuredStage('src/existing.ts', 'export function existing() { return 1; }', 'existing');
    await stageStructuredFile(coordinator, existing);
    await coordinator.activateFile({ filePath: existing.source.filePath, generationId: existing.generationId });

    vectorStore.failOnBatch(2);
    const replacement = createStructuredStage('src/replacement.ts', 'export function replacement() { return 2; }', 'replacement');
    await expect(runStructuredFullRebuild(coordinator, replacement)).rejects.toThrow();

    expect(await metadataStore.resolveFile(existing.source.filePath)).toEqual({
      kind: 'active',
      generationId: existing.generationId,
    });
    expect(await metadataStore.resolveFile(replacement.source.filePath)).toEqual({ kind: 'missing' });
    expect(await vectorStore.search(new Array<number>(64).fill(0), 10)).toHaveLength(1);
  });

  it('returns index_incomplete for a pending file instead of stale source', async () => {
    const stage = createStructuredStage('src/a.ts', 'export function a() { return 1; }', 'a');
    await stageStructuredFile(coordinator, stage);

    const resolved = await metadataStore.resolveFile('src/a.ts');
    expect(resolved.kind).toBe('pending');
  });

  it('deletes structured file rows and catalog entries on delete', async () => {
    const stage = createStructuredStage('src/a.ts', 'export function a() { return 1; }', 'a');
    await stageStructuredFile(coordinator, stage);
    await coordinator.activateFile({ filePath: 'src/a.ts', generationId: stage.generationId });
    expect(await vectorStore.search(new Array<number>(64).fill(0), 10)).toHaveLength(1);

    await coordinator.deleteFile({ filePath: 'src/a.ts' });

    const resolved = await metadataStore.resolveFile('src/a.ts');
    expect(resolved.kind).toBe('missing');
    const symbolResolved = await metadataStore.resolveSymbol(stage.symbolId);
    expect(symbolResolved.kind).toBe('tombstone');
    expect(await vectorStore.search(new Array<number>(64).fill(0), 10)).toHaveLength(0);
  });
});
