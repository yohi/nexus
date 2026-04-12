import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { LanceVectorStore } from '../../../src/storage/vector-store.js';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

describe('LanceVectorStore - resetForTest validation', () => {
  let store: LanceVectorStore;
  let dbPath: string;

  beforeEach(async () => {
    dbPath = join(tmpdir(), `nexus-test-reset-${randomUUID()}`);
    store = new LanceVectorStore({
      dbPath,
      dimensions: 3
    });
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    try {
      await rm(dbPath, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('resetForTest() should reset totalFiles to 0', async () => {
    // 1. Add some chunks to increase totalFiles
    await store.upsertChunks([
      {
        id: '1',
        filePath: 'test1.ts',
        content: 'content1',
        language: 'typescript',
        symbolKind: 'function',
        startLine: 1,
        endLine: 2,
        hash: 'hash1'
      },
      {
        id: '2',
        filePath: 'test2.ts',
        content: 'content2',
        language: 'typescript',
        symbolKind: 'function',
        startLine: 1,
        endLine: 2,
        hash: 'hash2'
      }
    ], [
      [0.1, 0.2, 0.3],
      [0.4, 0.5, 0.6]
    ]);

    let stats = await store.getStats();
    expect(stats.totalFiles).toBe(2);
    expect(stats.totalChunks).toBe(2);

    // 2. Perform reset
    await store.resetForTest();

    // 3. Verify totalFiles is reset in memory
    stats = await store.getStats();
    expect(stats.totalFiles).toBe(0, 'totalFiles should be 0 after resetForTest (in-memory)');
    expect(stats.totalChunks).toBe(0);
    expect(stats.fragmentationRatio).toBe(0);

    // 4. Verify persistence: close and re-open
    await store.close();
    const store2 = new LanceVectorStore({
      dbPath,
      dimensions: 3
    });
    await store2.initialize();
    
    stats = await store2.getStats();
    expect(stats.totalFiles).toBe(0, 'totalFiles should remain 0 after re-opening (persisted)');
    expect(stats.totalChunks).toBe(0);
    await store2.close();
  });
});
