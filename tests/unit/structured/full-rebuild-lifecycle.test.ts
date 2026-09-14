import { describe, expect, it, beforeEach } from 'vitest';
import {
  createStructuredCoordinatorFixture,
  createStructuredStage,
  runStructuredFullRebuild,
} from '../../shared/structured-test-helpers.js';
import type { StructuredIndexCoordinator } from '../../../src/indexer/structured-index-coordinator.js';
import type { InMemoryMetadataStore } from '../storage/in-memory-metadata-store.js';
import type { InMemoryVectorStore } from '../storage/in-memory-vector-store.js';

describe('full rebuild lifecycle', () => {
  let metadataStore: InMemoryMetadataStore;
  let vectorStore: InMemoryVectorStore;
  let coordinator: StructuredIndexCoordinator;

  beforeEach(async () => {
    const fixture = await createStructuredCoordinatorFixture();
    metadataStore = fixture.metadataStore;
    vectorStore = fixture.vectorStore;
    coordinator = fixture.coordinator;
  });

  it('keeps a completed legacy index searchable through old tools but gates new tools', async () => {
    const state = await metadataStore.getStructuredIndexState();
    expect(state.schemaVersion).toBeNull();
    expect(state.reindexRequired).toBe(true);
    expect(await metadataStore.resolveFile('src/auth.ts')).toMatchObject({
      kind: 'missing',
    });
  });

  it('rolls back swapped structured vectors when final catalog activation fails', async () => {
    const stage = createStructuredStage('src/a.ts', 'export function a() { return 1; }', 'a', {
      startByte: 0,
      endByte: 30,
    });
    const embedding = Array.from({ length: 64 }, (_, i) => (i === 0 ? 1 : 0));

    metadataStore.activateFullRebuild = async () => {
      throw new Error('final activation failed');
    };

    await expect(runStructuredFullRebuild(coordinator, stage)).rejects.toThrow('final activation failed');

    const state = await metadataStore.getStructuredIndexState();
    expect(state.rebuildState).toBe('failed');
    expect(await vectorStore.search(embedding, 10)).toHaveLength(0);
    expect(await metadataStore.resolveFile(stage.source.filePath)).toEqual({ kind: 'missing' });
  });
});
